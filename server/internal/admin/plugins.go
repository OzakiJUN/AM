package admin

import (
	"net/http"
	"unicode/utf8"

	"github.com/OzakiJUN/am/server/internal/account"
)

// AI plugins (docs/plugins.md): uploads wait here until a site admin reads
// the files and approves them; approved ones can be stopped again (reject).
// Every decision is audited (actor 0 = the panel).

const maxPanelFile = 512 << 10

func (h *handler) listPlugins(w http.ResponseWriter, r *http.Request) {
	a, _, okk := h.running(w)
	if !okk {
		return
	}
	if a.Plugins == nil {
		writeJSON(w, map[string]any{"enabled": false, "items": []any{}})
		return
	}
	list, err := a.Plugins.AdminList(r.Context(), r.URL.Query().Get("status"))
	if err != nil {
		h.fail(w, err)
		return
	}
	out := []map[string]any{}
	for _, v := range list {
		st := a.Plugins.Host().StatusOf(v.AIID)
		out = append(out, map[string]any{
			"id": id64(v.ID), "ai_id": id64(v.AIID), "ai_name": v.AIName, "owner_name": v.OwnerName, "dir": v.Dir,
			"name": v.Meta.Name, "description": v.Meta.Description, "usage": v.Meta.Usage, "commands": v.Meta.Commands,
			"requires": v.Meta.Requires, "settings": len(v.Meta.Config), "status": v.Status, "enabled": v.Enabled,
			"reject_reason": v.RejectReason, "uploaded_at": v.UploadedAt, "decided_at": v.DecidedAt,
			"host_state": st.State, "host_error": st.Error,
		})
	}
	writeJSON(w, map[string]any{"enabled": true, "items": out})
}

func (h *handler) pluginFiles(w http.ResponseWriter, r *http.Request) {
	a, _, okk := h.running(w)
	if !okk {
		return
	}
	id, okID := pathID(r)
	if !okID || a.Plugins == nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "bad plugin id")
		return
	}
	if name := r.URL.Query().Get("path"); name != "" {
		b, err := a.Plugins.File(r.Context(), id, name)
		if err != nil {
			h.fail(w, err)
			return
		}
		text, cut := "", false
		if len(b) > maxPanelFile {
			b, cut = b[:maxPanelFile], true
		}
		if utf8.Valid(b) || cut {
			text = string(b)
		}
		writeJSON(w, map[string]any{"path": name, "text": text, "binary": !utf8.Valid(b) && !cut, "cut": cut})
		return
	}
	files, err := a.Plugins.Files(r.Context(), id)
	if err != nil {
		h.fail(w, err)
		return
	}
	writeJSON(w, map[string]any{"files": files})
}

func (h *handler) decidePlugin(w http.ResponseWriter, r *http.Request) {
	a, _, okk := h.running(w)
	if !okk {
		return
	}
	id, okID := pathID(r)
	var req struct {
		Approve bool   `json:"approve"`
		Reason  string `json:"reason"`
	}
	if !okID || a.Plugins == nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "bad plugin id")
		return
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if err := a.Plugins.Decide(r.Context(), account.PanelActor, id, req.Approve, req.Reason); err != nil {
		h.fail(w, err)
		return
	}
	writeJSON(w, ok())
}
