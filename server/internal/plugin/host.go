package plugin

// The host: one NoneBot process per AI account with approved, enabled
// plugins, and the OneBot v11 forward-WebSocket endpoint it connects to
// (loopback only, one random token per AI). Messages the AI receives reach
// the plugins as OneBot events (Tap); what plugins send goes out as the AI.

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/conv"
	"github.com/OzakiJUN/am/server/internal/media"
	"github.com/OzakiJUN/am/server/internal/message"
	"github.com/OzakiJUN/am/server/internal/store"
)

// Config is the [plugins] section of config.toml.
type Config struct {
	Enabled bool
	// Python interpreter for the virtualenv ("" = find python3 / python / py -3).
	Python   string
	PipIndex string
	// Command prefixes NoneBot recognises (COMMAND_START), e.g. ["/"].
	CommandStart []string
	// Root folder: data/plugins.
	Dir string
	// Spawn NoneBot processes (tests turn this off and connect themselves).
	Spawn bool
}

const (
	logLines        = 300
	heartbeatPeriod = 30 * time.Second
	eventQueue      = 512
	maxImageBytes   = 20 << 20
)

// Status of one AI's plugin host, for the owner's UI.
type Status struct {
	State string // off | preparing | starting | running | error
	Error string
	Log   []string
}

type bot struct {
	ai      int64
	token   string
	plugins []*store.AIPlugin
	key     string // what it runs (plugins + config), to know when to restart
	// New messages for the plugins, in order (dropped when NoneBot falls far behind).
	events chan *amv1.Event

	mu    sync.Mutex
	conn  *websocket.Conn
	state string
	err   string
	logs  []string
	stop  context.CancelFunc
	done  chan struct{}
}

func (b *bot) logf(format string, a ...any) {
	b.mu.Lock()
	defer b.mu.Unlock()
	line := time.Now().Format("15:04:05 ") + fmt.Sprintf(format, a...)
	b.logs = append(b.logs, line)
	if len(b.logs) > logLines {
		b.logs = b.logs[len(b.logs)-logLines:]
	}
}

func (b *bot) set(state, err string) {
	b.mu.Lock()
	b.state, b.err = state, err
	b.mu.Unlock()
}

// Host runs the plugins of every AI on this server.
type Host struct {
	cfg  Config
	st   *store.Store
	msg  *message.Service
	conv *conv.Service
	md   *media.Service
	log  *slog.Logger
	env  *pyEnv

	ln   net.Listener
	srv  *http.Server
	ctx  context.Context
	quit context.CancelFunc

	mu   sync.Mutex
	bots map[int64]*bot
	sync chan struct{}
}

// NewHost starts the loopback OneBot endpoint (plugins start with Sync).
func NewHost(cfg Config, st *store.Store, msg *message.Service, cs *conv.Service, md *media.Service, log *slog.Logger) (*Host, error) {
	// Absolute: NoneBot runs in the AI's folder, and a relative program path
	// would be looked up from there ("data\plugins\venv\..." not found).
	dir, err := filepath.Abs(cfg.Dir)
	if err != nil {
		return nil, err
	}
	cfg.Dir = dir
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	ctx, quit := context.WithCancel(context.Background())
	h := &Host{cfg: cfg, st: st, msg: msg, conv: cs, md: md, log: log, ln: ln, ctx: ctx, quit: quit,
		bots: map[int64]*bot{}, sync: make(chan struct{}, 1)}
	h.env = &pyEnv{dir: filepath.Join(cfg.Dir, "venv"), python: cfg.Python, pipIndex: cfg.PipIndex,
		log: func(s string) { log.Info("plugins: " + s) }}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /onebot/{ai}", h.serveWS)
	mux.HandleFunc("GET /media/{ai}/{id}", h.serveMedia)
	h.srv = &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go h.srv.Serve(ln)
	go h.syncLoop()
	return h, nil
}

// Addr is the loopback address of the OneBot endpoint.
func (h *Host) Addr() string { return h.ln.Addr().String() }

// Token of an AI's host (tests connect with it).
func (h *Host) Token(ai int64) string {
	h.mu.Lock()
	defer h.mu.Unlock()
	if b := h.bots[ai]; b != nil {
		return b.token
	}
	return ""
}

// Close stops every plugin process and the endpoint.
func (h *Host) Close() {
	h.quit()
	h.mu.Lock()
	bots := make([]*bot, 0, len(h.bots))
	for _, b := range h.bots {
		bots = append(bots, b)
	}
	h.mu.Unlock()
	for _, b := range bots {
		h.stopBot(b)
	}
	_ = h.srv.Close()
}

// Sync asks the host to start / restart / stop processes to match the
// database (approved + enabled plugins). It returns at once.
func (h *Host) Sync() {
	select {
	case h.sync <- struct{}{}:
	default:
	}
}

func (h *Host) syncLoop() {
	// Also every minute: AIs get banned / deleted without telling us.
	tick := time.NewTicker(time.Minute)
	defer tick.Stop()
	for {
		select {
		case <-h.ctx.Done():
			return
		case <-tick.C:
		case <-h.sync:
		}
		if err := h.syncNow(h.ctx); err != nil && h.ctx.Err() == nil {
			h.log.Error("plugins: sync", "err", err)
		}
	}
}

func (h *Host) syncNow(ctx context.Context) error {
	want := map[int64][]*store.AIPlugin{}
	if h.cfg.Enabled {
		list, err := h.st.RunnablePlugins(ctx)
		if err != nil {
			return err
		}
		for _, p := range list {
			want[p.AIID] = append(want[p.AIID], p)
		}
	}
	h.mu.Lock()
	var stop []*bot
	for ai, b := range h.bots {
		if ps, ok := want[ai]; !ok || runKey(ps) != b.key {
			stop = append(stop, b)
			delete(h.bots, ai)
		}
	}
	var start []*bot
	for ai, ps := range want {
		if _, ok := h.bots[ai]; ok {
			continue
		}
		b := &bot{ai: ai, token: randomToken(), plugins: ps, key: runKey(ps), state: "starting", done: make(chan struct{}),
			events: make(chan *amv1.Event, eventQueue)}
		h.bots[ai] = b
		start = append(start, b)
	}
	h.mu.Unlock()
	for _, b := range stop {
		h.stopBot(b)
	}
	for _, b := range start {
		h.startBot(b)
	}
	return nil
}

func runKey(ps []*store.AIPlugin) string {
	var parts []string
	for _, p := range ps {
		parts = append(parts, p.Dir+"@"+p.FilesSHA256+"#"+p.Config)
	}
	sort.Strings(parts)
	return strings.Join(parts, "|")
}

func randomToken() string {
	var b [24]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// StatusOf an AI's plugins.
func (h *Host) StatusOf(ai int64) Status {
	h.mu.Lock()
	b := h.bots[ai]
	h.mu.Unlock()
	if b == nil {
		st := Status{State: "off"}
		if e := h.env.Status(); strings.HasPrefix(e, "error: ") {
			st.State, st.Error = "error", strings.TrimPrefix(e, "error: ")
		}
		return st
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	return Status{State: b.state, Error: b.err, Log: append([]string(nil), b.logs...)}
}

// AIDir is where an AI's NoneBot runs (its plugins, .env, data).
func (h *Host) AIDir(ai int64) string {
	return filepath.Join(h.cfg.Dir, "ai-"+strconv.FormatInt(ai, 10))
}

// PkgDir is where an uploaded plugin's files are kept.
func (h *Host) PkgDir(id int64) string {
	return filepath.Join(h.cfg.Dir, "pkgs", strconv.FormatInt(id, 10))
}

func (h *Host) stopBot(b *bot) {
	b.mu.Lock()
	stop := b.stop
	conn := b.conn
	b.mu.Unlock()
	if stop != nil {
		stop()
		<-b.done
	}
	if conn != nil {
		_ = conn.Close(websocket.StatusGoingAway, "stopped")
	}
}

func (h *Host) startBot(b *bot) {
	ctx, cancel := context.WithCancel(h.ctx)
	b.mu.Lock()
	b.stop = cancel
	b.mu.Unlock()
	if !h.cfg.Spawn {
		b.set("starting", "")
		close(b.done)
		return
	}
	go func() {
		defer close(b.done)
		delay := 5 * time.Second
		for ctx.Err() == nil {
			started := time.Now()
			err := h.runOnce(ctx, b)
			if ctx.Err() != nil {
				return
			}
			msg := "进程退出了"
			if err != nil {
				msg = err.Error()
			}
			b.set("error", msg)
			b.logf("stopped: %s; starting again in %s", msg, delay)
			if time.Since(started) > 5*time.Minute {
				delay = 5 * time.Second
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(delay):
			}
			if delay < 5*time.Minute {
				delay *= 3
			}
		}
	}()
}

// runOnce prepares the folder and the Python packages, then runs NoneBot until it exits.
func (h *Host) runOnce(ctx context.Context, b *bot) error {
	b.set("preparing", "")
	reqs := map[string]bool{}
	for _, p := range b.plugins {
		var m Meta
		_ = json.Unmarshal([]byte(p.Meta), &m)
		for _, r := range m.Requires {
			reqs[r] = true
		}
	}
	var list []string
	for r := range reqs {
		list = append(list, r)
	}
	sort.Strings(list)
	if err := h.env.Ensure(ctx, list); err != nil {
		b.logf("%v", err)
		if strings.Contains(err.Error(), "Python") {
			return err
		}
		// Some packages failed: try anyway, the plugin may not need them.
	}
	dir, err := h.prepare(ctx, b)
	if err != nil {
		return err
	}
	b.set("starting", "")
	cmd := exec.CommandContext(ctx, h.env.Python(), "bot.py")
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "PYTHONUNBUFFERED=1", "PYTHONIOENCODING=utf-8")
	out, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	cmd.Stderr = cmd.Stdout
	hideWindow(cmd)
	if err := cmd.Start(); err != nil {
		return err
	}
	sc := bufio.NewScanner(out)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		b.logf("%s", sc.Text())
	}
	return cmd.Wait()
}

const botPy = `# Written by am-server: runs this AI's approved plugins (docs/plugins.md).
import nonebot
from nonebot.adapters.onebot.v11 import Adapter

nonebot.init()
nonebot.get_driver().register_adapter(Adapter)
nonebot.load_plugins("plugins")

if __name__ == "__main__":
    nonebot.run()
`

// prepare writes the AI's folder: plugins/<dir> (copies of the approved
// packages), bot.py and .env (connection, the bot's name and superusers, every
// plugin's settings).
func (h *Host) prepare(ctx context.Context, b *bot) (string, error) {
	dir := h.AIDir(b.ai)
	pdir := filepath.Join(dir, "plugins")
	if err := os.RemoveAll(pdir); err != nil {
		return "", err
	}
	if err := os.MkdirAll(pdir, 0o755); err != nil {
		return "", err
	}
	for _, p := range b.plugins {
		if err := copyTree(filepath.Join(h.PkgDir(p.ID), p.Dir), filepath.Join(pdir, p.Dir)); err != nil {
			return "", fmt.Errorf("copy %s: %w", p.Dir, err)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "bot.py"), []byte(botPy), 0o644); err != nil {
		return "", err
	}
	ai, err := h.st.GetUser(ctx, b.ai)
	if err != nil {
		return "", err
	}
	// SUPERUSER = the owner; for the built-in bot (no owner) the site admins.
	supers := []string{strconv.FormatInt(ai.OwnerID, 10)}
	if ai.OwnerID == 0 {
		ids, err := h.st.SiteAdminIDs(ctx)
		if err != nil {
			return "", err
		}
		supers = supers[:0]
		for _, id := range ids {
			supers = append(supers, strconv.FormatInt(id, 10))
		}
	}
	env := map[string]any{
		"DRIVER":                     "~websockets",
		"ONEBOT_WS_URLS":             []string{"ws://" + h.Addr() + "/onebot/" + strconv.FormatInt(b.ai, 10)},
		"ONEBOT_ACCESS_TOKEN":        b.token,
		"COMMAND_START":              h.cfg.CommandStart,
		"NICKNAME":                   []string{ai.DisplayName},
		"SUPERUSERS":                 supers,
		"LOG_LEVEL":                  "INFO",
		"LOCALSTORE_DATA_DIR":        filepath.Join(dir, "data"),
		"LOCALSTORE_CACHE_DIR":       filepath.Join(dir, "cache"),
		"LOCALSTORE_CONFIG_DIR":      filepath.Join(dir, "config"),
		"APSCHEDULER_AUTOSTART":      true,
		"NONEBOT_PLUGIN_DIRS_IGNORE": nil,
	}
	delete(env, "NONEBOT_PLUGIN_DIRS_IGNORE")
	for _, p := range b.plugins {
		var vals map[string]json.RawMessage
		_ = json.Unmarshal([]byte(p.Config), &vals)
		for k, v := range vals {
			if !coreKeys[strings.ToLower(k)] {
				env[strings.ToUpper(k)] = v
			}
		}
	}
	keys := make([]string, 0, len(env))
	for k := range env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var sb strings.Builder
	sb.WriteString("# Written by am-server; edit plugin settings in AM (AI 设置 → 插件).\n")
	for _, k := range keys {
		var line string
		switch v := env[k].(type) {
		case string:
			line = v
		case json.RawMessage:
			var s string
			if json.Unmarshal(v, &s) == nil {
				line = s
			} else {
				line = string(v)
			}
		default:
			bb, _ := json.Marshal(v)
			line = string(bb)
		}
		if envNeedsQuotes(line) {
			line = envQuote(line)
		}
		sb.WriteString(k + "=" + line + "\n")
	}
	if err := os.WriteFile(filepath.Join(dir, ".env"), []byte(sb.String()), 0o600); err != nil {
		return "", err
	}
	return dir, nil
}

// envNeedsQuotes: .env values with these would be cut or changed unquoted.
func envNeedsQuotes(v string) bool {
	return strings.ContainsAny(v, "\n\r#'\"\\`") || strings.TrimSpace(v) != v
}

// envQuote writes a double-quoted .env value.
func envQuote(v string) string {
	r := strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`, "\r", `\r`)
	return `"` + r.Replace(v) + `"`
}

func copyTree(src, dst string) error {
	return filepath.Walk(src, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		t := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(t, 0o755)
		}
		in, err := os.Open(p)
		if err != nil {
			return err
		}
		defer in.Close()
		out, err := os.Create(t)
		if err != nil {
			return err
		}
		if _, err := io.Copy(out, in); err != nil {
			out.Close()
			return err
		}
		return out.Close()
	})
}

// ---- the OneBot endpoint ----

func (h *Host) botFor(r *http.Request) *bot {
	ai, err := strconv.ParseInt(r.PathValue("ai"), 10, 64)
	if err != nil {
		return nil
	}
	tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if tok == "" {
		tok = r.URL.Query().Get("access_token")
	}
	h.mu.Lock()
	b := h.bots[ai]
	h.mu.Unlock()
	if b == nil || tok == "" || subtle.ConstantTimeCompare([]byte(tok), []byte(b.token)) != 1 {
		return nil
	}
	return b
}

func (h *Host) serveWS(w http.ResponseWriter, r *http.Request) {
	b := h.botFor(r)
	if b == nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	ws, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	ws.SetReadLimit(64 << 20)
	ctx, cancel := context.WithCancel(h.ctx)
	defer cancel()
	b.mu.Lock()
	if old := b.conn; old != nil {
		_ = old.Close(websocket.StatusPolicyViolation, "replaced")
	}
	b.conn = ws
	b.state, b.err = "running", ""
	b.mu.Unlock()
	b.logf("NoneBot connected")
	defer func() {
		b.mu.Lock()
		if b.conn == ws {
			b.conn = nil
			if b.state == "running" {
				b.state = "starting"
			}
		}
		b.mu.Unlock()
		_ = ws.CloseNow()
	}()
	now := time.Now().Unix()
	h.write(ctx, ws, map[string]any{"time": now, "self_id": b.ai, "post_type": "meta_event", "meta_event_type": "lifecycle", "sub_type": "connect"})
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case ev := <-b.events:
				h.deliverTo(ctx, b, ws, ev)
			}
		}
	}()
	go func() {
		t := time.NewTicker(heartbeatPeriod)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				h.write(ctx, ws, map[string]any{"time": time.Now().Unix(), "self_id": b.ai, "post_type": "meta_event", "meta_event_type": "heartbeat",
					"status": map[string]any{"online": true, "good": true}, "interval": heartbeatPeriod.Milliseconds()})
			}
		}
	}()
	for {
		_, data, err := ws.Read(ctx)
		if err != nil {
			return
		}
		var req struct {
			Action string          `json:"action"`
			Params json.RawMessage `json:"params"`
			Echo   json.RawMessage `json:"echo"`
		}
		if json.Unmarshal(data, &req) != nil {
			continue
		}
		go func() {
			res, err := h.call(ctx, b, req.Action, req.Params)
			resp := map[string]any{"status": "ok", "retcode": 0, "data": res}
			if err != nil {
				code := 100
				if errors.Is(err, errUnsupported) {
					code = 1404
				}
				resp = map[string]any{"status": "failed", "retcode": code, "data": nil, "message": err.Error(), "wording": err.Error()}
				b.logf("API %s failed: %v", req.Action, err)
			}
			if len(req.Echo) > 0 {
				resp["echo"] = req.Echo
			}
			h.write(ctx, ws, resp)
		}()
	}
}

func (h *Host) write(ctx context.Context, ws *websocket.Conn, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	wctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	_ = ws.Write(wctx, websocket.MessageText, b)
}

// serveMedia lets plugins download a picture the AI can see.
func (h *Host) serveMedia(w http.ResponseWriter, r *http.Request) {
	b := h.botFor(r)
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if b == nil || err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	ai, err := h.st.GetUser(r.Context(), b.ai)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	f, err := h.md.Open(r.Context(), ai, id, false)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", f.Mime)
	http.ServeFile(w, r, f.Path)
}

func (h *Host) mediaURL(b *bot, id int64) string {
	return fmt.Sprintf("http://%s/media/%d/%d?access_token=%s", h.Addr(), b.ai, id, b.token)
}

// ---- events in ----

// Deliver hands a new message to the plugins of the AIs among the recipients.
func (h *Host) Deliver(userIDs []int64, ev *amv1.Event) {
	h.mu.Lock()
	var targets []*bot
	for _, u := range userIDs {
		if b := h.bots[u]; b != nil && u != ev.GetSenderId() {
			targets = append(targets, b)
		}
	}
	h.mu.Unlock()
	for _, b := range targets {
		b.mu.Lock()
		connected := b.conn != nil
		b.mu.Unlock()
		if !connected {
			continue
		}
		select {
		case b.events <- ev:
		default:
			b.logf("too many messages waiting, one was not passed to the plugins")
		}
	}
}

func (h *Host) deliverTo(ctx context.Context, b *bot, ws *websocket.Conn, ev *amv1.Event) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	c, err := h.st.GetConvForUser(ctx, ev.GetConvId(), b.ai)
	if err != nil {
		return
	}
	in := EventInfo{SelfID: b.ai, Group: c.Kind == int16(amv1.ConvKind_CONV_KIND_GROUP), NameOf: h.nameOf(ctx),
		ImageURL: func(id int64) string { return h.mediaURL(b, id) }}
	sender, err := h.st.GetUser(ctx, ev.GetSenderId())
	if err != nil {
		return
	}
	in.Sender = Sender{ID: sender.ID, Name: sender.DisplayName, Role: "member"}
	if in.Group {
		if m, err := h.st.GetMember(ctx, c.ID, sender.ID); err == nil {
			in.Sender.Role = Role(amv1.MemberRole(m.Role))
		}
	}
	out, ok := MessageEvent(ev, in)
	if !ok {
		return
	}
	h.write(ctx, ws, out)
}

func (h *Host) nameOf(ctx context.Context) func(int64) string {
	return func(id int64) string {
		if u, err := h.st.GetUser(ctx, id); err == nil {
			return u.DisplayName
		}
		return strconv.FormatInt(id, 10)
	}
}

// Tap passes everything on to the real pusher and hands new messages to the host.
type Tap struct {
	Next interface {
		ToUsers(userIDs []int64, frame *amv1.ServerFrame, exceptConn uint64)
		CloseSession(sessionID int64)
	}
	mu   sync.RWMutex
	host *Host
}

// SetHost connects the tap once the host exists.
func (t *Tap) SetHost(h *Host) {
	t.mu.Lock()
	t.host = h
	t.mu.Unlock()
}

func (t *Tap) ToUsers(userIDs []int64, frame *amv1.ServerFrame, exceptConn uint64) {
	t.Next.ToUsers(userIDs, frame, exceptConn)
	if ev := frame.GetEvent().GetEvent(); ev != nil {
		t.mu.RLock()
		h := t.host
		t.mu.RUnlock()
		if h != nil {
			h.Deliver(userIDs, ev)
		}
	}
}

func (t *Tap) CloseSession(sessionID int64) { t.Next.CloseSession(sessionID) }

// ---- actions out ----

var errUnsupported = errors.New("AM 不支持这个接口")

type params map[string]json.RawMessage

func (p params) int(k string) int64 {
	raw := p[k]
	var n json.Number
	if json.Unmarshal(raw, &n) == nil {
		v, _ := n.Int64()
		return v
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		v, _ := strconv.ParseInt(s, 10, 64)
		return v
	}
	return 0
}

func (p params) str(k string) string {
	var s string
	_ = json.Unmarshal(p[k], &s)
	return s
}

func (p params) bool(k string) bool {
	var v bool
	_ = json.Unmarshal(p[k], &v)
	return v
}

func (h *Host) call(ctx context.Context, b *bot, action string, raw json.RawMessage) (any, error) {
	var p params
	_ = json.Unmarshal(raw, &p)
	if p == nil {
		p = params{}
	}
	ai, err := h.st.GetUser(ctx, b.ai)
	if err != nil {
		return nil, err
	}
	action = strings.TrimSuffix(strings.TrimSuffix(action, "_async"), "_rate_limited")
	switch action {
	case "send_msg", "send_group_msg", "send_private_msg":
		kind := p.str("message_type")
		if action == "send_group_msg" || (kind == "" && p.int("group_id") != 0) {
			kind = "group"
		}
		if action == "send_private_msg" {
			kind = "private"
		}
		convID, err := h.target(ctx, ai, kind, p.int("group_id"), p.int("user_id"))
		if err != nil {
			return nil, err
		}
		segs, err := ParseMessage(p["message"], p.bool("auto_escape"))
		if err != nil {
			return nil, err
		}
		id, err := h.send(ctx, b, ai, convID, segs)
		if err != nil {
			return nil, err
		}
		return map[string]any{"message_id": id}, nil
	case "send_group_forward_msg", "send_private_forward_msg", "send_forward_msg":
		kind := "group"
		if action == "send_private_forward_msg" || (action == "send_forward_msg" && p.int("group_id") == 0) {
			kind = "private"
		}
		convID, err := h.target(ctx, ai, kind, p.int("group_id"), p.int("user_id"))
		if err != nil {
			return nil, err
		}
		var nodes []struct {
			Data struct {
				Content json.RawMessage `json:"content"`
			} `json:"data"`
		}
		if err := json.Unmarshal(p["messages"], &nodes); err != nil {
			return nil, err
		}
		var last int64
		for _, n := range nodes {
			segs, err := ParseMessage(n.Data.Content, false)
			if err != nil || len(segs) == 0 {
				continue
			}
			if last, err = h.send(ctx, b, ai, convID, segs); err != nil {
				return nil, err
			}
		}
		return map[string]any{"message_id": last, "forward_id": strconv.FormatInt(last, 10)}, nil
	case "get_msg":
		return h.getMsg(ctx, b, ai, p.int("message_id"))
	case "get_login_info":
		return map[string]any{"user_id": ai.ID, "nickname": ai.DisplayName}, nil
	case "get_stranger_info":
		u, err := h.st.GetUser(ctx, p.int("user_id"))
		if err != nil {
			return nil, errors.New("没有这个人")
		}
		return map[string]any{"user_id": u.ID, "nickname": u.DisplayName, "sex": "unknown", "age": 0}, nil
	case "get_friend_list":
		return []any{}, nil
	case "get_group_list":
		convs, err := h.st.ListConvsForUser(ctx, ai.ID)
		if err != nil {
			return nil, err
		}
		out := []any{}
		for _, c := range convs {
			if c.Kind == int16(amv1.ConvKind_CONV_KIND_GROUP) && !c.Dissolved {
				out = append(out, h.groupInfo(ctx, &c.Conversation))
			}
		}
		return out, nil
	case "get_group_info":
		c, err := h.st.GetConvForUser(ctx, p.int("group_id"), ai.ID)
		if err != nil {
			return nil, errors.New("不在这个频道里")
		}
		return h.groupInfo(ctx, &c.Conversation), nil
	case "get_group_member_info":
		gid, uid := p.int("group_id"), p.int("user_id")
		if _, err := h.st.GetConvForUser(ctx, gid, ai.ID); err != nil {
			return nil, errors.New("不在这个频道里")
		}
		m, err := h.st.GetMember(ctx, gid, uid)
		if err != nil {
			return nil, errors.New("这个人不在频道里")
		}
		return h.memberInfo(ctx, gid, m), nil
	case "get_group_member_list":
		gid := p.int("group_id")
		if _, err := h.st.GetConvForUser(ctx, gid, ai.ID); err != nil {
			return nil, errors.New("不在这个频道里")
		}
		roles, err := h.st.MemberRoles(ctx, []int64{gid})
		if err != nil {
			return nil, err
		}
		out := []any{}
		for _, r := range roles[gid] {
			out = append(out, h.memberInfo(ctx, gid, &store.Member{ConvID: gid, UserID: r.UserID, Role: r.Role}))
		}
		return out, nil
	case "get_status":
		return map[string]any{"online": true, "good": true}, nil
	case "get_version_info":
		return map[string]any{"app_name": "AM", "app_version": "1", "protocol_version": "v11"}, nil
	case "can_send_image":
		return map[string]any{"yes": true}, nil
	case "can_send_record":
		return map[string]any{"yes": false}, nil
	case "get_image":
		id, _ := strconv.ParseInt(strings.TrimSuffix(p.str("file"), ".image"), 10, 64)
		f, err := h.md.Open(ctx, ai, id, false)
		if err != nil {
			return nil, errors.New("没有这张图")
		}
		return map[string]any{"file": f.Path}, nil
	}
	return nil, fmt.Errorf("%w：%s", errUnsupported, action)
}

func (h *Host) groupInfo(ctx context.Context, c *store.Conversation) map[string]any {
	n, _ := h.st.CountMembers(ctx, c.ID)
	return map[string]any{"group_id": c.ID, "group_name": c.Name, "member_count": n, "max_member_count": 0}
}

func (h *Host) memberInfo(ctx context.Context, gid int64, m *store.Member) map[string]any {
	name := h.nameOf(ctx)(m.UserID)
	return map[string]any{"group_id": gid, "user_id": m.UserID, "nickname": name, "card": "", "sex": "unknown", "age": 0,
		"area": "", "join_time": m.JoinedAt / 1000, "last_sent_time": 0, "level": "", "role": Role(amv1.MemberRole(m.Role)),
		"unfriendly": false, "title": "", "title_expire_time": 0, "card_changeable": false}
}

// target is the conversation a send goes to: a channel the AI is in, or a DM with someone.
func (h *Host) target(ctx context.Context, ai *store.User, kind string, groupID, userID int64) (int64, error) {
	if kind == "group" {
		c, err := h.st.GetConvForUser(ctx, groupID, ai.ID)
		if err != nil || c.Kind != int16(amv1.ConvKind_CONV_KIND_GROUP) {
			return 0, errors.New("不在这个频道里")
		}
		return c.ID, nil
	}
	if userID == 0 {
		return 0, errors.New("缺 user_id")
	}
	c, err := h.conv.OpenDM(ctx, ai, userID)
	if err != nil {
		return 0, err
	}
	return c.GetId(), nil
}

// send posts a plugin's message as the AI: the text (with @ and reply), then each picture.
func (h *Host) send(ctx context.Context, b *bot, ai *store.User, convID int64, segs []Segment) (int64, error) {
	o := Plan(segs, h.nameOf(ctx))
	if len(o.Dropped) > 0 {
		b.logf("AM can't show %s; left out", strings.Join(o.Dropped, ", "))
	}
	var last int64
	if o.Text != "" {
		ev, err := h.msg.Send(ctx, ai, &amv1.SendRequest{ConvId: convID, ClientMsgId: "plugin-" + randomToken(),
			Body: &amv1.SendRequest_Text{Text: &amv1.TextMsg{Text: o.Text, Mentions: o.Mentions, ReplyTo: o.ReplyTo}}}, 0)
		if err != nil {
			return 0, err
		}
		last = ev.GetEventId()
	}
	for _, src := range o.Images {
		data, name, err := h.imageBytes(ctx, src)
		if err != nil {
			b.logf("picture not sent: %v", err)
			continue
		}
		m, err := h.md.Upload(ctx, ai.ID, name, strings.NewReader(string(data)))
		if err != nil {
			b.logf("picture not sent: %v", err)
			continue
		}
		ev, err := h.msg.Send(ctx, ai, &amv1.SendRequest{ConvId: convID, ClientMsgId: "plugin-" + randomToken(),
			Body: &amv1.SendRequest_Image{Image: &amv1.ImageMsg{MediaId: m.ID}}}, 0)
		if err != nil {
			return last, err
		}
		last = ev.GetEventId()
	}
	if last == 0 {
		return 0, errors.New("消息是空的")
	}
	return last, nil
}

var httpClient = &http.Client{Timeout: 60 * time.Second}

func (h *Host) imageBytes(ctx context.Context, src string) ([]byte, string, error) {
	switch {
	case strings.HasPrefix(src, "base64://"):
		b, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(src, "base64://"))
		return b, "plugin.png", err
	case strings.HasPrefix(src, "http://"), strings.HasPrefix(src, "https://"):
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, src, nil)
		if err != nil {
			return nil, "", err
		}
		resp, err := httpClient.Do(req)
		if err != nil {
			return nil, "", err
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return nil, "", fmt.Errorf("HTTP %d", resp.StatusCode)
		}
		b, err := io.ReadAll(io.LimitReader(resp.Body, maxImageBytes+1))
		if len(b) > maxImageBytes {
			return nil, "", errors.New("图片太大")
		}
		return b, "plugin" + filepath.Ext(req.URL.Path), err
	case strings.HasPrefix(src, "file://"):
		p := strings.TrimPrefix(src, "file://")
		if len(p) > 2 && p[0] == '/' && p[2] == ':' { // file:///C:/x on Windows
			p = p[1:]
		}
		st, err := os.Stat(p)
		if err != nil {
			return nil, "", err
		}
		if st.Size() > maxImageBytes {
			return nil, "", errors.New("图片太大")
		}
		b, err := os.ReadFile(p)
		return b, filepath.Base(p), err
	}
	return nil, "", fmt.Errorf("不认识的图片地址 %.40s", src)
}

func (h *Host) getMsg(ctx context.Context, b *bot, ai *store.User, id int64) (any, error) {
	row, err := h.st.GetEvent(ctx, id)
	if err != nil {
		return nil, errors.New("没有这条消息")
	}
	if _, err := h.st.GetConvForUser(ctx, row.ConvID, ai.ID); err != nil {
		return nil, errors.New("没有这条消息")
	}
	ev, err := message.ToProto(row, ai.ID)
	if err != nil {
		return nil, err
	}
	c, err := h.st.GetConvForUser(ctx, row.ConvID, ai.ID)
	if err != nil {
		return nil, err
	}
	in := EventInfo{SelfID: ai.ID, Group: c.Kind == int16(amv1.ConvKind_CONV_KIND_GROUP), NameOf: h.nameOf(ctx),
		ImageURL: func(m int64) string { return h.mediaURL(b, m) }}
	if u, err := h.st.GetUser(ctx, ev.GetSenderId()); err == nil {
		in.Sender = Sender{ID: u.ID, Name: u.DisplayName, Role: "member"}
	}
	out, ok := MessageEvent(ev, in)
	if !ok {
		return nil, errors.New("这条不是消息")
	}
	return map[string]any{"time": out["time"], "message_type": out["message_type"], "message_id": id, "real_id": id,
		"sender": out["sender"], "message": out["message"]}, nil
}
