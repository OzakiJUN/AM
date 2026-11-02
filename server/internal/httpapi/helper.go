package httpapi

import (
	"net/http"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/apperr"
	"github.com/OzakiJUN/am/server/internal/helper"
	"github.com/OzakiJUN/am/server/internal/store"
)

// The server's built-in bot (docs/design.md §10 内置 bot).

// SetHelper connects the built-in bot (its commands go into ServerInfo).
func (a *API) SetHelper(h *helper.Service) { a.helper = h }

func (a *API) registerHelper(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/helper/commands", a.authed(a.helperCommands))
	mux.HandleFunc("POST /api/v1/helper/run", a.authed(a.helperRun))
}

func (a *API) helperCommands(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	out := &amv1.HelperCommandsResponse{}
	if a.helper != nil {
		for _, e := range a.helper.Entries() {
			out.Commands = append(out.Commands, &amv1.HelperCommand{Name: e.Name, Aliases: e.Aliases, Group: e.Group, Usage: e.Usage, Help: e.Help, Own: e.Own})
		}
	}
	a.ok(w, out)
}

func (a *API) helperRun(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	req := &amv1.HelperRunRequest{}
	if !a.read(w, r, req) {
		return
	}
	if a.helper == nil || req.GetConvId() == 0 || req.GetText() == "" {
		a.fail(w, apperr.ErrBadRequest)
		return
	}
	ran, err := a.helper.RunFor(r.Context(), me, req.GetConvId(), req.GetReplyTo(), req.GetText(), req.GetShow())
	if err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, &amv1.HelperRunResponse{Texts: ran.Texts, MediaIds: ran.Media, Shown: ran.Shown})
}
