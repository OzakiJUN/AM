// Package app wires all modules together. Used by cmd/am-server and by the
// end-to-end tests, so both run exactly the same server.
package app

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/OzakiJUN/am/server/internal/account"
	"github.com/OzakiJUN/am/server/internal/config"
	"github.com/OzakiJUN/am/server/internal/conv"
	"github.com/OzakiJUN/am/server/internal/gateway"
	"github.com/OzakiJUN/am/server/internal/httpapi"
	"github.com/OzakiJUN/am/server/internal/idgen"
	"github.com/OzakiJUN/am/server/internal/message"
	"github.com/OzakiJUN/am/server/internal/store"
)

type App struct {
	Store   *store.Store
	Hub     *gateway.Hub
	Account *account.Service
	Handler http.Handler
}

// New opens the database, applies migrations and builds the HTTP handler.
func New(ctx context.Context, cfg *config.Config, log *slog.Logger) (*App, error) {
	st, err := store.Open(ctx, cfg.Database.URL, cfg.Database.MaxConns)
	if err != nil {
		return nil, err
	}
	applied, err := st.Migrate(ctx)
	if err != nil {
		st.Close()
		return nil, err
	}
	for _, m := range applied {
		log.Info("applied migration", "file", m)
	}

	ids := idgen.New(cfg.Server.NodeID)
	hub := gateway.NewHub(log)
	acct := account.New(st, ids, cfg.Invites, hub)
	cs := conv.New(st, ids, hub)
	ms := message.New(st, ids, hub, cfg.Limits)

	mux := http.NewServeMux()
	httpapi.New(acct, cs, cfg.Limits.LoginAttemptsPerMinute, log).Register(mux)
	mux.Handle("GET /ws", gateway.New(hub, acct, cs, ms, log))

	return &App{Store: st, Hub: hub, Account: acct, Handler: mux}, nil
}

func (a *App) Close() { a.Store.Close() }
