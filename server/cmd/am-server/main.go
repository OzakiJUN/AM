// am-server is the AM chat server.
//
//	am-server [-config config.toml]            run the server
//	am-server setup-db [-config config.toml]   create the database user and database
//	am-server version
package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
	"golang.org/x/term"

	"github.com/OzakiJUN/am/server/internal/app"
	"github.com/OzakiJUN/am/server/internal/config"
	"github.com/OzakiJUN/am/server/internal/tlsutil"
)

// Set at build time with -ldflags "-X main.version=...".
var version = "dev"

func main() {
	if len(os.Args) > 1 && !strings.HasPrefix(os.Args[1], "-") {
		cmd, args := os.Args[1], os.Args[2:]
		var err error
		switch cmd {
		case "setup-db":
			err = setupDB(args)
		case "version":
			fmt.Println(version)
		default:
			err = fmt.Errorf("unknown command %q (use: setup-db, version)", cmd)
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, "error:", err)
			os.Exit(1)
		}
		return
	}
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func loadConfig(path string) (*config.Config, error) {
	cfg, created, err := config.Load(path)
	if err != nil {
		return nil, err
	}
	if created {
		abs, _ := filepath.Abs(path)
		fmt.Printf("Created %s with default settings (random database password).\n", abs)
		fmt.Println("Add your public IP to tls.hosts in that file before clients connect from outside.")
	}
	return cfg, nil
}

func newLogger(level string) *slog.Logger {
	var l slog.Level
	if err := l.UnmarshalText([]byte(level)); err != nil {
		l = slog.LevelInfo
	}
	return slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: l}))
}

func run(args []string) error {
	fs := flag.NewFlagSet("am-server", flag.ExitOnError)
	cfgPath := fs.String("config", "config.toml", "path to config file")
	_ = fs.Parse(args)

	cfg, err := loadConfig(*cfgPath)
	if err != nil {
		return err
	}
	log := newLogger(cfg.Log.Level)
	log.Info("starting am-server", "version", version)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	a, err := app.New(ctx, cfg, log)
	if err != nil {
		return fmt.Errorf("%w\n(if the database does not exist yet, run: am-server setup-db)", err)
	}
	defer a.Close()

	if code, err := a.Account.EnsureBootstrapInvite(ctx); err != nil {
		return err
	} else if code != "" {
		path := filepath.Join(cfg.Server.DataDir, "bootstrap_invite.txt")
		_ = os.MkdirAll(cfg.Server.DataDir, 0o700)
		_ = os.WriteFile(path, []byte(code+"\n"), 0o600)
		log.Info("no users yet - register the first (admin) account with this invite code",
			"invite", code, "also_saved_to", path)
	}

	srv := &http.Server{
		Addr:              cfg.Server.Listen,
		Handler:           a.Handler,
		ReadHeaderTimeout: 10 * time.Second,
	}
	switch cfg.TLS.Mode {
	case "self_signed":
		cert, err := tlsutil.LoadOrCreateSelfSigned(filepath.Join(cfg.Server.DataDir, "tls"), cfg.TLS.Hosts)
		if err != nil {
			return fmt.Errorf("tls certificate: %w", err)
		}
		srv.TLSConfig = &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}
		log.Info("TLS self-signed certificate - put this fingerprint into client configs",
			"fingerprint", tlsutil.Fingerprint(cert))
	case "files":
		cert, err := tls.LoadX509KeyPair(cfg.TLS.CertFile, cfg.TLS.KeyFile)
		if err != nil {
			return fmt.Errorf("tls certificate: %w", err)
		}
		srv.TLSConfig = &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}
	}

	errCh := make(chan error, 1)
	go func() {
		log.Info("listening", "addr", cfg.Server.Listen, "tls", cfg.TLS.Mode)
		if srv.TLSConfig != nil {
			errCh <- srv.ListenAndServeTLS("", "")
		} else {
			errCh <- srv.ListenAndServe()
		}
	}()

	select {
	case err := <-errCh:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
		log.Info("shutting down")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}
	return nil
}

// setupDB creates the database role and database named in database.url,
// using a PostgreSQL superuser account.
func setupDB(args []string) error {
	fs := flag.NewFlagSet("setup-db", flag.ExitOnError)
	cfgPath := fs.String("config", "config.toml", "path to config file")
	adminUser := fs.String("admin-user", "postgres", "PostgreSQL superuser name")
	adminPass := fs.String("admin-password", "", "superuser password (asked interactively if empty; PGPASSWORD also works)")
	_ = fs.Parse(args)

	cfg, err := loadConfig(*cfgPath)
	if err != nil {
		return err
	}
	target, err := pgx.ParseConfig(cfg.Database.URL)
	if err != nil {
		return fmt.Errorf("database.url: %w", err)
	}
	if target.User == "" || target.Database == "" {
		return errors.New("database.url must include a user and a database name")
	}

	pass := *adminPass
	if pass == "" {
		pass = os.Getenv("PGPASSWORD")
	}
	if pass == "" {
		fmt.Printf("Password for PostgreSQL user %q (set when you installed PostgreSQL): ", *adminUser)
		pass, err = readPassword()
		fmt.Println()
		if err != nil {
			return err
		}
	}

	adminCfg := target.Copy()
	adminCfg.User = *adminUser
	adminCfg.Password = pass
	adminCfg.Database = "postgres"
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	conn, err := pgx.ConnectConfig(ctx, adminCfg)
	if err != nil {
		return fmt.Errorf("connect as %s: %w", *adminUser, err)
	}
	defer conn.Close(ctx)

	role := pgx.Identifier{target.User}.Sanitize()
	pwLiteral := "'" + strings.ReplaceAll(target.Password, "'", "''") + "'"

	var exists bool
	if err := conn.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$1)`, target.User).Scan(&exists); err != nil {
		return err
	}
	if exists {
		if _, err := conn.Exec(ctx, "ALTER ROLE "+role+" LOGIN PASSWORD "+pwLiteral); err != nil {
			return err
		}
		fmt.Printf("User %s already existed; password updated to match config.\n", target.User)
	} else {
		if _, err := conn.Exec(ctx, "CREATE ROLE "+role+" LOGIN PASSWORD "+pwLiteral); err != nil {
			return err
		}
		fmt.Printf("Created user %s.\n", target.User)
	}

	if err := conn.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=$1)`, target.Database).Scan(&exists); err != nil {
		return err
	}
	if exists {
		fmt.Printf("Database %s already exists.\n", target.Database)
	} else {
		db := pgx.Identifier{target.Database}.Sanitize()
		if _, err := conn.Exec(ctx, "CREATE DATABASE "+db+" OWNER "+role+" ENCODING 'UTF8' TEMPLATE template0"); err != nil {
			return err
		}
		fmt.Printf("Created database %s.\n", target.Database)
	}
	fmt.Println("Database ready. Now start the server.")
	return nil
}

func readPassword() (string, error) {
	fd := int(os.Stdin.Fd())
	if term.IsTerminal(fd) {
		b, err := term.ReadPassword(fd)
		return string(b), err
	}
	line, err := bufio.NewReader(os.Stdin).ReadString('\n')
	return strings.TrimRight(line, "\r\n"), err
}
