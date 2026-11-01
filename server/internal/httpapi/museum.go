package httpapi

import (
	"net/http"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/apperr"
	"github.com/OzakiJUN/am/server/internal/museum"
	"github.com/OzakiJUN/am/server/internal/store"
)

// Channel museums (docs/design.md §13 博物馆).

// SetMuseum connects the museum service.
func (a *API) SetMuseum(m *museum.Service) { a.museum = m }

func (a *API) registerMuseum(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/conversations/{id}/museum", a.authed(a.museumView))
	mux.HandleFunc("POST /api/v1/conversations/{id}/museum/hang", a.authed(a.museumHang))
	mux.HandleFunc("POST /api/v1/conversations/{id}/museum/remove", a.authed(a.museumAct(false)))
	mux.HandleFunc("POST /api/v1/conversations/{id}/museum/swap", a.authed(a.museumAct(true)))
	mux.HandleFunc("POST /api/v1/museum/arts/{id}/like", a.authed(a.museumLike(true)))
	mux.HandleFunc("DELETE /api/v1/museum/arts/{id}/like", a.authed(a.museumLike(false)))
	mux.HandleFunc("POST /api/v1/museum/votes/{id}", a.authed(a.museumVote))
}

func (a *API) museumView(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	id, ok := pathID(r, "id")
	if !ok {
		a.fail(w, apperr.ErrBadRequest)
		return
	}
	v, err := a.museum.View(r.Context(), me, id)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, v)
}

func (a *API) museumHang(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	id, ok := pathID(r, "id")
	req := &amv1.MuseumHangRequest{}
	if !ok {
		a.fail(w, apperr.ErrBadRequest)
		return
	}
	if !a.read(w, r, req) {
		return
	}
	res, err := a.museum.Hang(r.Context(), me, id, req)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, res)
}

func (a *API) museumAct(swap bool) authedHandler {
	return func(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
		id, ok := pathID(r, "id")
		req := &amv1.MuseumActRequest{}
		if !ok {
			a.fail(w, apperr.ErrBadRequest)
			return
		}
		if !a.read(w, r, req) {
			return
		}
		var res *amv1.MuseumResult
		var err error
		if swap {
			res, err = a.museum.Swap(r.Context(), me, id, int(req.GetA()), int(req.GetB()))
		} else {
			res, err = a.museum.Remove(r.Context(), me, id, req.GetArtId())
		}
		if err != nil {
			a.fail(w, err)
			return
		}
		a.ok(w, res)
	}
}

func (a *API) museumLike(on bool) authedHandler {
	return func(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
		id, ok := pathID(r, "id")
		if !ok {
			a.fail(w, apperr.ErrBadRequest)
			return
		}
		v, err := a.museum.Like(r.Context(), me, id, on)
		if err != nil {
			a.fail(w, err)
			return
		}
		a.ok(w, v)
	}
}

func (a *API) museumVote(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	id, ok := pathID(r, "id")
	req := &amv1.MuseumVoteRequest{}
	if !ok {
		a.fail(w, apperr.ErrBadRequest)
		return
	}
	if !a.read(w, r, req) {
		return
	}
	v, err := a.museum.Vote(r.Context(), me, id, req.GetAgree())
	if err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, v)
}
