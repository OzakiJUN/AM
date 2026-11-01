package httpapi

import (
	"net/http"
	"strconv"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/apperr"
	"github.com/OzakiJUN/am/server/internal/store"
)

func (a *API) listStickers(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	out, err := a.stickers.List(r.Context(), me)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, out)
}

func (a *API) addSticker(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	req := &amv1.AddStickerRequest{}
	if !a.read(w, r, req) {
		return
	}
	var private *bool
	if req.Private != nil {
		v := req.GetPrivate()
		private = &v
	}
	out, err := a.stickers.Add(r.Context(), me, req.GetMediaId(), req.GetTags(), private)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, out)
}

func (a *API) updateSticker(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	id, ok := pathID(r, "id")
	if !ok {
		a.fail(w, apperr.ErrBadRequest)
		return
	}
	req := &amv1.UpdateStickerRequest{}
	if !a.read(w, r, req) {
		return
	}
	out, err := a.stickers.SetTags(r.Context(), me, id, req.GetTags())
	if err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, out)
}

func (a *API) deleteSticker(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	id, ok := pathID(r, "id")
	if !ok {
		a.fail(w, apperr.ErrBadRequest)
		return
	}
	if err := a.stickers.Delete(r.Context(), me, id); err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, &amv1.Empty{})
}

func (a *API) setStickerPrivate(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	id, ok := pathID(r, "id")
	if !ok {
		a.fail(w, apperr.ErrBadRequest)
		return
	}
	req := &amv1.SetStickerPrivateRequest{}
	if !a.read(w, r, req) {
		return
	}
	out, err := a.stickers.SetPrivate(r.Context(), me, id, req.GetPrivate())
	if err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, out)
}

func (a *API) listLibrary(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	qs := r.URL.Query()
	offset, _ := strconv.Atoi(qs.Get("offset"))
	out, err := a.stickers.Library(r.Context(), me, qs.Get("q"), qs.Get("sort") == "new", offset)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, out)
}

func (a *API) collectSticker(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	id, ok := pathID(r, "id")
	if !ok {
		a.fail(w, apperr.ErrBadRequest)
		return
	}
	out, err := a.stickers.Collect(r.Context(), me, id)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, out)
}

func (a *API) editLibraryTags(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	id, ok := pathID(r, "id")
	if !ok {
		a.fail(w, apperr.ErrBadRequest)
		return
	}
	req := &amv1.EditLibraryTagsRequest{}
	if !a.read(w, r, req) {
		return
	}
	out, err := a.stickers.EditTags(r.Context(), me, id, req.GetAdd(), req.GetRemove())
	if err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, out)
}

func (a *API) lookupStickers(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	req := &amv1.LookupStickersRequest{}
	if !a.read(w, r, req) {
		return
	}
	out, err := a.stickers.Lookup(r.Context(), req.GetSha256())
	if err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, out)
}

func (a *API) resolveMusic(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	req := &amv1.ResolveMusicRequest{}
	if !a.read(w, r, req) {
		return
	}
	out, err := a.music.Resolve(r.Context(), me, req.GetUrl())
	if err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, out)
}
