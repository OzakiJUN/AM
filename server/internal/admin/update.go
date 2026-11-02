package admin

import (
	"context"
	"net/http"
	"time"
)

// Updates (docs/release.md): the panel's 更新 page shows the running and
// the latest version, checks now, and updates in one click (download,
// verify, replace am-server, restart). The updater lives beside the
// supervisor, so this works even while the chat server is down.

func (h *handler) updateStatus(w http.ResponseWriter, r *http.Request) {
	u := h.rt.Snapshot().Updater
	if u == nil {
		writeJSON(w, map[string]any{"enabled": false})
		return
	}
	writeJSON(w, map[string]any{"enabled": true, "status": u.Status()})
}

func (h *handler) updateCheck(w http.ResponseWriter, r *http.Request) {
	u := h.rt.Snapshot().Updater
	if u == nil {
		writeErr(w, http.StatusNotFound, "not_found", "没有更新功能")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	if err := u.Check(ctx); err != nil {
		writeErr(w, http.StatusBadGateway, "update_failed", err.Error())
		return
	}
	writeJSON(w, map[string]any{"enabled": true, "status": u.Status()})
}

// updateApply starts the update in the background; the page polls the
// status (downloading → restarting) and reloads when the server is back.
func (h *handler) updateApply(w http.ResponseWriter, r *http.Request) {
	u := h.rt.Snapshot().Updater
	if u == nil {
		writeErr(w, http.StatusNotFound, "not_found", "没有更新功能")
		return
	}
	st := u.Status()
	if !st.CanUpdate {
		writeErr(w, http.StatusBadRequest, "update_failed", st.Why)
		return
	}
	if !st.Newer {
		writeErr(w, http.StatusBadRequest, "update_failed", "已经是最新版了")
		return
	}
	h.log.Info("update started from the admin panel", "to", st.Latest)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
		defer cancel()
		if err := u.Apply(ctx); err != nil {
			h.log.Warn("update failed", "err", err)
		}
	}()
	writeJSON(w, map[string]any{"ok": true})
}
