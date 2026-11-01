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
)

// AI plugins (docs/plugins.md): upload, admin approval, settings, and the
// OneBot v11 endpoint, with this test playing NoneBot.
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
			var m map[string]any
			if json.Unmarshal(data, &m) == nil {
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

func testPlugins(t *testing.T, a *app.App, base string) {
	ctx := ctxT(t)
	us := newServerUsers(t, a, base, "admin", "bob", "carol")
	admin, bob, carol := us[0], us[1], us[2]
	host := a.Plugins.Host()

	if !must(bob.cli.ServerInfo(ctx)).Plugins {
		t.Fatal("server says plugins are off")
	}
	ai := must(bob.cli.CreateAI(ctx, "小鱼")).User

	// Upload: a folder with one plugin (and litter). Bob isn't a site admin: it waits.
	zipData := pluginZip(t, map[string]string{"hello/__init__.py": pluginInit, "hello/__pycache__/x.pyc": "junk"})
	up := must(bob.cli.Upload(ctx, "hello.zip", bytes.NewReader(zipData)))
	_, err := carol.cli.UploadPlugins(ctx, ai.Id, up.Id)
	wantCode(t, err, "user_not_found")
	res := must(bob.cli.UploadPlugins(ctx, ai.Id, up.Id))
	if len(res.Plugins) != 1 {
		t.Fatalf("uploaded %+v", res.Plugins)
	}
	p := res.Plugins[0]
	if p.Dir != "hello" || p.Name != "打招呼" || p.Status != "pending" || !p.Enabled || strings.Join(p.Commands, ",") != "hi,你好" {
		t.Fatalf("plugin %+v", p)
	}
	keys := map[string]*amv1.PluginConfigItem{}
	for _, c := range p.ConfigItems {
		keys[c.Key] = c
	}
	if keys["hello_text"].GetDefaultJson() != `"你好"` || keys["hello_times"].GetType() != "int" || !keys["hello_api_key"].GetSecret() {
		t.Fatalf("settings %+v", p.ConfigItems)
	}
	bad := must(bob.cli.Upload(ctx, "bad.zip", bytes.NewReader(pluginZip(t, map[string]string{"../x/__init__.py": ""}))))
	_, err = bob.cli.UploadPlugins(ctx, ai.Id, bad.Id)
	wantCode(t, err, "bad_plugin")
	if host.Token(ai.Id) != "" {
		t.Fatal("a pending plugin runs")
	}

	// Settings: checked against what the plugin reads; secrets are never sent back.
	_, err = bob.cli.UpdatePlugin(ctx, ai.Id, p.Id, nil, `{"hello_times":"many"}`)
	wantCode(t, err, "invalid_plugin_config")
	_, err = bob.cli.UpdatePlugin(ctx, ai.Id, p.Id, nil, `{"superusers":["1"]}`)
	wantCode(t, err, "invalid_plugin_config")
	p = must(bob.cli.UpdatePlugin(ctx, ai.Id, p.Id, nil, `{"hello_text":"嗨","hello_times":2,"hello_api_key":"sk-123"}`))
	if p.ConfigJson != `{"hello_text":"嗨","hello_times":2}` || strings.Join(p.SecretsSet, ",") != "hello_api_key" {
		t.Fatalf("settings view %s %v", p.ConfigJson, p.SecretsSet)
	}

	// The admin reads it in the panel and approves: NoneBot (this test) may connect.
	pc := panelFor(t, a)
	var st struct {
		Stats map[string]int64 `json:"stats"`
	}
	pc.do("GET", "/api/status", nil, &st)
	if st.Stats["plugins_pending"] != 1 {
		t.Fatalf("pending badge %v", st.Stats)
	}
	var pl struct {
		Items []struct {
			ID       string   `json:"id"`
			AIName   string   `json:"ai_name"`
			Owner    string   `json:"owner_name"`
			Requires []string `json:"requires"`
		} `json:"items"`
	}
	pc.do("GET", "/api/plugins?status=pending", nil, &pl)
	if len(pl.Items) != 1 || pl.Items[0].AIName != "小鱼" || pl.Items[0].Owner != "bob" || pl.Items[0].ID != strconv.FormatInt(p.Id, 10) {
		t.Fatalf("panel list %+v", pl)
	}
	var files struct {
		Files []struct{ Path string } `json:"files"`
	}
	pc.do("GET", "/api/plugins/"+pl.Items[0].ID+"/files", nil, &files)
	if len(files.Files) != 1 || files.Files[0].Path != "__init__.py" {
		t.Fatalf("files %+v", files)
	}
	var file struct{ Text string }
	pc.do("GET", "/api/plugins/"+pl.Items[0].ID+"/files?path=__init__.py", nil, &file)
	if !strings.Contains(file.Text, "打招呼") {
		t.Fatalf("file %q", file.Text)
	}
	if code := pc.do("GET", "/api/plugins/"+pl.Items[0].ID+"/files?path=../../config.toml", nil, nil); code != 404 {
		t.Fatalf("reading outside the plugin: %d", code)
	}
	if code := pc.do("POST", "/api/plugins/"+pl.Items[0].ID+"/decide", map[string]any{"approve": true}, nil); code != 200 {
		t.Fatalf("approve: %d", code)
	}
	waitFor(t, "the host", func() bool { return host.Token(ai.Id) != "" })
	if l := must(bob.cli.ListPlugins(ctx, ai.Id)); l.Plugins[0].Status != "approved" || l.HostState != "starting" {
		t.Fatalf("after approval: %s %s", l.Plugins[0].Status, l.HostState)
	}
	bot := dialBot(t, host.Addr(), ai.Id, host.Token(ai.Id))
	bot.next("lifecycle", func(m map[string]any) bool { return m["meta_event_type"] == "lifecycle" && num(m["self_id"]) == ai.Id })
	waitFor(t, "running", func() bool { return must(bob.cli.ListPlugins(ctx, ai.Id)).HostState == "running" })
	if info := bot.call("get_login_info", nil); num(info["data"].(map[string]any)["user_id"]) != ai.Id {
		t.Fatalf("login info %v", info)
	}

	// A DM to the AI reaches the plugin as a private message; its reply comes from the AI.
	bobWS := must(bob.cli.Connect(ctx))
	defer bobWS.Close()
	dm := must(bob.cli.OpenDM(ctx, ai.Id))
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
		return f.GetEvent().GetEvent().GetSenderId() == ai.Id
	}).GetEvent().GetEvent()
	if got.GetText().GetText() != "嗨" || got.GetText().GetReplyTo() != sent.EventId || got.GetConvId() != dm.Id {
		t.Fatalf("reply %+v", got)
	}

	// In a channel: a group message with an @, and a picture back.
	ch := must(bob.cli.CreateGroup(ctx, "开黑", carol.me.Id, ai.Id))
	carolWS := must(carol.cli.Connect(ctx))
	defer carolWS.Close()
	must(carolWS.SendText(ctx, ch.Id, "小鱼看这里"))
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
		return f.GetEvent().GetEvent().GetText() != nil && f.GetEvent().GetEvent().GetSenderId() == ai.Id
	})
	if tx := text.GetEvent().GetEvent().GetText(); tx.GetText() != "@carol 给你看" || len(tx.GetMentions()) != 1 || tx.GetMentions()[0] != carol.me.Id {
		t.Fatalf("text %+v", tx)
	}
	waitPush(t, carolWS, "picture", func(f *amv1.ServerFrame) bool { return f.GetEvent().GetEvent().GetImage() != nil })
	if r := bot.call("send_group_msg", map[string]any{"group_id": 999, "message": "x"}); r["status"] != "failed" {
		t.Fatal("sent to a channel the AI isn't in")
	}
	if r := bot.call("set_group_kick", map[string]any{"group_id": ch.Id, "user_id": carol.me.Id}); num(r["retcode"]) != 1404 {
		t.Fatalf("unsupported action: %v", r)
	}
	members := bot.call("get_group_member_list", map[string]any{"group_id": ch.Id})["data"].([]any)
	if len(members) != 3 {
		t.Fatalf("members %v", members)
	}

	// A new version waits for the admin again (and stops running); the owner's
	// upload as a site admin counts as approved.
	v2 := must(bob.cli.Upload(ctx, "hello2.zip", bytes.NewReader(pluginZip(t, map[string]string{"hello/__init__.py": pluginInit + "\n# v2\n"}))))
	if p2 := must(bob.cli.UploadPlugins(ctx, ai.Id, v2.Id)).Plugins[0]; p2.Id != p.Id || p2.Status != "pending" || p2.ConfigJson != p.ConfigJson {
		t.Fatalf("new version %+v", p2)
	}
	waitFor(t, "stopped", func() bool { return host.Token(ai.Id) == "" })
	if n := must(a.Plugins.Pending(ctx)); n != 1 {
		t.Fatalf("pending %d", n)
	}
	adminAI := must(admin.cli.CreateAI(ctx, "管家")).User
	up = must(admin.cli.Upload(ctx, "hello.zip", bytes.NewReader(zipData)))
	if p3 := must(admin.cli.UploadPlugins(ctx, adminAI.Id, up.Id)).Plugins[0]; p3.Status != "approved" {
		t.Fatalf("admin's own upload: %s", p3.Status)
	}
	waitFor(t, "admin's AI running", func() bool { return host.Token(adminAI.Id) != "" })

	// Stopped from the panel (reject), with the reason the owner sees.
	adminPlugin := must(admin.cli.ListPlugins(ctx, adminAI.Id)).Plugins[0]
	pc.do("POST", "/api/plugins/"+strconv.FormatInt(adminPlugin.Id, 10)+"/decide", map[string]any{"approve": false, "reason": "先停一下"}, nil)
	waitFor(t, "stopped by the panel", func() bool { return host.Token(adminAI.Id) == "" })
	if p := must(admin.cli.ListPlugins(ctx, adminAI.Id)).Plugins[0]; p.Status != "rejected" || p.RejectReason != "先停一下" {
		t.Fatalf("rejected %+v", p)
	}
	pc.do("POST", "/api/plugins/"+strconv.FormatInt(adminPlugin.Id, 10)+"/decide", map[string]any{"approve": true}, nil)
	waitFor(t, "running again", func() bool { return host.Token(adminAI.Id) != "" })

	// Turned off, deleted.
	off := false
	if p := must(admin.cli.UpdatePlugin(ctx, adminAI.Id, must(admin.cli.ListPlugins(ctx, adminAI.Id)).Plugins[0].Id, &off, "")); p.Enabled {
		t.Fatal("still enabled")
	}
	waitFor(t, "turned off", func() bool { return host.Token(adminAI.Id) == "" })
	if err := bob.cli.DeletePlugin(ctx, ai.Id, p.Id); err != nil {
		t.Fatal(err)
	}
	if l := must(bob.cli.ListPlugins(ctx, ai.Id)); len(l.Plugins) != 0 {
		t.Fatal("not deleted")
	}
	if files, err := a.Plugins.Files(ctx, p.Id); err == nil {
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
