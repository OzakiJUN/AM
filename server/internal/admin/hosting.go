package admin

import (
	"net/http"

	"github.com/OzakiJUN/am/server/internal/account"
)

// AIs hosted on this server (docs/design.md §10 托管): requests wait here;
// approving starts the AM client for that AI on this computer; rejecting
// an approved one stops it. Every decision is audited (actor 0 = the panel).

func (h *handler) listHosting(w http.ResponseWriter, r *http.Request) {
	a, _, okk := h.running(w)
	if !okk {
		return
	}
	if a.Hosting == nil {
		writeJSON(w, map[string]any{"enabled": false, "items": []any{}})
		return
	}
	list, err := a.Hosting.AdminList(r.Context(), r.URL.Query().Get("status"))
	if err != nil {
		h.fail(w, err)
		return
	}
	out := []map[string]any{}
	for _, v := range list {
		out = append(out, map[string]any{
			"ai_id": id64(v.AIID), "ai_name": v.AIName, "owner_name": v.OwnerName, "status": v.Status,
			"requested_at": v.RequestedAt, "decided_at": v.DecidedAt, "reject_reason": v.RejectReason,
			"state": v.State, "error": v.Error, "log": v.Log, "work_dir": a.Hosting.WorkDir(v.AIID),
		})
	}
	writeJSON(w, map[string]any{"enabled": a.Hosting.Enabled(), "items": out})
}

func (h *handler) decideHosting(w http.ResponseWriter, r *http.Request) {
	a, _, okk := h.running(w)
	if !okk {
		return
	}
	id, okID := pathID(r)
	var req struct {
		Approve bool   `json:"approve"`
		Reason  string `json:"reason"`
	}
	if !okID || a.Hosting == nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "bad AI id")
		return
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if err := a.Hosting.Decide(r.Context(), account.PanelActor, id, req.Approve, req.Reason); err != nil {
		h.fail(w, err)
		return
	}
	writeJSON(w, ok())
}
