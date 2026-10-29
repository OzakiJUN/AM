package e2e

import (
	"context"
	"io"
	"log/slog"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/sdk/go/amclient"
	"github.com/OzakiJUN/am/server/internal/app"
	"github.com/OzakiJUN/am/server/internal/config"
)

// forEachDB runs fn once per available database.
func forEachDB(t *testing.T, fn func(t *testing.T, a *app.App, base string)) {
	t.Run("sqlite", func(t *testing.T) {
		a, base := setup(t, "sqlite")
		fn(t, a, base)
	})
	t.Run("postgres", func(t *testing.T) {
		if os.Getenv("AM_TEST_DATABASE_URL") == "" {
			t.Skip("AM_TEST_DATABASE_URL not set")
		}
		a, base := setup(t, "postgres")
		fn(t, a, base)
	})
}

func setup(t *testing.T, driver string) (*app.App, string) {
	t.Helper()
	ctx := context.Background()
	dir := t.TempDir()
	cfg, _, err := config.Load(filepath.Join(dir, "config.toml")) // creates the default file
	if err != nil {
		t.Fatal(err)
	}
	cfg.Server.DataDir = filepath.Join(dir, "data")
	cfg.Database.Driver = driver
	cfg.TLS.Mode = "off"
	cfg.Limits.LoginAttemptsPerMinute = 0
	if driver == "postgres" {
		url := os.Getenv("AM_TEST_DATABASE_URL")
		conn, err := pgx.Connect(ctx, url)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := conn.Exec(ctx, `DROP SCHEMA public CASCADE; CREATE SCHEMA public;`); err != nil {
			t.Fatal(err)
		}
		conn.Close(ctx)
		cfg.Database.URL = url
	}

	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	a, err := app.New(ctx, cfg, log)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(a.Handler)
	t.Cleanup(func() {
		srv.Close()
		a.Close()
	})
	return a, srv.URL
}

func ctxT(t *testing.T) context.Context {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	t.Cleanup(cancel)
	return ctx
}

// must panics on error; inside a test a panic is reported as a failure
// with the line number. (Go cannot spread f() into must(t, f()).)
func must[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}

func wantCode(t *testing.T, err error, code string) {
	t.Helper()
	if !amclient.IsCode(err, code) {
		t.Fatalf("want error %q, got %v", code, err)
	}
}

// waitPush waits for a push matching pred.
func waitPush(t *testing.T, c *amclient.Conn, what string, pred func(*amv1.ServerFrame) bool) *amv1.ServerFrame {
	t.Helper()
	timeout := time.After(5 * time.Second)
	for {
		select {
		case f, ok := <-c.Pushes:
			if !ok {
				t.Fatalf("connection closed while waiting for %s", what)
			}
			if pred(f) {
				return f
			}
		case <-timeout:
			t.Fatalf("timed out waiting for %s", what)
		}
	}
}

// user is a registered test account.
type user struct {
	cli *amclient.Client
	me  *amv1.User
}

// newServerUsers registers an admin (with the bootstrap code) and more users
// invited by the admin. All users are made friends with each other.
func newServerUsers(t *testing.T, a *app.App, base string, names ...string) []*user {
	t.Helper()
	ctx := ctxT(t)
	code := must(a.Account.EnsureBootstrapInvite(ctx))
	var users []*user
	for i, name := range names {
		c := amclient.New(base, nil)
		if i > 0 {
			code = must(users[0].cli.CreateInvite(ctx)).Code
		}
		resp := must(c.Register(ctx, &amv1.RegisterRequest{InviteCode: code, Username: name, Password: "password-" + name, DeviceName: "test"}))
		users = append(users, &user{cli: c, me: resp.Me})
	}
	for i := range users {
		for j := i + 1; j < len(users); j++ {
			if err := users[i].cli.RequestFriend(ctx, users[j].me.Username); err != nil {
				t.Fatal(err)
			}
			if err := users[j].cli.AcceptFriend(ctx, users[i].me.Id); err != nil {
				t.Fatal(err)
			}
		}
	}
	return users
}
