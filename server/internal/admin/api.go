package admin

import (
	"context"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"google.golang.org/protobuf/proto"
	"rsc.io/qr"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/internal/connectcode"
	"github.com/OzakiJUN/am/server/internal/account"
	"github.com/OzakiJUN/am/server/internal/config"
	"github.com/OzakiJUN/am/server/internal/desktop"
	"github.com/OzakiJUN/am/server/internal/media"
	"github.com/OzakiJUN/am/server/internal/store"
)

// ---- status ----

func (h *handler) status(w http.ResponseWriter, r *http.Request) {
	snap := h.rt.Snapshot()
	abs := func(p string) string {
		if a, err := filepath.Abs(p); err == nil {
			return a
		}
		return p
	}
	out := map[string]any{
		"version":     snap.Version,
		"state":       snap.State,
		"error":       snap.Error,
		"config_path": abs(snap.ConfigPath),
		"platform":    runtime.GOOS,
		"autostart": map[string]bool{
			"supported": desktop.AutostartSupported(),
			"enabled":   desktop.AutostartEnabled(),
		},
	}
	if text, err := os.ReadFile(snap.ConfigPath); err == nil && snap.Config != nil {
		out["config_changed"] = string(text) != snap.ConfigText
	}
	if c := snap.Config; c != nil {
		out["server_name"] = c.Server.Name
		out["listen"] = c.Server.Listen
		out["public_address"] = c.Server.PublicAddress
		out["tls_mode"] = c.TLS.Mode
		out["database"] = c.Database.Driver
		out["data_dir"] = abs(c.Server.DataDir)
		out["proxy_protocol"] = c.Server.ProxyProtocol
	}
	if len(snap.Fingerprint) > 0 {
		out["fingerprint"] = connectcode.FingerprintHex(snap.Fingerprint)
	}
	if a := snap.App; a != nil {
		out["started_at"] = snap.StartedAt.UnixMilli()
		out["online_connections"] = a.Hub.OnlineCount()
		out["online_users"] = len(a.Hub.OnlineUsers())
		st, err := a.Store.Stats(r.Context(), int16(amv1.ConvKind_CONV_KIND_GROUP), int16(amv1.ConvKind_CONV_KIND_DM))
		if err != nil {
			h.fail(w, err)
			return
		}
		out["stats"] = map[string]int64{
			"users": st.Users, "banned": st.Banned, "groups": st.Groups, "dms": st.DMs,
			"messages": st.Messages, "media_bytes": st.MediaBytes, "evidence": st.EvidenceItems,
		}
		if snap.BootstrapInvite != "" {
			if st.Users == 0 {
				out["bootstrap_invite"] = snap.BootstrapInvite
			} else {
				h.rt.ClearBootstrap()
			}
		}
	}
	writeJSON(w, out)
}

// ---- join codes ----

type connectEntry struct {
	Label      string `json:"label"`
	Address    string `json:"address"`
	ServerCode string `json:"server_code"` // join code without invite (log in on a new device)
	JoinCode   string `json:"join_code"`   // with the bootstrap invite, while nobody has registered
	JoinURL    string `json:"join_url"`    // QR content for JoinCode (or ServerCode)
}

func (h *handler) connect(w http.ResponseWriter, r *http.Request) {
	snap := h.rt.Snapshot()
	if snap.Config == nil {
		writeErr(w, http.StatusServiceUnavailable, "not_running", "服务器还没有成功启动过")
		return
	}
	// Name, public address and download page come from the file as it is
	// now, so a newly saved public address shows up here right away.
	cur := snap.Config
	if text, err := os.ReadFile(snap.ConfigPath); err == nil {
		if c, err := config.Parse(string(text)); err == nil {
			cur = c
		}
	}
	_, port, _ := net.SplitHostPort(snap.Config.Server.Listen)
	boot := ""
	if snap.App != nil && snap.BootstrapInvite != "" {
		if n, err := snap.App.Store.CountUsers(r.Context()); err == nil && n == 0 {
			boot = snap.BootstrapInvite
		}
	}
	mk := func(label, addr string) connectEntry {
		j := connectcode.Join{Address: addr, Plain: snap.Config.TLS.Mode == "off"}
		if len(snap.Fingerprint) >= connectcode.PinSize {
			j.Pin = snap.Fingerprint[:connectcode.PinSize]
		}
		e := connectEntry{Label: label, Address: addr}
		e.ServerCode, _ = j.Encode()
		qrCode := e.ServerCode
		if boot != "" {
			j.Invite = boot
			e.JoinCode, _ = j.Encode()
			qrCode = e.JoinCode
		}
		e.JoinURL = connectcode.URL(cur.Invites.DownloadURL, qrCode)
		if e.JoinURL == "" {
			e.JoinURL = qrCode
		}
		return e
	}
	out := map[string]any{"name": cur.Server.Name, "port": port, "tls_mode": snap.Config.TLS.Mode,
		"bootstrap": boot != "", "per_user": cur.Invites.PerUser}
	if cur.Server.PublicAddress != "" {
		out["public"] = mk("公网", cur.Server.PublicAddress)
	}
	var lan []connectEntry
	for _, ip := range lanIPs() {
		lan = append(lan, mk("局域网", net.JoinHostPort(ip, port)))
	}
	lan = append(lan, mk("本机", net.JoinHostPort("127.0.0.1", port)))
	out["lan"] = lan
	writeJSON(w, out)
}

// lanIPs lists this machine's private IPv4 addresses.
func lanIPs() []string {
	var out []string
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := ifc.Addrs()
		for _, a := range addrs {
			if n, ok := a.(*net.IPNet); ok {
				if ip4 := n.IP.To4(); ip4 != nil && ip4.IsPrivate() {
					out = append(out, ip4.String())
				}
			}
		}
	}
	return out
}

func (h *handler) qr(w http.ResponseWriter, r *http.Request) {
	text := r.URL.Query().Get("text")
	if text == "" || len(text) > 1000 {
		writeErr(w, http.StatusBadRequest, "bad_request", "text required")
		return
	}
	c, err := qr.Encode(text, qr.M)
	if err != nil {
		h.fail(w, err)
		return
	}
	c.Scale = 8
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(c.PNG())
}

// ---- invites ----

type inviteJSON struct {
	Code          string `json:"code"`
	CreatedBy     id64   `json:"created_by"`
	CreatedByName string `json:"created_by_name"`
	UsedBy        id64   `json:"used_by"`
	UsedByName    string `json:"used_by_name"`
	MakesAdmin    bool   `json:"makes_admin"`
	Note          string `json:"note"`
	CreatedAt     int64  `json:"created_at"`
	UsedAt        int64  `json:"used_at"`
}

func toInviteJSON(i *store.Invite) inviteJSON {
	return inviteJSON{Code: i.Code, CreatedBy: id64(i.CreatedBy), CreatedByName: i.CreatedByName, UsedBy: id64(i.UsedBy),
		UsedByName: i.UsedByName, MakesAdmin: i.MakesAdmin, Note: i.Note, CreatedAt: i.CreatedAt, UsedAt: i.UsedAt}
}

func (h *handler) listInvites(w http.ResponseWriter, r *http.Request) {
	a, _, okk := h.running(w)
	if !okk {
		return
	}
	limit, offset := page(r, 50)
	list, err := a.Store.ListAllInvites(r.Context(), r.URL.Query().Get("filter") != "all", limit+1, offset)
	if err != nil {
		h.fail(w, err)
		return
	}
	more := len(list) > limit
	if more {
		list = list[:limit]
	}
	out := []inviteJSON{}
	for _, i := range list {
		out = append(out, toInviteJSON(i))
	}
	writeJSON(w, map[string]any{"invites": out, "more": more})
}

func (h *handler) deleteInvite(w http.ResponseWriter, r *http.Request) {
	a, _, okk := h.running(w)
	if !okk {
		return
	}
	if err := a.Account.DeleteInvite(r.Context(), account.PanelActor, r.PathValue("code")); err != nil {
		h.fail(w, err)
		return
	}
	writeJSON(w, ok())
}

// ---- users ----

var accountTypes = map[int16]string{1: "human", 2: "bot", 3: "ai"}

func (h *handler) listUsers(w http.ResponseWriter, r *http.Request) {
	a, _, okk := h.running(w)
	if !okk {
		return
	}
	limit, offset := page(r, 50)
	list, total, err := a.Store.ListUsersAdmin(r.Context(), strings.TrimSpace(r.URL.Query().Get("q")), limit, offset)
	if err != nil {
		h.fail(w, err)
		return
	}
	online := a.Hub.OnlineUsers()
	out := []map[string]any{}
	for _, u := range list {
		out = append(out, map[string]any{
			"id": id64(u.ID), "username": u.Username, "display_name": u.DisplayName,
			"type": accountTypes[u.AccountType], "owner_id": id64(u.OwnerID),
			"is_site_admin": u.IsSiteAdmin, "banned": u.Banned, "ban_reason": u.BanReason, "banned_at": u.BannedAt,
			"created_at": u.CreatedAt, "last_seen": u.LastSeen, "sessions": u.Sessions, "online": online[u.ID],
			"avatar_media_id": id64(u.AvatarMediaID),
		})
	}
	writeJSON(w, map[string]any{"users": out, "total": total, "page_size": limit})
}

func (h *handler) userAction(w http.ResponseWriter, r *http.Request, fn func(ctx context.Context, a *appRef, id int64) (any, error)) {
	a, _, okk := h.running(w)
	if !okk {
		return
	}
	id, okID := pathID(r)
	if !okID {
		writeErr(w, http.StatusBadRequest, "bad_request", "bad user id")
		return
	}
	res, err := fn(r.Context(), &appRef{a.Account, a.Store}, id)
	if err != nil {
		h.fail(w, err)
		return
	}
	if res == nil {
		res = ok()
	}
	writeJSON(w, res)
}

type appRef struct {
	acct *account.Service
	st   *store.Store
}

func (h *handler) banUser(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Reason string `json:"reason"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	h.userAction(w, r, func(ctx context.Context, a *appRef, id int64) (any, error) {
		return nil, a.acct.SetBanned(ctx, account.PanelActor, id, true, req.Reason)
	})
}

func (h *handler) unbanUser(w http.ResponseWriter, r *http.Request) {
	h.userAction(w, r, func(ctx context.Context, a *appRef, id int64) (any, error) {
		return nil, a.acct.SetBanned(ctx, account.PanelActor, id, false, "")
	})
}

func (h *handler) setAdmin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Admin bool `json:"admin"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	h.userAction(w, r, func(ctx context.Context, a *appRef, id int64) (any, error) {
		return nil, a.acct.SetSiteAdmin(ctx, account.PanelActor, id, req.Admin)
	})
}

func (h *handler) resetPassword(w http.ResponseWriter, r *http.Request) {
	h.userAction(w, r, func(ctx context.Context, a *appRef, id int64) (any, error) {
		pw, err := a.acct.ResetPassword(ctx, account.PanelActor, id)
		if err != nil {
			return nil, err
		}
		return map[string]string{"password": pw}, nil
	})
}

func (h *handler) userLogins(w http.ResponseWriter, r *http.Request) {
	h.userAction(w, r, func(ctx context.Context, a *appRef, id int64) (any, error) {
		list, err := a.st.ListLoginRecords(ctx, id, 100)
		if err != nil {
			return nil, err
		}
		out := []map[string]any{}
		for _, l := range list {
			out = append(out, map[string]any{"kind": l.Kind, "ip": l.IP, "device": l.DeviceName, "at": l.CreatedAt})
		}
		return map[string]any{"records": out}, nil
	})
}

// ---- evidence & audit ----

func (h *handler) listEvidence(w http.ResponseWriter, r *http.Request) {
	a, _, okk := h.running(w)
	if !okk {
		return
	}
	limit, offset := page(r, 30)
	list, total, err := a.Store.ListEvidence(r.Context(), limit, offset)
	if err != nil {
		h.fail(w, err)
		return
	}
	out := []map[string]any{}
	for _, e := range list {
		item := map[string]any{
			"event_id": id64(e.EventID), "conv_id": id64(e.ConvID), "conv_name": e.ConvName,
			"conv_kind": map[int16]string{1: "dm", 2: "group"}[e.ConvKind],
			"sender_id": id64(e.SenderID), "sender_name": e.SenderName,
			"deleted_by": id64(e.DeletedBy), "deleted_by_name": e.DeleterName,
			"reason": e.Reason, "deleted_at": e.DeletedAt, "purge_after": e.PurgeAfter,
			"media_id": id64(e.MediaID),
		}
		ev := &amv1.Event{}
		if err := proto.Unmarshal(e.Payload, ev); err == nil {
			switch b := ev.GetBody().(type) {
			case *amv1.Event_Text:
				item["kind"], item["text"] = "text", b.Text.GetText()
			case *amv1.Event_Image:
				item["kind"] = "image"
			case *amv1.Event_File:
				item["kind"], item["file_name"], item["file_size"] = "file", b.File.GetName(), b.File.GetSize()
			default:
				item["kind"] = "other"
			}
		}
		out = append(out, item)
	}
	writeJSON(w, map[string]any{"items": out, "total": total, "page_size": limit})
}

func (h *handler) media(w http.ResponseWriter, r *http.Request) {
	a, _, okk := h.running(w)
	if !okk {
		return
	}
	id, okID := pathID(r)
	if !okID {
		writeErr(w, http.StatusBadRequest, "bad_request", "bad media id")
		return
	}
	f, err := a.Media.OpenForPanel(r.Context(), id, int16(amv1.ConvKind_CONV_KIND_GROUP), r.URL.Query().Get("thumb") == "1")
	if errors.Is(err, media.ErrMediaMissing) {
		writeErr(w, http.StatusNotFound, "media_not_found", "文件不存在或已被清理")
		return
	}
	if err != nil {
		h.fail(w, err)
		return
	}
	file, err := os.Open(f.Path)
	if err != nil {
		writeErr(w, http.StatusNotFound, "media_not_found", "文件不存在或已被清理")
		return
	}
	defer file.Close()
	st, err := file.Stat()
	if err != nil {
		h.fail(w, err)
		return
	}
	hd := w.Header()
	hd.Set("Content-Type", f.Mime)
	hd.Set("X-Content-Type-Options", "nosniff")
	hd.Set("Content-Security-Policy", "sandbox; default-src 'none'")
	if !strings.HasPrefix(f.Mime, "image/") {
		hd.Set("Content-Disposition", "attachment"+media.ContentDisposition(f.Name)[len("inline"):])
	}
	http.ServeContent(w, r, "", st.ModTime(), file)
}

func (h *handler) listAudit(w http.ResponseWriter, r *http.Request) {
	a, _, okk := h.running(w)
	if !okk {
		return
	}
	limit, offset := page(r, 100)
	list, total, err := a.Store.ListAudit(r.Context(), limit, offset)
	if err != nil {
		h.fail(w, err)
		return
	}
	out := []map[string]any{}
	for _, e := range list {
		out = append(out, map[string]any{
			"id": id64(e.ID), "actor_id": id64(e.ActorID), "actor_name": e.ActorName, "action": e.Action,
			"conv_id": id64(e.ConvID), "conv_name": e.ConvName, "target_id": id64(e.TargetID),
			"target_name": e.TargetName, "detail": e.Detail, "at": e.CreatedAt,
		})
	}
	writeJSON(w, map[string]any{"items": out, "total": total, "page_size": limit})
}

func (h *handler) logs(w http.ResponseWriter, r *http.Request) {
	after, _ := strconv.ParseUint(r.URL.Query().Get("after"), 10, 64)
	writeJSON(w, map[string]any{"lines": h.rt.Snapshot().Logs.Since(after)})
}

// ---- settings ----

// settingKinds lists the settings the panel's form may change.
var settingKinds = map[string]string{
	"server.name": "string", "server.public_address": "string", "server.listen": "string",
	"server.proxy_protocol": "bool",
	"invites.per_user":      "int", "invites.admin_unlimited": "bool", "invites.download_url": "string",
	"limits.max_text_length": "int", "limits.max_group_members": "int", "limits.max_upload_mb": "int",
	"limits.login_attempts_per_minute": "int",
	"retention.evidence_days":          "int", "retention.login_record_days": "int",
	"media.block_distance": "int",
	"admin.open_browser":   "bool", "admin.tray": "bool", "admin.listen": "string", "admin.window": "bool",
	"log.level": "string",
}

func settingValues(c *config.Config) map[string]any {
	return map[string]any{
		"server.name": c.Server.Name, "server.public_address": c.Server.PublicAddress, "server.listen": c.Server.Listen,
		"server.proxy_protocol": c.Server.ProxyProtocol,
		"invites.per_user":      c.Invites.PerUser, "invites.admin_unlimited": c.Invites.AdminUnlimited,
		"invites.download_url":   c.Invites.DownloadURL,
		"limits.max_text_length": c.Limits.MaxTextLength, "limits.max_group_members": c.Limits.MaxGroupMembers,
		"limits.max_upload_mb": c.Limits.MaxUploadMB, "limits.login_attempts_per_minute": c.Limits.LoginAttemptsPerMinute,
		"retention.evidence_days": c.Retention.EvidenceDays, "retention.login_record_days": c.Retention.LoginRecordDays,
		"media.block_distance": c.Media.BlockDistance,
		"admin.open_browser":   c.Admin.OpenBrowser, "admin.tray": c.Admin.Tray, "admin.listen": c.Admin.Listen,
		"admin.window": c.Admin.Window,
		"log.level":    c.Log.Level,
	}
}

func (h *handler) getSettings(w http.ResponseWriter, r *http.Request) {
	snap := h.rt.Snapshot()
	text, err := os.ReadFile(snap.ConfigPath)
	if err != nil {
		h.fail(w, err)
		return
	}
	c, err := config.Parse(string(text))
	if err != nil {
		writeErr(w, http.StatusConflict, "config_invalid", "配置文件有错误，请在下方直接编辑修正："+err.Error())
		return
	}
	writeJSON(w, map[string]any{"values": settingValues(c)})
}

func (h *handler) putSettings(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Values map[string]any `json:"values"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	var changes []config.Change
	for k, v := range req.Values {
		kind, known := settingKinds[k]
		if !known {
			writeErr(w, http.StatusBadRequest, "bad_request", "unknown setting "+k)
			return
		}
		var val any
		switch kind {
		case "string":
			s, isStr := v.(string)
			if !isStr {
				writeErr(w, http.StatusBadRequest, "bad_request", k+" must be text")
				return
			}
			val = strings.TrimSpace(s)
		case "bool":
			b, isBool := v.(bool)
			if !isBool {
				writeErr(w, http.StatusBadRequest, "bad_request", k+" must be true/false")
				return
			}
			val = b
		case "int":
			f, isNum := v.(float64)
			if !isNum || f != float64(int(f)) {
				writeErr(w, http.StatusBadRequest, "bad_request", k+" must be a whole number")
				return
			}
			val = int(f)
		}
		sec, key, _ := strings.Cut(k, ".")
		changes = append(changes, config.Change{Section: sec, Key: key, Value: val})
	}
	path := h.rt.Snapshot().ConfigPath
	text, err := os.ReadFile(path)
	if err != nil {
		h.fail(w, err)
		return
	}
	next, err := config.Apply(string(text), changes)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "config_invalid", err.Error())
		return
	}
	if err := config.WriteFile(path, next); err != nil {
		h.fail(w, err)
		return
	}
	h.log.Info("settings changed in admin panel", "keys", len(changes))
	writeJSON(w, ok())
}

func (h *handler) getConfig(w http.ResponseWriter, r *http.Request) {
	text, err := os.ReadFile(h.rt.Snapshot().ConfigPath)
	if err != nil {
		h.fail(w, err)
		return
	}
	writeJSON(w, map[string]string{"text": string(text)})
}

func (h *handler) putConfig(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Text string `json:"text"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if err := config.WriteFile(h.rt.Snapshot().ConfigPath, req.Text); err != nil {
		writeErr(w, http.StatusBadRequest, "config_invalid", err.Error())
		return
	}
	h.log.Info("config.toml edited in admin panel")
	writeJSON(w, ok())
}

func (h *handler) putAutostart(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Enabled bool `json:"enabled"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	exe, err := os.Executable()
	if err != nil {
		h.fail(w, err)
		return
	}
	cfgPath, _ := filepath.Abs(h.rt.Snapshot().ConfigPath)
	if err := desktop.SetAutostart(req.Enabled, exe, []string{"-autostart", "-config", cfgPath}); err != nil {
		h.fail(w, err)
		return
	}
	writeJSON(w, ok())
}

func (h *handler) restart(w http.ResponseWriter, r *http.Request) {
	h.log.Info("restart requested from admin panel")
	h.rt.Restart()
	writeJSON(w, ok())
}

func (h *handler) quit(w http.ResponseWriter, r *http.Request) {
	h.log.Info("quit requested from admin panel")
	writeJSON(w, ok())
	go func() {
		time.Sleep(300 * time.Millisecond)
		h.rt.Quit()
	}()
}
