package httpapi

import (
	"net/http"
	"strconv"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/apperr"
	"github.com/OzakiJUN/am/server/internal/profile"
	"github.com/OzakiJUN/am/server/internal/store"
)

// Profile pages (widgets) and their guestbooks.

func (a *API) registerProfiles(mux *http.ServeMux) {
	for _, base := range []string{"/api/v1/profiles/users/{id}", "/api/v1/profiles/server"} {
		mux.HandleFunc("GET "+base, a.authed(a.getProfile))
		mux.HandleFunc("PUT "+base, a.authed(a.saveProfile))
		mux.HandleFunc("GET "+base+"/guestbook/{widget}", a.authed(a.listGuestbook))
		mux.HandleFunc("POST "+base+"/guestbook/{widget}", a.authed(a.postGuestbook))
	}
	mux.HandleFunc("POST /api/v1/guestbook/{id}/hide", a.authed(a.hideGuestbook))
	mux.HandleFunc("POST /api/v1/guestbook/{id}/delete", a.authed(a.deleteGuestbook))
}

// owner reads which profile the path names.
func owner(w http.ResponseWriter, r *http.Request, a *API) (profile.Owner, bool) {
	if r.PathValue("id") == "" {
		return profile.ServerProfile, true
	}
	id, ok := pathID(r, "id")
	if !ok {
		a.fail(w, apperr.ErrBadRequest)
		return profile.Owner{}, false
	}
	return profile.UserProfile(id), true
}

func (a *API) getProfile(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	o, ok := owner(w, r, a)
	if !ok {
		return
	}
	v, err := a.profile.Get(r.Context(), me, o)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, v)
}

func (a *API) saveProfile(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	o, ok := owner(w, r, a)
	if !ok {
		return
	}
	req := &amv1.SaveProfileRequest{}
	if !a.read(w, r, req) {
		return
	}
	v, err := a.profile.Save(r.Context(), me, o, req)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, v)
}

func (a *API) listGuestbook(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	o, ok := owner(w, r, a)
	if !ok {
		return
	}
	before, _ := strconv.ParseInt(r.URL.Query().Get("before"), 10, 64)
	resp, err := a.profile.ListGuestbook(r.Context(), me, o, r.PathValue("widget"), before)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, resp)
}

func (a *API) postGuestbook(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	o, ok := owner(w, r, a)
	if !ok {
		return
	}
	req := &amv1.PostGuestbookRequest{}
	if !a.read(w, r, req) {
		return
	}
	e, err := a.profile.PostGuestbook(r.Context(), me, o, r.PathValue("widget"), req.GetText())
	if err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, e)
}

func (a *API) hideGuestbook(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	id, ok := pathID(r, "id")
	req := &amv1.HideGuestbookRequest{}
	if !ok || !a.read(w, r, req) {
		if !ok {
			a.fail(w, apperr.ErrBadRequest)
		}
		return
	}
	if err := a.profile.HideGuestbook(r.Context(), me, id, req.GetHidden()); err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, &amv1.Empty{})
}

func (a *API) deleteGuestbook(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	id, ok := pathID(r, "id")
	req := &amv1.DeleteGuestbookRequest{}
	if !ok || !a.read(w, r, req) {
		if !ok {
			a.fail(w, apperr.ErrBadRequest)
		}
		return
	}
	if err := a.profile.DeleteGuestbook(r.Context(), me, id, req.GetReason()); err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, &amv1.Empty{})
}
