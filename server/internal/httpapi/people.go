package httpapi

import (
	"net/http"
	"strconv"
	"strings"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/apperr"
	"github.com/OzakiJUN/am/server/internal/store"
)

// GET /api/v1/users?query=&after=&limit=
func (a *API) listUsers(w http.ResponseWriter, r *http.Request, _ *store.Session, _ *store.User) {
	q := r.URL.Query()
	after, _ := strconv.ParseInt(q.Get("after"), 10, 64)
	limit, _ := strconv.Atoi(q.Get("limit"))
	resp, err := a.conv.ListUsers(r.Context(), strings.TrimSpace(q.Get("query")), after, limit)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, resp)
}

func (a *API) listBlocks(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	resp, err := a.conv.ListBlocks(r.Context(), me)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, resp)
}

// POST / DELETE /api/v1/blocks/{uid}
func (a *API) block(on bool) authedHandler {
	return func(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
		uid, ok := pathID(r, "uid")
		if !ok {
			a.fail(w, apperr.ErrBadRequest)
			return
		}
		var err error
		if on {
			err = a.conv.Block(r.Context(), me, uid)
		} else {
			err = a.conv.Unblock(r.Context(), me, uid)
		}
		if err != nil {
			a.fail(w, err)
			return
		}
		a.ok(w, &amv1.Empty{})
	}
}

func (a *API) listChannels(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	resp, err := a.conv.ListChannels(r.Context(), me)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, resp)
}

// POST /api/v1/channels/{id}/join
func (a *API) joinChannel(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	id, ok := pathID(r, "id")
	if !ok {
		a.fail(w, apperr.ErrBadRequest)
		return
	}
	c, err := a.conv.JoinChannel(r.Context(), me, id)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, c)
}
