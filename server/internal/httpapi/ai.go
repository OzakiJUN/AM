package httpapi

import (
	"context"
	"net/http"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/account"
	"github.com/OzakiJUN/am/server/internal/apperr"
	"github.com/OzakiJUN/am/server/internal/store"
)

// My AI accounts (docs/design.md §9, §10).

func (a *API) aiView(ctx context.Context, in *account.AIInfo) (*amv1.AIAccount, error) {
	u, err := a.conv.UserView(ctx, in.User)
	if err != nil {
		return nil, err
	}
	return &amv1.AIAccount{User: u, Settings: in.Settings, SettingsUpdatedAt: in.UpdatedAt}, nil
}

func (a *API) listAI(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	list, err := a.acct.ListAI(r.Context(), me)
	if err != nil {
		a.fail(w, err)
		return
	}
	out := &amv1.ListAIResponse{}
	for i := range list {
		v, err := a.aiView(r.Context(), &list[i])
		if err != nil {
			a.fail(w, err)
			return
		}
		out.Ais = append(out.Ais, v)
	}
	a.ok(w, out)
}

func (a *API) createAI(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	req := &amv1.CreateAIRequest{}
	if !a.read(w, r, req) {
		return
	}
	info, err := a.acct.CreateAI(r.Context(), me, req.GetDisplayName())
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

func (a *API) updateAI(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	id, ok := pathID(r, "id")
	req := &amv1.UpdateProfileRequest{}
	if !ok {
		a.fail(w, apperr.ErrBadRequest)
		return
	}
	if !a.read(w, r, req) {
		return
	}
	u, err := a.acct.UpdateAIProfile(r.Context(), me, id, req)
	if err != nil {
		a.fail(w, err)
		return
	}
	v, err := a.conv.UserView(r.Context(), u)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, v)
}

func (a *API) putAISettings(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	id, ok := pathID(r, "id")
	req := &amv1.PutAISettingsRequest{}
	if !ok {
		a.fail(w, apperr.ErrBadRequest)
		return
	}
	if !a.read(w, r, req) {
		return
	}
	info, err := a.acct.PutAISettings(r.Context(), me, id, req)
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

func (a *API) runAI(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	id, ok := pathID(r, "id")
	req := &amv1.RunAIRequest{}
	if !ok {
		a.fail(w, apperr.ErrBadRequest)
		return
	}
	if !a.read(w, r, req) {
		return
	}
	token, u, err := a.acct.RunAI(r.Context(), me, id, req.GetDeviceName(), account.Client{IP: clientIP(r)})
	if err != nil {
		a.fail(w, err)
		return
	}
	a.sessionResponse(w, r, token, u)
}

func (a *API) deleteAI(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	id, ok := pathID(r, "id")
	if !ok {
		a.fail(w, apperr.ErrBadRequest)
		return
	}
	if err := a.acct.DeleteAI(r.Context(), me, id); err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, &amv1.Empty{})
}
