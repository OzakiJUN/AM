package admin

import (
	"net/http"
	"strings"

	"github.com/OzakiJUN/am/server/internal/account"
	"github.com/OzakiJUN/am/server/internal/app"
)

// The shared sticker library (docs/design.md §11): browse, hide / show,
// delete (kept as evidence, optionally blocked), take tags off. Every
// change is audited (actor 0 = the panel).

const stickerPage = 48

func (h *handler) listStickers(w http.ResponseWriter, r *http.Request) {
	a, _, okk := h.running(w)
	if !okk {
		return
	}
	qs := r.URL.Query()
	limit, offset := page(r, stickerPage)
	items, total, err := a.Stickers.AdminList(r.Context(), strings.TrimSpace(qs.Get("q")), qs.Get("status"), qs.Get("sort") == "new", limit, offset)
	if err != nil {
		h.fail(w, err)
		return
	}
	out := []map[string]any{}
	for _, it := range items {
		out = append(out, map[string]any{
			"id": id64(it.ID), "media_id": id64(it.MediaID), "uploader_id": id64(it.UploaderID), "uploader_name": it.UploaderName,
			"collectors": it.Collectors, "tags": it.Tags, "created_at": it.CreatedAt,
			"hidden_at": it.HiddenAt, "deleted_at": it.DeletedAt, "delete_reason": it.DeleteReason, "purge_after": it.PurgeAfter,
			"width": it.Width, "height": it.Height,
		})
	}
	writeJSON(w, map[string]any{"items": out, "total": total, "page_size": limit})
}

func (h *handler) hideSticker(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Hidden bool `json:"hidden"`
	}
	h.stickerAction(w, r, &req, func(a *app.App, id int64) error {
		return a.Stickers.SetHidden(r.Context(), account.PanelActor, id, req.Hidden)
	})
}

func (h *handler) deleteSticker(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Reason string `json:"reason"`
		Block  bool   `json:"block"`
	}
	h.stickerAction(w, r, &req, func(a *app.App, id int64) error {
		return a.Stickers.AdminDelete(r.Context(), account.PanelActor, id, req.Reason, req.Block)
	})
}

func (h *handler) removeStickerTag(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Tag string `json:"tag"`
	}
	h.stickerAction(w, r, &req, func(a *app.App, id int64) error {
		return a.Stickers.AdminRemoveTag(r.Context(), account.PanelActor, id, req.Tag)
	})
}

func (h *handler) stickerAction(w http.ResponseWriter, r *http.Request, req any, fn func(a *app.App, id int64) error) {
	a, _, okk := h.running(w)
	if !okk {
		return
	}
	id, okID := pathID(r)
	if !okID {
		writeErr(w, http.StatusBadRequest, "bad_request", "bad sticker id")
		return
	}
	if err := readJSON(r, req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if err := fn(a, id); err != nil {
		h.fail(w, err)
		return
	}
	writeJSON(w, ok())
}
