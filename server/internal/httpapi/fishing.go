package httpapi

import (
	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/apperr"
	"github.com/OzakiJUN/am/server/internal/store"
	"net/http"
)

func (a *API) registerFishing(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/fishing/rules", a.authed(func(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
		a.ok(w, a.games.FishingRules())
	}))
	mux.HandleFunc("GET /api/v1/fishing/me", a.authed(func(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
		out, err := a.games.FishingAccount(r.Context(), me)
		a.reply(w, out, err)
	}))
	mux.HandleFunc("POST /api/v1/fishing/me", a.authed(func(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
		req := &amv1.FishingActionRequest{}
		if !a.read(w, r, req) {
			return
		}
		out, err := a.games.FishingAction(r.Context(), me, req)
		a.reply(w, out, err)
	}))
	mux.HandleFunc("GET /api/v1/users/{id}/fishing-showcase", a.authed(func(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
		id, ok := pathID(r, "id")
		if !ok {
			a.fail(w, apperr.ErrBadRequest)
			return
		}
		if _, err := a.games.FishingAccountUser(r.Context(), id); err != nil {
			a.fail(w, err)
			return
		}
		out, err := a.games.FishingShowcase(r.Context(), id)
		a.reply(w, out, err)
	}))
}
