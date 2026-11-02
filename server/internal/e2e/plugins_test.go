package e2e

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/admin"
	"github.com/OzakiJUN/am/server/internal/app"
	"github.com/OzakiJUN/am/server/internal/config"
	"github.com/OzakiJUN/am/server/internal/logx"
	"github.com/OzakiJUN/am/server/internal/store"
)

// Plugins on the built-in bot (docs/plugins.md): uploaded in the admin
// panel, settings, the OneBot v11 endpoint (this test plays NoneBot), and
// the AIs' old plugins retired.
func TestPlugins(t *testing.T) {
	forEachDB(t, testPlugins, func(c *config.Config) { c.Plugins.NoSpawn = true })
}

const pluginInit = `
from nonebot import get_driver, on_command
from nonebot.plugin import PluginMetadata

__plugin_meta__ = PluginMetadata(name="打招呼", description="回一句你好", usage="/hi")

_cfg = get_driver().config
GREETING = getattr(_cfg, "hello_text", "你好")
TIMES = int(getattr(_cfg, "hello_times", 1))
KEY = getattr(_cfg, "hello_api_key", "")

hi = on_command("hi", aliases={"你好"})
`

func pluginZip(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, body := range files {
		w := must(zw.Create(name))
		_, _ = w.Write([]byte(body))
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// fakeBot is NoneBot's side of the OneBot connection.
type fakeBot struct {
	t    *testing.T
	ws   *websocket.Conn
	in   chan map[string]any
	echo int
}

func dialBot(t *testing.T, addr string, ai int64, token string) *fakeBot {
	t.Helper()
	ctx := ctxT(t)
	url := "ws://" + addr + "/onebot/" + strconv.FormatInt(ai, 10)
	if _, resp, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": {"Bearer wrong"}}}); err == nil || resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("wrong token accepted: %v", err)
	}
	ws, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": {"Bearer " + token}}})
	if err != nil {
		t.Fatal(err)
	}
	ws.SetReadLimit(1 << 24)
	b := &fakeBot{t: t, ws: ws, in: make(chan map[string]any, 64)}
	go func() {
		defer close(b.in)
		for {
			_, data, err := ws.Read(context.Background())
			if err != nil {
				return
			}
			// Numbers stay exact (ids don't fit in a float64).
			var m map[string]any
			d := json.NewDecoder(bytes.NewReader(data))
			d.UseNumber()
			if d.Decode(&m) == nil {
				b.in <- m
			}
		}
	}()
	t.Cleanup(func() { _ = ws.CloseNow() })
	return b
}

// next waits for a frame matching pred.
func (b *fakeBot) next(what string, pred func(map[string]any) bool) map[string]any {
	b.t.Helper()
	timeout := time.After(5 * time.Second)
	for {
		select {
		case m, ok := <-b.in:
			if !ok {
				b.t.Fatalf("connection closed while waiting for %s", what)
			}
			if pred(m) {
				return m
			}
		case <-timeout:
			b.t.Fatalf("timed out waiting for %s", what)
		}
	}
}

// call runs a OneBot action and returns its response.
func (b *fakeBot) call(action string, params map[string]any) map[string]any {
	b.t.Helper()
	b.echo++
	echo := "e" + strconv.Itoa(b.echo)
	data, _ := json.Marshal(map[string]any{"action": action, "params": params, "echo": echo})
	if err := b.ws.Write(ctxT(b.t), websocket.MessageText, data); err != nil {
		b.t.Fatal(err)
	}
	return b.next(action+" response", func(m map[string]any) bool { return m["echo"] == echo })
}

func num(v any) int64 {
	switch x := v.(type) {
	case json.Number:
		n, _ := x.Int64()
		return n
	case float64:
		return int64(x)
	case string:
		n, _ := strconv.ParseInt(x, 10, 64)
		return n
	}
	return 0
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	for end := time.Now().Add(5 * time.Second); time.Now().Before(end); time.Sleep(20 * time.Millisecond) {
		if cond() {
			return
		}
	}
	t.Fatalf("timed out waiting for %s", what)
}

// panelPlugin is a plugin as the panel sends it.
type panelPlugin struct {
	ID          string         `json:"id"`
	Dir         string         `json:"dir"`
	Name        string         `json:"name"`
	Commands    []string       `json:"commands"`
	Enabled     bool           `json:"enabled"`
	Values      map[string]any `json:"values"`
	SecretsSet  []string       `json:"secrets_set"`
	ConfigItems []struct {
		Key     string `json:"key"`
		Type    string `json:"type"`
		Default any    `json:"default"`
		Secret  bool   `json:"secret"`
	} `json:"config_items"`
	Code string `json:"code"`
}

type panelPlugins struct {
	Enabled   bool          `json:"enabled"`
	Items     []panelPlugin `json:"items"`
	HostState string        `json:"host_state"`
	BotName   string        `json:"bot_name"`
	Code      string        `json:"code"`
}

func testPlugins(t *testing.T, a *app.App, base string) {
	ctx := ctxT(t)
	us := newServerUsers(t, a, base, "admin", "bob", "carol")
	bob, carol := us[1], us[2]
	host := a.Plugins.Host()
	botID := a.Helper.Bot().ID
	pc := panelFor(t, a)

	if !must(bob.cli.ServerInfo(ctx)).Plugins {
		t.Fatal("server says plugins are off")
	}

	// Upload in the panel: a folder with one plugin (and litter). It runs as the bot at once.
	zipData := pluginZip(t, map[string]string{"hello/__init__.py": pluginInit, "hello/__pycache__/x.pyc": "junk"})
	var up panelPlugins
	if code := pc.do("POST", "/api/plugins/upload", map[string]any{"data": base64.StdEncoding.EncodeToString(zipData)}, &up); code != 200 || len(up.Items) != 1 {
		t.Fatalf("upload %d %+v", code, up)
	}
	p := up.Items[0]
	if p.Dir != "hello" || p.Name != "打招呼" || !p.Enabled || strings.Join(p.Commands, ",") != "hi,你好" {
		t.Fatalf("plugin %+v", p)
	}
	keys := map[string]int{}
	for i, c := range p.ConfigItems {
		keys[c.Key] = i
	}
	if c := p.ConfigItems; c[keys["hello_text"]].Default != "你好" || c[keys["hello_times"]].Type != "int" || !c[keys["hello_api_key"]].Secret {
		t.Fatalf("settings %+v", p.ConfigItems)
	}
	var bad panelPlugins
	pc.do("POST", "/api/plugins/upload", map[string]any{"data": base64.StdEncoding.EncodeToString(pluginZip(t, map[string]string{"../x/__init__.py": ""}))}, &bad)
	if bad.Code != "bad_plugin" {
		t.Fatalf("bad zip: %+v", bad)
	}
	waitFor(t, "the host", func() bool { return host.Token(botID) != "" })

	// Settings: checked against what the plugin reads; secrets are never sent back.
	patch := func(cfg string) panelPlugin {
		var out panelPlugin
		pc.do("PUT", "/api/plugins/"+p.ID, map[string]any{"config_patch": cfg}, &out)
		return out
	}
	if r := patch(`{"hello_times":"many"}`); r.Code != "invalid_plugin_config" {
		t.Fatalf("bad setting %+v", r)
	}
	if r := patch(`{"superusers":["1"]}`); r.Code != "invalid_plugin_config" {
		t.Fatalf("NoneBot setting %+v", r)
	}
	if r := patch(`{"hello_text":"嗨","hello_times":2,"hello_api_key":"sk-123"}`); r.Values["hello_text"] != "嗨" || r.Values["hello_api_key"] != nil || strings.Join(r.SecretsSet, ",") != "hello_api_key" {
		t.Fatalf("settings view %+v", r)
	}

	// Reading the files.
	var files struct {
		Files []struct{ Path string } `json:"files"`
	}
	pc.do("GET", "/api/plugins/"+p.ID+"/files", nil, &files)
	if len(files.Files) != 1 || files.Files[0].Path != "__init__.py" {
		t.Fatalf("files %+v", files)
	}
	var file struct{ Text string }
	pc.do("GET", "/api/plugins/"+p.ID+"/files?path=__init__.py", nil, &file)
	if !strings.Contains(file.Text, "打招呼") {
		t.Fatalf("file %q", file.Text)
	}
	if code := pc.do("GET", "/api/plugins/"+p.ID+"/files?path=../../config.toml", nil, nil); code != 404 {
		t.Fatalf("reading outside the plugin: %d", code)
	}

	// NoneBot (this test) connects as the bot.
	bot := dialBot(t, host.Addr(), botID, host.Token(botID))
	bot.next("lifecycle", func(m map[string]any) bool { return m["meta_event_type"] == "lifecycle" && num(m["self_id"]) == botID })
	list := func() panelPlugins {
		var l panelPlugins
		pc.do("GET", "/api/plugins", nil, &l)
		return l
	}
	waitFor(t, "running", func() bool { return list().HostState == "running" })
	if l := list(); len(l.Items) != 1 || l.BotName == "" {
		t.Fatalf("panel list %+v", l)
	}
	if info := bot.call("get_login_info", nil); num(info["data"].(map[string]any)["user_id"]) != botID {
		t.Fatalf("login info %v", info)
	}
	// Its commands are the bot's: listed for AIs and 指令查询.
	if !slices.Contains(must(bob.cli.ServerInfo(ctx)).Commands, "hi") {
		t.Fatal("ServerInfo.commands misses the plugin's")
	}
	found := false
	for _, c := range must(bob.cli.HelperCommands(ctx)).Commands {
		found = found || c.Name == "hi"
	}
	if !found {
		t.Fatal("helper commands miss the plugin's")
	}

	// A DM to the bot reaches the plugin (the bot itself keeps quiet); the reply comes from the bot.
	bobWS := must(bob.cli.Connect(ctx))
	defer bobWS.Close()
	dm := must(bob.cli.OpenDM(ctx, botID))
	sent := must(bobWS.SendText(ctx, dm.Id, "/hi"))
	ev := bot.next("private message", func(m map[string]any) bool { return m["post_type"] == "message" })
	if ev["message_type"] != "private" || ev["raw_message"] != "/hi" || num(ev["user_id"]) != bob.me.Id || num(ev["message_id"]) != sent.EventId {
		t.Fatalf("event %v", ev)
	}
	r := bot.call("send_private_msg", map[string]any{"user_id": bob.me.Id, "message": "嗨 [CQ:reply,id=" + strconv.FormatInt(sent.EventId, 10) + "]"})
	if r["status"] != "ok" || num(r["data"].(map[string]any)["message_id"]) == 0 {
		t.Fatalf("send %v", r)
	}
	got := waitPush(t, bobWS, "the plugin's reply", func(f *amv1.ServerFrame) bool {
		return f.GetEvent().GetEvent().GetSenderId() == botID
	}).GetEvent().GetEvent()
	if got.GetText().GetText() != "嗨" || got.GetText().GetReplyTo() != sent.EventId || got.GetConvId() != dm.Id {
		t.Fatalf("reply %+v (the bot answered instead of the plugin?)", got)
	}

	// In a channel (the bot is in every one): a group message, and a picture back.
	ch := must(bob.cli.CreateGroup(ctx, "开黑", carol.me.Id))
	carolWS := must(carol.cli.Connect(ctx))
	defer carolWS.Close()
	must(carolWS.SendText(ctx, ch.Id, "看这里"))
	ev = bot.next("group message", func(m map[string]any) bool { return m["message_type"] == "group" })
	if num(ev["group_id"]) != ch.Id || ev["sender"].(map[string]any)["role"] != "member" {
		t.Fatalf("group event %v", ev)
	}
	png := base64.StdEncoding.EncodeToString(encodePNG(testImage(8, 8)))
	r = bot.call("send_group_msg", map[string]any{"group_id": ch.Id, "message": []map[string]any{
		{"type": "at", "data": map[string]any{"qq": strconv.FormatInt(carol.me.Id, 10)}},
		{"type": "text", "data": map[string]any{"text": "给你看"}},
		{"type": "image", "data": map[string]any{"file": "base64://" + png}},
	}})
	if r["status"] != "ok" {
		t.Fatalf("group send %v", r)
	}
	text := waitPush(t, carolWS, "text", func(f *amv1.ServerFrame) bool {
		return f.GetEvent().GetEvent().GetText() != nil && f.GetEvent().GetEvent().GetSenderId() == botID
	})
	if tx := text.GetEvent().GetEvent().GetText(); tx.GetText() != "@carol 给你看" || len(tx.GetMentions()) != 1 || tx.GetMentions()[0] != carol.me.Id {
		t.Fatalf("text %+v", tx)
	}
	waitPush(t, carolWS, "picture", func(f *amv1.ServerFrame) bool { return f.GetEvent().GetEvent().GetImage() != nil })
	if r := bot.call("send_group_msg", map[string]any{"group_id": 999, "message": "x"}); r["status"] != "failed" {
		t.Fatal("sent to a channel that doesn't exist")
	}
	if r := bot.call("set_group_kick", map[string]any{"group_id": ch.Id, "user_id": carol.me.Id}); num(r["retcode"]) != 1404 {
		t.Fatalf("unsupported action: %v", r)
	}
	members := bot.call("get_group_member_list", map[string]any{"group_id": ch.Id})["data"].([]any)
	if len(members) != 3 { // bob, carol and the bot
		t.Fatalf("members %v", members)
	}

	// A new version replaces the files, keeps the settings and still runs.
	var v2 panelPlugins
	pc.do("POST", "/api/plugins/upload", map[string]any{"data": base64.StdEncoding.EncodeToString(pluginZip(t, map[string]string{"hello/__init__.py": pluginInit + "\n# v2\n"}))}, &v2)
	if len(v2.Items) != 1 || v2.Items[0].ID != p.ID || v2.Items[0].Values["hello_text"] != "嗨" {
		t.Fatalf("new version %+v", v2)
	}
	waitFor(t, "running again", func() bool { return host.Token(botID) != "" })

	// Plugins AIs had before are retired, once.
	ai := must(bob.cli.CreateAI(ctx, "小鱼")).User
	old := &store.AIPlugin{ID: ai.Id + 1, AIID: ai.Id, Dir: "old", Meta: "{}", Status: "approved", Enabled: true, Config: "{}", UploadedBy: bob.me.Id, UploadedAt: 1}
	if err := a.Store.InsertPlugin(ctx, old); err != nil {
		t.Fatal(err)
	}
	if err := a.Plugins.RetireAIPlugins(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Store.GetPlugin(ctx, old.ID); err != nil {
		t.Fatal("retired again (only once)")
	}
	if err := a.Store.SetServerSetting(ctx, "plugins_on_bot", "0"); err != nil {
		t.Fatal(err)
	}
	if err := a.Plugins.RetireAIPlugins(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Store.GetPlugin(ctx, old.ID); err == nil {
		t.Fatal("the AI's plugin is still there")
	}
	if l := list(); len(l.Items) != 1 {
		t.Fatalf("the bot's plugin went too: %+v", l)
	}

	// Turned off, deleted.
	if r := func() panelPlugin {
		var out panelPlugin
		pc.do("PUT", "/api/plugins/"+p.ID, map[string]any{"enabled": false}, &out)
		return out
	}(); r.Enabled {
		t.Fatal("still enabled")
	}
	waitFor(t, "turned off", func() bool { return host.Token(botID) == "" })
	if slices.Contains(must(bob.cli.ServerInfo(ctx)).Commands, "hi") {
		t.Fatal("a turned-off plugin's command is still listed")
	}
	if code := pc.do("DELETE", "/api/plugins/"+p.ID, nil, nil); code != 200 {
		t.Fatalf("delete %d", code)
	}
	if l := list(); len(l.Items) != 0 {
		t.Fatal("not deleted")
	}
	id, _ := strconv.ParseInt(p.ID, 10, 64)
	if files, err := a.Plugins.Files(ctx, id); err == nil {
		t.Fatalf("files still there: %v", files)
	}
}

// panelFor logs into a test admin panel for this app.
func panelFor(t *testing.T, a *app.App) *panelClient {
	t.Helper()
	cfgPath := filepath.Join(t.TempDir(), "config.toml")
	cfg := must(func() (*config.Config, error) { c, _, err := config.Load(cfgPath); return c, err }())
	rt := &fakeRuntime{a: a, cfg: cfg, cfgPath: cfgPath, ring: logx.NewRing(10)}
	const key = "test-admin-key-0123456789"
	srv := httptest.NewServer(admin.New(rt, key, "127.0.0.1:8444", slog.New(slog.NewTextHandler(io.Discard, nil))))
	t.Cleanup(srv.Close)
	jar, _ := cookiejar.New(nil)
	pc := &panelClient{t: t, base: srv.URL, http: &http.Client{Jar: jar}}
	pc.do("GET", "/login?key="+key, nil, nil)
	return pc
}
