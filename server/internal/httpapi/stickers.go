package httpapi

import (
	"net/http"

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
	out, err := a.stickers.Add(r.Context(), me, req.GetMediaId(), req.GetTags())
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
