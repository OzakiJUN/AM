package store

import (
	"context"
)

type User struct {
	ID           int64
	Username     string
	DisplayName  string
	Avatar       string
	PasswordHash string
	AccountType  int16
	OwnerID      int64
	IsSiteAdmin  bool
	Banned       bool
	CreatedAt    int64
}

const userCols = `id, username, display_name, avatar, COALESCE(password_hash, ''), account_type,
	COALESCE(owner_id, 0), is_site_admin, banned, created_at`

func scanUser(row interface{ Scan(...any) error }) (*User, error) {
	u := &User{}
	err := row.Scan(&u.ID, &u.Username, &u.DisplayName, &u.Avatar, &u.PasswordHash, &u.AccountType,
		&u.OwnerID, &u.IsSiteAdmin, &u.Banned, &u.CreatedAt)
	if err != nil {
		return nil, notFound(err)
	}
	return u, nil
}

func (q *Queries) CreateUser(ctx context.Context, u *User) error {
	var owner any
	if u.OwnerID != 0 {
		owner = u.OwnerID
	}
	var pw any
	if u.PasswordHash != "" {
		pw = u.PasswordHash
	}
	_, err := q.db.Exec(ctx, `INSERT INTO users (id, username, display_name, avatar, password_hash,
		account_type, owner_id, is_site_admin, banned, created_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
		u.ID, u.Username, u.DisplayName, u.Avatar, pw, u.AccountType, owner, u.IsSiteAdmin, u.Banned, u.CreatedAt)
	return err
}

func (q *Queries) GetUser(ctx context.Context, id int64) (*User, error) {
	return scanUser(q.db.QueryRow(ctx, `SELECT `+userCols+` FROM users WHERE id=$1`, id))
}

func (q *Queries) GetUserByUsername(ctx context.Context, username string) (*User, error) {
	return scanUser(q.db.QueryRow(ctx, `SELECT `+userCols+` FROM users WHERE lower(username)=lower($1)`, username))
}

// GetUsers returns the users with the given ids, keyed by id.
func (q *Queries) GetUsers(ctx context.Context, ids []int64) (map[int64]*User, error) {
	out := make(map[int64]*User, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := q.db.Query(ctx, `SELECT `+userCols+` FROM users WHERE id = ANY($1)`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, err
		}
		out[u.ID] = u
	}
	return out, rows.Err()
}

func (q *Queries) CountUsers(ctx context.Context) (int64, error) {
	var n int64
	err := q.db.QueryRow(ctx, `SELECT count(*) FROM users`).Scan(&n)
	return n, err
}
