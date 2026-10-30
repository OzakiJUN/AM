// Package admin is the server admin panel: a small web app embedded in
// am-server and served on admin.listen (127.0.0.1:8444 by default). It is
// for the person running the server, not for chat users, and logs in with
// the key in data/admin_key.txt (the tray icon opens it already logged in).
//
// The panel's JSON API lives under /api/. It is internal to the panel and
// may change with the panel; it is not part of the client protocol.
package admin

import (
	"crypto/subtle"
	"embed"
	"encoding/json"
	"errors"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/OzakiJUN/am/server/internal/app"
	"github.com/OzakiJUN/am/server/internal/apperr"
	"github.com/OzakiJUN/am/server/internal/config"
	"github.com/OzakiJUN/am/server/internal/logx"
)

//go:embed web
var webFS embed.FS

// State of the chat server.
type State string

const (
	StateStarting State = "starting"
	StateRunning  State = "running"
	StateStopped  State = "stopped"
	StateError    State = "error"
)

// Snapshot is what the panel needs to know about the running server.
type Snapshot struct {
	State           State
	Error           string
	Version         string
	ConfigPath      string
	Config          *config.Config // nil until the server started once
	ConfigText      string         // config file content the server runs with
	App             *app.App       // nil unless running
	Fingerprint     []byte         // self-signed certificate SHA-256, nil otherwise
	StartedAt       time.Time
	BootstrapInvite string
	Logs            *logx.Ring
}

// Runtime is implemented by the supervisor.
type Runtime interface {
	Snapshot() Snapshot
	Restart()
	Quit()
	ClearBootstrap()
	// SetPublicAddress changes server.public_address of the running server
	// (join codes, what clients are told) without a restart.
	SetPublicAddress(addr string)
}

const cookieName = "am_admin"

type handler struct {
	rt       Runtime
	key      string
	loopback bool
	log      *slog.Logger
	mux      *http.ServeMux
}

// New returns the panel's HTTP handler. listen is the admin listen address;
// when it is a loopback address, requests must also name a loopback host
// (blocks DNS-rebinding tricks).
func New(rt Runtime, key, listen string, log *slog.Logger) http.Handler {
	h := &handler{rt: rt, key: key, log: log, mux: http.NewServeMux()}
	if host, _, err := net.SplitHostPort(listen); err == nil {
		ip := net.ParseIP(host)
		h.loopback = host == "localhost" || (ip != nil && ip.IsLoopback())
	}
	h.routes()
	return h
}

func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h.loopback && !loopbackHost(r.Host) {
		http.Error(w, "forbidden host", http.StatusForbidden)
		return
	}
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("Referrer-Policy", "no-referrer")
	h.mux.ServeHTTP(w, r)
}

func loopbackHost(hostport string) bool {
	host := hostport
	if hh, _, err := net.SplitHostPort(hostport); err == nil {
		host = hh
	}
	host = strings.Trim(host, "[]")
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func (h *handler) routes() {
	sub, _ := fs.Sub(webFS, "web")
	static := http.FileServer(http.FS(sub))
	h.mux.Handle("GET /", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy",
			"default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; frame-ancestors 'none'")
		w.Header().Set("Cache-Control", "no-cache")
		static.ServeHTTP(w, r)
	}))
	h.mux.HandleFunc("GET /login", h.loginLink)
	h.mux.HandleFunc("GET /api/ping", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]string{"app": "am-server"})
	})
	h.mux.HandleFunc("POST /api/login", h.loginForm)
	h.mux.HandleFunc("POST /api/logout", func(w http.ResponseWriter, r *http.Request) {
		http.SetCookie(w, &http.Cookie{Name: cookieName, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteStrictMode})
		writeJSON(w, ok())
	})

	api := func(pattern string, fn http.HandlerFunc) { h.mux.HandleFunc(pattern, h.auth(fn)) }
	api("GET /api/status", h.status)
	api("GET /api/connect", h.connect)
	api("GET /api/connect/qr.png", h.qr)
	api("GET /api/invites", h.listInvites)
	api("DELETE /api/invites/{code}", h.deleteInvite)
	api("GET /api/users", h.listUsers)
	api("POST /api/users/{id}/ban", h.banUser)
	api("POST /api/users/{id}/unban", h.unbanUser)
	api("POST /api/users/{id}/admin", h.setAdmin)
	api("POST /api/users/{id}/reset-password", h.resetPassword)
	api("GET /api/users/{id}/logins", h.userLogins)
	api("POST /api/users/{id}/clear-profile", h.clearProfile)
	api("GET /api/server-profile", h.getServerProfile)
	api("PUT /api/server-profile", h.putServerProfile)
	api("GET /api/server-icon", h.serverIcon)
	api("PUT /api/server-icon", h.putServerIcon)
	api("DELETE /api/server-icon", h.deleteServerIcon)
	api("GET /api/channels", h.listChannels)
	api("GET /api/channels/{id}/events", h.channelEvents)
	api("GET /api/evidence", h.listEvidence)
	api("GET /api/media/{id}", h.media)
	api("GET /api/audit", h.listAudit)
	api("GET /api/logs", h.logs)
	api("GET /api/settings", h.getSettings)
	api("PUT /api/settings", h.putSettings)
	api("GET /api/config", h.getConfig)
	api("PUT /api/config", h.putConfig)
	api("PUT /api/autostart", h.putAutostart)
	api("GET /api/relay", h.getRelay)
	api("POST /api/relay/test", h.testRelay)
	api("POST /api/relay/move", h.moveRelay)
	api("POST /api/restart", h.restart)
	api("POST /api/quit", h.quit)
}

// ---- auth ----

func (h *handler) validKey(k string) bool {
	return len(k) > 0 && subtle.ConstantTimeCompare([]byte(k), []byte(h.key)) == 1
}

func (h *handler) setCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name: cookieName, Value: h.key, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode,
		MaxAge: 30 * 24 * 3600,
	})
}

// loginLink handles the link the tray icon opens: /login?key=...
func (h *handler) loginLink(w http.ResponseWriter, r *http.Request) {
	if h.validKey(r.URL.Query().Get("key")) {
		h.setCookie(w)
	}
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

func (h *handler) loginForm(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Key string `json:"key"`
	}
	if err := readJSON(r, &req); err != nil || !h.validKey(strings.TrimSpace(req.Key)) {
		time.Sleep(500 * time.Millisecond)
		writeErr(w, http.StatusUnauthorized, "wrong_key", "登录密钥不对")
		return
	}
	h.setCookie(w)
	writeJSON(w, ok())
}

func (h *handler) auth(fn http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(cookieName)
		if err != nil || !h.validKey(c.Value) {
			writeErr(w, http.StatusUnauthorized, "unauthorized", "请先登录")
			return
		}
		// State-changing requests must be JSON: browsers cannot send that
		// cross-site without a CORS preflight, which this server never allows.
		if r.Method != http.MethodGet && r.ContentLength != 0 &&
			!strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
			writeErr(w, http.StatusUnsupportedMediaType, "bad_request", "请求格式不对")
			return
		}
		fn(w, r)
	}
}

// ---- helpers ----

func ok() map[string]bool { return map[string]bool{"ok": true} }

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"code": code, "message": msg})
}

func (h *handler) fail(w http.ResponseWriter, err error) {
	var ae *apperr.Error
	if errors.As(err, &ae) {
		writeErr(w, ae.Status, ae.Code, ae.Message)
		return
	}
	h.log.Error("admin panel request failed", "err", err)
	writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
}

func readJSON(r *http.Request, v any) error {
	r.Body = http.MaxBytesReader(nil, r.Body, 1<<20)
	return json.NewDecoder(r.Body).Decode(v)
}

// running returns the app, or writes a "not running" error.
func (h *handler) running(w http.ResponseWriter) (*app.App, Snapshot, bool) {
	snap := h.rt.Snapshot()
	if snap.App == nil {
		writeErr(w, http.StatusServiceUnavailable, "not_running", "服务器没有在运行")
		return nil, snap, false
	}
	return snap.App, snap, true
}

func pathID(r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	return id, err == nil && id > 0
}

// page reads ?page= (1-based) and returns limit, offset.
func page(r *http.Request, size int) (int, int) {
	p, _ := strconv.Atoi(r.URL.Query().Get("page"))
	if p < 1 {
		p = 1
	}
	return size, (p - 1) * size
}

// id64 is an int64 sent as a JSON string (JavaScript numbers lose
// precision above 2^53, and snowflake ids are larger).
type id64 int64

func (i id64) MarshalJSON() ([]byte, error) {
	if i == 0 {
		return []byte(`""`), nil
	}
	return []byte(`"` + strconv.FormatInt(int64(i), 10) + `"`), nil
}
