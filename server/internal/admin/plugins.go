package admin

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"unicode/utf8"

	"github.com/OzakiJUN/am/server/internal/plugin"
)

// Plugins (docs/plugins.md): NoneBot plugins run as the server's built-in
// bot, and only here — site admins upload them, read their files, change
// their settings, turn them on / off and delete them. Uploads are audited
// (actor 0 = the panel).

const maxPanelFile = 512 << 10

func pluginJSON(v *plugin.View) map[string]any {
	items := []map[string]any{}
	for _, c := range v.Meta.Config {
		items = append(items, map[string]any{"key": c.Key, "label": c.Label, "help": c.Help, "type": c.Type, "default": c.Default,
			"options": c.Options, "group": c.Group, "secret": c.Secret, "min": c.Min, "max": c.Max})
	}
	return map[string]any{
		"id": id64(v.ID), "dir": v.Dir, "name": v.Meta.Name, "description": v.Meta.Description, "usage": v.Meta.Usage,
		"commands": v.Meta.Commands, "requires": v.Meta.Requires, "enabled": v.Enabled, "uploaded_at": v.UploadedAt,
		"config_items": items, "values": v.Values, "secrets_set": v.SecretsSet,
	}
}

func (h *handler) listPlugins(w http.ResponseWriter, r *http.Request) {
	a, _, okk := h.running(w)
	if !okk {
		return
	}
	if a.Plugins == nil {
		writeJSON(w, map[string]any{"enabled": false, "items": []any{}})
		return
	}
	list, st, err := a.Plugins.List(r.Context())
	if err != nil {
		h.fail(w, err)
		return
	}
	out := []map[string]any{}
	for _, v := range list {
		out = append(out, pluginJSON(v))
	}
	writeJSON(w, map[string]any{"enabled": true, "items": out, "host_state": st.State, "host_error": st.Error, "log": st.Log,
		"bot_name": a.Helper.Bot().DisplayName})
}

// uploadPlugin takes a zip (base64 in JSON, like the server icon).
func (h *handler) uploadPlugin(w http.ResponseWriter, r *http.Request) {
	a, _, okk := h.running(w)
	if !okk {
		return
	}
	if a.Plugins == nil {
		h.fail(w, plugin.ErrPluginsOff)
		return
	}
	r.Body = http.MaxBytesReader(nil, r.Body, a.Plugins.MaxZip()*4/3+4096)
	var body struct {
		Data string `json:"data"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusRequestEntityTooLarge, "too_large", "zip 太大了")
		return
	}
	data, err := base64.StdEncoding.DecodeString(body.Data)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "bad zip data")
		return
	}
	list, err := a.Plugins.Upload(r.Context(), data)
	if err != nil {
		h.fail(w, err)
		return
	}
	out := []map[string]any{}
	for _, v := range list {
		out = append(out, pluginJSON(v))
	}
	writeJSON(w, map[string]any{"items": out})
}

// updatePlugin turns a plugin on / off and changes settings (config_patch: JSON object).
func (h *handler) updatePlugin(w http.ResponseWriter, r *http.Request) {
	a, _, okk := h.running(w)
	if !okk {
		return
	}
	id, okID := pathID(r)
	var body struct {
		Enabled     *bool  `json:"enabled"`
		ConfigPatch string `json:"config_patch"`
	}
	if !okID || a.Plugins == nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "bad plugin id")
		return
	}
	if err := readJSON(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	v, err := a.Plugins.Update(r.Context(), id, body.Enabled, body.ConfigPatch)
	if err != nil {
		h.fail(w, err)
		return
	}
	writeJSON(w, pluginJSON(v))
}

func (h *handler) deletePlugin(w http.ResponseWriter, r *http.Request) {
	a, _, okk := h.running(w)
	if !okk {
		return
	}
	id, okID := pathID(r)
	if !okID || a.Plugins == nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "bad plugin id")
		return
	}
	if err := a.Plugins.Delete(r.Context(), id); err != nil {
		h.fail(w, err)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
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
