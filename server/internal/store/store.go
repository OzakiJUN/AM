// Package store is the ONLY package that talks to the database.
// Other modules call its methods; none of them write SQL themselves.
//
// Two databases are supported behind the same methods:
//   - SQLite (default): a single file, nothing to install. Good for small
//     self-hosted servers.
//   - PostgreSQL: for larger servers.
//
// SQL in this package is written with "?" placeholders and portable syntax;
// rebind() turns "?" into "$1, $2, ..." for PostgreSQL. Anything that
// differs between the two (types in migrations, row locks) is handled here.
package store

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	_ "github.com/jackc/pgx/v5/stdlib" // "pgx" driver
	_ "modernc.org/sqlite"             // "sqlite" driver (pure Go, no cgo)
)

//go:embed migrations
var migrationFS embed.FS

// ErrNotFound is returned when a single-row lookup finds nothing.
var ErrNotFound = errors.New("store: not found")

type Dialect int

const (
	SQLite Dialect = iota
	Postgres
)

func (d Dialect) String() string {
	if d == Postgres {
		return "postgres"
	}
	return "sqlite"
}

// DBTX is satisfied by both *sql.DB and *sql.Tx.
type DBTX interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// Queries holds all query methods. Store.Queries runs on the connection
// pool; the *Queries passed to InTx runs inside the transaction.
//
// SQLite runs with a single connection, so every database call is
// serialized. Inside InTx, use only the *Queries you were given — calling
// the Store's own methods there would wait for the connection the
// transaction is holding.
type Queries struct {
	db DBTX
	d  Dialect
}

type Store struct {
	*Queries
	db *sql.DB
}

// Options selects and configures the database.
type Options struct {
	Driver     string // "sqlite" or "postgres"
	SQLitePath string // file path for SQLite
	URL        string // connection URL for PostgreSQL
	MaxConns   int    // PostgreSQL pool size
}

func Open(ctx context.Context, o Options) (*Store, error) {
	var (
		db  *sql.DB
		d   Dialect
		err error
	)
	switch o.Driver {
	case "", "sqlite":
		d = SQLite
		path := o.SQLitePath
		if path == "" {
			path = "am.db"
		}
		if dir := filepath.Dir(path); dir != "." {
			if err := mkdirAll(dir); err != nil {
				return nil, err
			}
		}
		dsn := "file:" + filepath.ToSlash(path) +
			"?_pragma=busy_timeout(10000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)&_pragma=synchronous(NORMAL)"
		db, err = sql.Open("sqlite", dsn)
		if err != nil {
			return nil, err
		}
		// One connection: SQLite allows one writer at a time anyway, and this
		// makes every transaction fully serialized (no "database is locked").
		db.SetMaxOpenConns(1)
	case "postgres":
		d = Postgres
		db, err = sql.Open("pgx", o.URL)
		if err != nil {
			return nil, fmt.Errorf("parse database url: %w", err)
		}
		if o.MaxConns > 0 {
			db.SetMaxOpenConns(o.MaxConns)
		}
	default:
		return nil, fmt.Errorf("unknown database driver %q (use sqlite or postgres)", o.Driver)
	}
	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := db.PingContext(pingCtx); err != nil {
		db.Close()
		return nil, fmt.Errorf("connect to database: %w", err)
	}
	return &Store{Queries: &Queries{db: db, d: d}, db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) Dialect() Dialect { return s.d }

// InTx runs fn in a transaction. It commits if fn returns nil.
func (s *Store) InTx(ctx context.Context, fn func(q *Queries) error) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck // no-op after commit
	if err := fn(&Queries{db: tx, d: s.d}); err != nil {
		return err
	}
	return tx.Commit()
}

// Migrate applies every migrations/<dialect>/NNNN_*.sql not applied yet.
func (s *Store) Migrate(ctx context.Context) (applied []string, err error) {
	if _, err := s.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
		version INTEGER PRIMARY KEY, applied_at BIGINT NOT NULL)`); err != nil {
		return nil, err
	}
	dir := "migrations/" + s.d.String()
	names, err := fs.Glob(migrationFS, dir+"/*.sql")
	if err != nil {
		return nil, err
	}
	sort.Strings(names)
	for _, name := range names {
		base := filepath.Base(name)
		version, err := strconv.Atoi(strings.SplitN(base, "_", 2)[0])
		if err != nil {
			return applied, fmt.Errorf("bad migration name %s", name)
		}
		var n int
		if err := s.queryRow(ctx, `SELECT count(*) FROM schema_migrations WHERE version=?`, version).Scan(&n); err != nil {
			return applied, err
		}
		if n > 0 {
			continue
		}
		body, err := migrationFS.ReadFile(name)
		if err != nil {
			return applied, err
		}
		err = s.InTx(ctx, func(q *Queries) error {
			for _, stmt := range splitStatements(string(body)) {
				if _, err := q.db.ExecContext(ctx, stmt); err != nil {
					return fmt.Errorf("migration %s: %w\n%s", base, err, stmt)
				}
			}
			_, err := q.exec(ctx, `INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`, version, time.Now().UnixMilli())
			return err
		})
		if err != nil {
			return applied, err
		}
		applied = append(applied, base)
	}
	return applied, nil
}

// splitStatements splits a migration file on ";" at line ends. Migrations
// must not contain ";" inside string literals or bodies.
func splitStatements(sqlText string) []string {
	var out []string
	var cur strings.Builder
	for _, line := range strings.Split(sqlText, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "--") {
			continue
		}
		cur.WriteString(line)
		cur.WriteString("\n")
		if strings.HasSuffix(trimmed, ";") {
			if s := strings.TrimSpace(cur.String()); s != "" {
				out = append(out, s)
			}
			cur.Reset()
		}
	}
	if s := strings.TrimSpace(cur.String()); s != "" {
		out = append(out, s)
	}
	return out
}

// ---- helpers used by the query files ----

// rebind converts "?" placeholders to "$n" for PostgreSQL.
func (q *Queries) rebind(query string) string {
	if q.d != Postgres {
		return query
	}
	var b strings.Builder
	n := 0
	inQuote := false
	for _, r := range query {
		switch {
		case r == '\'':
			inQuote = !inQuote
			b.WriteRune(r)
		case r == '?' && !inQuote:
			n++
			b.WriteString("$")
			b.WriteString(strconv.Itoa(n))
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

func (q *Queries) exec(ctx context.Context, query string, args ...any) (sql.Result, error) {
	return q.db.ExecContext(ctx, q.rebind(query), args...)
}

func (q *Queries) query(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	return q.db.QueryContext(ctx, q.rebind(query), args...)
}

func (q *Queries) queryRow(ctx context.Context, query string, args ...any) *sql.Row {
	return q.db.QueryRowContext(ctx, q.rebind(query), args...)
}

// forUpdate returns a row-lock clause where supported. SQLite does not need
// one: with a single connection, transactions never overlap.
func (q *Queries) forUpdate() string {
	if q.d == Postgres {
		return " FOR UPDATE"
	}
	return ""
}

// inList returns "(?, ?, ?)" for n items and the ids as []any.
func inList(ids []int64) (string, []any) {
	ph := make([]string, len(ids))
	args := make([]any, len(ids))
	for i, id := range ids {
		ph[i] = "?"
		args[i] = id
	}
	return "(" + strings.Join(ph, ",") + ")", args
}

// affected returns ErrNotFound when no row was changed.
func affected(res sql.Result, err error) error {
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// IsUniqueViolation reports whether err is a unique-constraint violation.
func IsUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code == "23505"
	}
	return strings.Contains(err.Error(), "UNIQUE constraint failed")
}

func notFound(err error) error {
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	return err
}

func nullInt(v int64) any {
	if v == 0 {
		return nil
	}
	return v
}

func nullStr(v string) any {
	if v == "" {
		return nil
	}
	return v
}
