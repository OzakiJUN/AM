package httpapi

import (
	"net/http"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/apperr"
	"github.com/OzakiJUN/am/server/internal/plugin"
	"github.com/OzakiJUN/am/server/internal/store"
)

// AI plugins (docs/plugins.md): the 插件 tab of an AI's settings. Owner only.

// SetPlugins connects the plugin service (nil = plugins aren't available).
func (a *API) SetPlugins(ps *plugin.Service) { a.plugins = ps }

func (a *API) registerPlugins(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/ai/{id}/plugins", a.authed(a.listPlugins))
	mux.HandleFunc("POST /api/v1/ai/{id}/plugins", a.authed(a.uploadPlugins))
	mux.HandleFunc("PATCH /api/v1/ai/{id}/plugins/{plugin}", a.authed(a.updatePlugin))
	mux.HandleFunc("DELETE /api/v1/ai/{id}/plugins/{plugin}", a.authed(a.deletePlugin))
}

func pluginView(v *plugin.View) *amv1.AIPlugin {
	out := &amv1.AIPlugin{
		Id: v.ID, AiId: v.AIID, Dir: v.Dir, Name: v.Meta.Name, Description: v.Meta.Description, Usage: v.Meta.Usage,
		Commands: v.Meta.Commands, Requires: v.Meta.Requires, SecretsSet: v.SecretsSet,
		Status: v.Status, RejectReason: v.RejectReason, Enabled: v.Enabled, UploadedAt: v.UploadedAt,
	}
	if out.Name == "" {
		out.Name = v.Dir
	}
	for _, c := range v.Meta.Config {
		out.ConfigItems = append(out.ConfigItems, &amv1.PluginConfigItem{
			Key: c.Key, Label: c.Label, Help: c.Help, Type: c.Type, DefaultJson: string(c.Default),
			Options: c.Options, Group: c.Group, Secret: c.Secret, Min: c.Min, Max: c.Max,
		})
	}
	out.ConfigJson = plugin.ValuesJSON(v.Values)
	return out
}

func (a *API) pluginsOn(w http.ResponseWriter) bool {
	if a.plugins == nil {
		a.fail(w, plugin.ErrPluginsOff)
		return false
	}
	return true
}

func (a *API) listPlugins(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	id, ok := pathID(r, "id")
	if !ok {
		a.fail(w, apperr.ErrBadRequest)
		return
	}
	if !a.pluginsOn(w) {
		return
	}
	list, st, err := a.plugins.List(r.Context(), me, id)
	if err != nil {
		a.fail(w, err)
		return
	}
	out := &amv1.ListPluginsResponse{HostState: st.State, HostError: st.Error, Log: st.Log, CommandStart: a.plugins.CommandStart()}
	for _, v := range list {
		out.Plugins = append(out.Plugins, pluginView(v))
	}
	a.ok(w, out)
}

func (a *API) uploadPlugins(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	id, ok := pathID(r, "id")
	req := &amv1.UploadPluginsRequest{}
	if !ok {
		a.fail(w, apperr.ErrBadRequest)
		return
	}
	if !a.pluginsOn(w) || !a.read(w, r, req) {
		return
	}
	list, err := a.plugins.Upload(r.Context(), me, id, req.GetMediaId())
	if err != nil {
		a.fail(w, err)
		return
	}
	out := &amv1.ListPluginsResponse{}
	for _, v := range list {
		out.Plugins = append(out.Plugins, pluginView(v))
	}
	a.ok(w, out)
}

func (a *API) updatePlugin(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	id, ok1 := pathID(r, "id")
	pid, ok2 := pathID(r, "plugin")
	req := &amv1.UpdatePluginRequest{}
	if !ok1 || !ok2 {
		a.fail(w, apperr.ErrBadRequest)
		return
	}
	if !a.pluginsOn(w) || !a.read(w, r, req) {
		return
	}
	v, err := a.plugins.Update(r.Context(), me, id, pid, req.Enabled, req.GetConfigJson())
	if err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, pluginView(v))
}

func (a *API) deletePlugin(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	id, ok1 := pathID(r, "id")
	pid, ok2 := pathID(r, "plugin")
	if !ok1 || !ok2 {
		a.fail(w, apperr.ErrBadRequest)
		return
	}
	if !a.pluginsOn(w) {
		return
	}
	if err := a.plugins.Delete(r.Context(), me, id, pid); err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, &amv1.Empty{})
}
