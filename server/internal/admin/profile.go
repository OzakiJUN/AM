package admin

import (
	"encoding/base64"
	"encoding/json"
	"net/http"

	"github.com/OzakiJUN/am/server/internal/account"
)

// Server profile: description, icon and who may edit the profile's widgets.
// Changes apply at once (no restart): they live in the database.

func (h *handler) getServerProfile(w http.ResponseWriter, r *http.Request) {
	a, _, okk := h.running(w)
	if !okk {
		return
	}
	p, err := a.Account.ProfileSettings(r.Context())
	if err != nil {
		h.fail(w, err)
		return
	}
	_, version := a.Media.ServerIcon()
	writeJSON(w, map[string]any{"settings": p, "icon_version": version})
}

func (h *handler) putServerProfile(w http.ResponseWriter, r *http.Request) {
	a, _, okk := h.running(w)
	if !okk {
		return
	}
	var p account.ProfileSettings
	if err := readJSON(r, &p); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "bad body")
		return
	}
	if err := a.Account.SetProfileSettings(r.Context(), account.PanelActor, &p); err != nil {
		h.fail(w, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (h *handler) serverIcon(w http.ResponseWriter, r *http.Request) {
	a, _, okk := h.running(w)
	if !okk {
		return
	}
	f, _ := a.Media.ServerIcon()
	if f == nil {
		writeErr(w, http.StatusNotFound, "media_not_found", "还没有设置服务器图标")
		return
	}
	w.Header().Set("Content-Type", f.Mime)
	w.Header().Set("Cache-Control", "no-store")
	http.ServeFile(w, r, f.Path)
}

// putServerIcon takes {"data": "<base64 image>"}: panel writes are JSON only.
func (h *handler) putServerIcon(w http.ResponseWriter, r *http.Request) {
	a, _, okk := h.running(w)
	if !okk {
		return
	}
	r.Body = http.MaxBytesReader(nil, r.Body, 4<<20)
	var body struct {
		Data string `json:"data"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusRequestEntityTooLarge, "too_large", "图片太大了（最多 2 MB）")
		return
	}
	data, err := base64.StdEncoding.DecodeString(body.Data)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "bad image data")
		return
	}
	if err := a.Media.SetServerIcon(data); err != nil {
		h.fail(w, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (h *handler) deleteServerIcon(w http.ResponseWriter, r *http.Request) {
	a, _, okk := h.running(w)
	if !okk {
		return
	}
	if err := a.Media.RemoveServerIcon(); err != nil {
		h.fail(w, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}
