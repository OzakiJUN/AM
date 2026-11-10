package httpapi

import (
	"net/http"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/apperr"
	"github.com/OzakiJUN/am/server/internal/hosting"
	"github.com/OzakiJUN/am/server/internal/store"
)

// AIs hosted on the server (docs/design.md §10 托管): the owner asks / stops;
// the host client (logged in as the AI) reads and saves its own settings.

// SetHosting connects the hosting service (nil = hosting isn't available).
func (a *API) SetHosting(h *hosting.Service) { a.hosting = h }

func (a *API) registerHosting(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/v1/ai/{id}/host", a.authed(a.hostAI))
	mux.HandleFunc("DELETE /api/v1/ai/{id}/host", a.authed(a.unhostAI))
	mux.HandleFunc("GET /api/v1/me/ai", a.authed(a.myAI))
	mux.HandleFunc("PUT /api/v1/me/ai/settings", a.authed(a.putMyAISettings))
}

func (a *API) hostingView(v *hosting.View) *amv1.AIHosting {
	if v == nil {
		return nil
	}
	out := &amv1.AIHosting{Status: v.Status, RejectReason: v.RejectReason, RequestedAt: v.RequestedAt, State: v.State, Error: v.Error, Browser: a.hosting.Browser()}
	if v.Status == "approved" {
		out.WorkDir = a.hosting.WorkDir(v.AIID)
	}
	return out
}

func (a *API) hostAI(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	id, ok := pathID(r, "id")
	req := &amv1.HostAIRequest{}
	if !ok {
		a.fail(w, apperr.ErrBadRequest)
		return
	}
	if a.hosting == nil {
		a.fail(w, hosting.ErrHostingOff)
		return
	}
	if !a.read(w, r, req) {
		return
	}
	v, err := a.hosting.Request(r.Context(), me, id, req.GetProvidersJson())
	if err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, a.hostingView(v))
}

func (a *API) unhostAI(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	id, ok := pathID(r, "id")
	if !ok {
		a.fail(w, apperr.ErrBadRequest)
		return
	}
	if a.hosting == nil {
		a.fail(w, hosting.ErrHostingOff)
		return
	}
	if err := a.hosting.Cancel(r.Context(), me, id); err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, &amv1.Empty{})
}

// myAI: a bot / AI's own settings (its runner on the server reads them).
func (a *API) myAI(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	info, err := a.acct.MyAI(r.Context(), me)
	if err != nil {
		a.fail(w, err)
		return
	}
	v, err := a.aiView(r.Context(), info)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, v)
}

func (a *API) putMyAISettings(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	req := &amv1.PutAISettingsRequest{}
	if !a.read(w, r, req) {
		return
	}
	info, err := a.acct.PutMyAISettings(r.Context(), me, req)
	if err != nil {
		a.fail(w, err)
		return
	}
	v, err := a.aiView(r.Context(), info)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, v)
}
