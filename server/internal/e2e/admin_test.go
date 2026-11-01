package e2e

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image/png"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/internal/connectcode"
	"github.com/OzakiJUN/am/sdk/go/amclient"
	"github.com/OzakiJUN/am/server/internal/account"
	"github.com/OzakiJUN/am/server/internal/admin"
	"github.com/OzakiJUN/am/server/internal/app"
	"github.com/OzakiJUN/am/server/internal/config"
	"github.com/OzakiJUN/am/server/internal/logx"
	"github.com/OzakiJUN/am/server/internal/supervisor"
)

func TestAdminPanel(t *testing.T) { forEachDB(t, testAdminPanel) }

// fakeRuntime stands in for the supervisor.
type fakeRuntime struct {
	a        *app.App
	cfg      *config.Config
	cfgPath  string
	ring     *logx.Ring
	restarts int
	boot     string
}

func (f *fakeRuntime) Snapshot() admin.Snapshot {
	return admin.Snapshot{
		State: admin.StateRunning, Version: "test", ConfigPath: f.cfgPath, Config: f.cfg, App: f.a,
		Fingerprint: bytes.Repeat([]byte{7}, 32), StartedAt: time.Now(), Logs: f.ring, BootstrapInvite: f.boot,
	}
}
func (f *fakeRuntime) Restart()        { f.restarts++ }
func (f *fakeRuntime) Quit()           {}
func (f *fakeRuntime) ClearBootstrap() {}
func (f *fakeRuntime) SetPublicAddress(addr string) {
	cfg := *f.cfg
	cfg.Server.PublicAddress = addr
	f.cfg = &cfg
	f.a.Account.SetServer(supervisor.ServerMeta(&cfg, "test", bytes.Repeat([]byte{7}, 32)))
}

// panelClient talks to the admin panel's JSON API.
type panelClient struct {
	t    *testing.T
	base string
	http *http.Client
}

func (p *panelClient) do(method, path string, body any, out any) int {
	p.t.Helper()
	var r io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, p.base+path, r)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := p.http.Do(req)
	if err != nil {
		p.t.Fatal(err)
	}
	defer resp.Body.Close()
	if out != nil {
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
			p.t.Fatalf("%s %s: decode: %v", method, path, err)
		}
	}
	return resp.StatusCode
}

func testAdminPanel(t *testing.T, a *app.App, base string) {
	ctx := ctxT(t)
	cfgPath := filepath.Join(t.TempDir(), "config.toml")
	cfg := must(func() (*config.Config, error) { c, _, err := config.Load(cfgPath); return c, err }())
	rt := &fakeRuntime{a: a, cfg: cfg, cfgPath: cfgPath, ring: logx.NewRing(10)}
	const key = "test-admin-key-0123456789"
	srv := httptest.NewServer(admin.New(rt, key, "127.0.0.1:8444", slog.New(slog.NewTextHandler(io.Discard, nil))))
	t.Cleanup(srv.Close)

	jar, _ := cookiejar.New(nil)
	pc := &panelClient{t: t, base: srv.URL, http: &http.Client{Jar: jar}}

	// Not logged in, or with a wrong key: no access.
	if code := pc.do("GET", "/api/status", nil, nil); code != 401 {
		t.Fatalf("status without login: %d", code)
	}
	pc.do("GET", "/login?key=wrong", nil, nil)
	if code := pc.do("GET", "/api/status", nil, nil); code != 401 {
		t.Fatalf("status with wrong key: %d", code)
	}
	// The panel page itself loads without login (it shows the login form).
	if code := pc.do("GET", "/", nil, nil); code != 200 {
		t.Fatalf("index: %d", code)
	}
	// A foreign Host header is refused (DNS rebinding).
	req, _ := http.NewRequest("GET", srv.URL+"/api/ping", nil)
	req.Host = "evil.example"
	if resp := must(http.DefaultClient.Do(req)); resp.StatusCode != 403 {
		t.Fatalf("foreign host: %d", resp.StatusCode)
	}
	// Tray link logs in.
	pc.do("GET", "/login?key="+key, nil, nil)
	var st map[string]any
	if code := pc.do("GET", "/api/status", nil, &st); code != 200 || st["state"] != "running" {
		t.Fatalf("status: %d %v", code, st)
	}
	// Form-encoded writes are refused (only JSON, which needs CORS cross-site).
	reqForm, _ := http.NewRequest("POST", srv.URL+"/api/restart", strings.NewReader("x=1"))
	reqForm.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if resp := must(pc.http.Do(reqForm)); resp.StatusCode != 415 || rt.restarts != 0 {
		t.Fatalf("form post: %d restarts=%d", resp.StatusCode, rt.restarts)
	}

	// Before anyone registered, the panel shows the admin join code with the
	// bootstrap invite in it.
	boot := must(a.Account.EnsureBootstrapInvite(ctx))
	rt.boot = boot
	var cc struct {
		Bootstrap bool `json:"bootstrap"`
		Lan       []struct {
			ServerCode string `json:"server_code"`
			JoinCode   string `json:"join_code"`
			JoinURL    string `json:"join_url"`
		} `json:"lan"`
	}
	pc.do("GET", "/api/connect", nil, &cc)
	local := cc.Lan[len(cc.Lan)-1]
	bj := must(amclient.ParseJoinCode(local.JoinURL)) // the QR URL works too
	if !cc.Bootstrap || bj.Invite != boot || !bytes.Equal(bj.Pin, bytes.Repeat([]byte{7}, 16)) ||
		!strings.HasPrefix(local.JoinURL, cfg.Invites.DownloadURL+"#join=AM1-") {
		t.Fatalf("bootstrap join code: %+v %+v", cc, bj)
	}

	// The server knows its public address: invites come with join codes.
	host := strings.TrimPrefix(base, "http://")
	a.Account.SetServer(account.ServerMeta{Name: "测试服", Version: "test", DownloadURL: cfg.Invites.DownloadURL,
		Join: &connectcode.Join{Address: host, Plain: true}})

	// First account via the bootstrap code is a site admin.
	us := newServerUsers(t, a, base, "owner", "bob")
	owner, bob := us[0], us[1]
	isAdmin := func(id int64) bool { return must(a.Store.GetUser(ctx, id)).IsSiteAdmin }
	if !isAdmin(owner.me.Id) || isAdmin(bob.me.Id) {
		t.Fatal("bootstrap admin flags wrong")
	}
	if info := must(bob.cli.ServerInfo(ctx)); info.Name != "测试服" {
		t.Fatalf("server info: %v", info)
	}

	// Every account got 3 invites automatically, each with a join code.
	bobInv := must(bob.cli.ListInvites(ctx))
	if len(bobInv.Invites) != 3 || bobInv.Invites[0].JoinCode == "" || !strings.Contains(bobInv.Invites[0].JoinUrl, "#join=") {
		t.Fatalf("bob's invites: %v", bobInv)
	}
	// A friend registers with nothing but the join code.
	carolCli, cj := must2(amclient.NewFromJoinCode(bobInv.Invites[0].JoinCode))
	carol := must(carolCli.Register(ctx, &amv1.RegisterRequest{InviteCode: cj.Invite, Username: "carol", Password: "password-carol"}))
	if isAdmin(carol.Me.Id) {
		t.Fatal("carol should not be admin")
	}
	// A client can also build join codes itself from its own server address.
	built := must(carolCli.JoinCodeFor("ABCDEFGH23"))
	if j := must(amclient.ParseJoinCode(built)); j.Address != host || j.Invite != "ABCDEFGH23" {
		t.Fatalf("client-built join code: %+v", j)
	}
	daveCli := amclient.New(base, nil)
	dave := must(daveCli.Register(ctx, &amv1.RegisterRequest{InviteCode: bobInv.Invites[1].Code, Username: "dave", Password: "password-dave"}))
	pc.do("POST", "/api/users/"+itoa(dave.Me.Id)+"/admin", map[string]bool{"admin": true}, nil)

	// The panel cannot create invites any more; it can revoke unused ones.
	if code := pc.do("POST", "/api/invites", map[string]any{"count": 1}, nil); code != 405 && code != 404 {
		t.Fatalf("panel invite creation still works: %d", code)
	}
	spare := bobInv.Invites[2].Code
	if code := pc.do("DELETE", "/api/invites/"+spare, nil, nil); code != 200 {
		t.Fatalf("delete invite: %d", code)
	}
	_, err := amclient.New(base, nil).Register(ctx, &amv1.RegisterRequest{InviteCode: spare, Username: "eve", Password: "password-eve"})
	wantCode(t, err, "invalid_invite")
	if code := pc.do("DELETE", "/api/invites/"+bobInv.Invites[0].Code, nil, nil); code != 404 {
		t.Fatalf("deleting a used invite: %d", code)
	}

	// User list with search.
	var ul struct {
		Users []struct {
			ID       string `json:"id"`
			Username string `json:"username"`
			Banned   bool   `json:"banned"`
		} `json:"users"`
		Total int `json:"total"`
	}
	pc.do("GET", "/api/users", nil, &ul)
	if ul.Total != 4 {
		t.Fatalf("users total %d", ul.Total)
	}
	pc.do("GET", "/api/users?q=CAR", nil, &ul)
	if ul.Total != 1 || ul.Users[0].Username != "carol" {
		t.Fatalf("search: %+v", ul)
	}
	pc.do("GET", "/api/users?q=%25", nil, &ul) // a literal %, not a wildcard
	if ul.Total != 0 {
		t.Fatalf("wildcard search matched %d", ul.Total)
	}
	bobID := bob.me.Id

	// Ban: bob's live connection drops at once and he cannot log in.
	bobWS := must(bob.cli.Connect(ctx))
	if code := pc.do("POST", "/api/users/"+itoa(bobID)+"/ban", map[string]string{"reason": ""}, nil); code != 400 {
		t.Fatalf("ban without reason: %d", code)
	}
	if code := pc.do("POST", "/api/users/"+itoa(bobID)+"/ban", map[string]string{"reason": "挂机器人"}, nil); code != 200 {
		t.Fatalf("ban: %d", code)
	}
	waitClosed(t, bobWS)
	_, err = amclient.New(base, nil).Login(ctx, &amv1.LoginRequest{Username: "bob", Password: "password-bob"})
	wantCode(t, err, "banned")
	pc.do("POST", "/api/users/"+itoa(bobID)+"/unban", nil, nil)
	must(amclient.New(base, nil).Login(ctx, &amv1.LoginRequest{Username: "bob", Password: "password-bob"}))

	// Reset password: old one stops working, the temporary one works.
	var pw struct {
		Password string `json:"password"`
	}
	pc.do("POST", "/api/users/"+itoa(carol.Me.Id)+"/reset-password", nil, &pw)
	if len(pw.Password) != 12 {
		t.Fatalf("temp password %q", pw.Password)
	}
	_, err = amclient.New(base, nil).Login(ctx, &amv1.LoginRequest{Username: "carol", Password: "password-carol"})
	wantCode(t, err, "wrong_credentials")
	must(amclient.New(base, nil).Login(ctx, &amv1.LoginRequest{Username: "carol", Password: pw.Password}))
	// carol's old token was revoked too.
	_, err = carolCli.ListInvites(ctx)
	wantCode(t, err, "unauthorized")

	// Site admin rights from the panel.
	pc.do("POST", "/api/users/"+itoa(bobID)+"/admin", map[string]bool{"admin": true}, nil)
	if !isAdmin(bobID) {
		t.Fatal("bob should be site admin")
	}

	// Evidence: an admin-deleted message shows up with its text.
	ownerWS := must(owner.cli.Connect(ctx))
	dm := must(owner.cli.OpenDM(ctx, bobID))
	msg := must(ownerWS.SendText(ctx, dm.Id, "要被删的话"))
	if err := daveCli.AdminDelete(ctx, msg.EventId, "测试", false); err != nil {
		t.Fatal(err)
	}
	var evl struct {
		Items []struct {
			Text   string `json:"text"`
			Kind   string `json:"kind"`
			Reason string `json:"reason"`
		} `json:"items"`
	}
	pc.do("GET", "/api/evidence", nil, &evl)
	if len(evl.Items) != 1 || evl.Items[0].Text != "要被删的话" || evl.Items[0].Kind != "text" || evl.Items[0].Reason != "测试" {
		t.Fatalf("evidence: %+v", evl)
	}

	// Channel history: private channels too, read-only, never DMs.
	secret := must(owner.cli.CreateGroup(ctx, "秘密基地", bobID))
	struck := must(ownerWS.SendText(ctx, secret.Id, "说错了"))
	must(ownerWS.Strike(ctx, secret.Id, struck.EventId))
	must(ownerWS.SendText(ctx, secret.Id, "频道里的话"))
	chImg := must(owner.cli.Upload(ctx, "a.png", bytes.NewReader(encodePNG(testImage(8, 8)))))
	must(ownerWS.SendImage(ctx, secret.Id, chImg.Id))
	dmImg := must(owner.cli.Upload(ctx, "b.png", bytes.NewReader(encodePNG(testImage(9, 9)))))
	must(ownerWS.SendImage(ctx, dm.Id, dmImg.Id))
	var chl struct {
		Items []struct {
			ID      string `json:"id"`
			Name    string `json:"name"`
			Public  bool   `json:"public"`
			Members int    `json:"members"`
		} `json:"items"`
	}
	pc.do("GET", "/api/channels?q=秘密", nil, &chl)
	if len(chl.Items) != 1 || chl.Items[0].ID != itoa(secret.Id) || chl.Items[0].Public || chl.Items[0].Members != 2 {
		t.Fatalf("channels: %+v", chl)
	}
	var hist struct {
		Items []struct {
			Kind    string `json:"kind"`
			Text    string `json:"text"`
			Struck  bool   `json:"struck"`
			MediaID string `json:"media_id"`
		} `json:"items"`
		Before int64 `json:"before"`
	}
	if code := pc.do("GET", "/api/channels/"+itoa(secret.Id)+"/events", nil, &hist); code != 200 {
		t.Fatalf("channel history: %d", code)
	}
	// created, bob joined, struck text, text, image
	if n := len(hist.Items); n != 5 || hist.Items[1].Text != "owner 邀请 bob 加入了频道" || !hist.Items[2].Struck ||
		hist.Items[3].Text != "频道里的话" || hist.Items[4].Kind != "image" || hist.Before != 0 {
		t.Fatalf("history: %+v", hist)
	}
	if code := pc.do("GET", "/api/media/"+hist.Items[4].MediaID+"?thumb=1", nil, nil); code != 200 {
		t.Fatalf("channel image: %d", code)
	}
	// Paging backwards.
	for i := 0; i < 50; i++ {
		must(ownerWS.SendText(ctx, secret.Id, "刷屏"))
	}
	pc.do("GET", "/api/channels/"+itoa(secret.Id)+"/events", nil, &hist)
	if len(hist.Items) != 50 || hist.Before == 0 {
		t.Fatalf("first page: %d items, before %d", len(hist.Items), hist.Before)
	}
	pc.do("GET", "/api/channels/"+itoa(secret.Id)+"/events?before="+strconv.FormatInt(hist.Before, 10), nil, &hist)
	if len(hist.Items) != 5 || hist.Items[0].Kind != "sys" || hist.Before != 0 {
		t.Fatalf("second page: %+v", hist)
	}
	if code := pc.do("GET", "/api/channels/"+itoa(dm.Id)+"/events", nil, nil); code != 404 {
		t.Fatalf("DM history visible in the panel: %d", code)
	}
	if code := pc.do("GET", "/api/media/"+itoa(dmImg.Id), nil, nil); code != 404 {
		t.Fatalf("DM image visible in the panel: %d", code)
	}

	// Server profile: set in the panel, applies at once, seen by clients.
	if code := pc.do("PUT", "/api/server-profile", map[string]any{"description": "  欢迎来玩  ", "layout_editors": "nobody"}, nil); code != 400 {
		t.Fatalf("bad layout editors: %d", code)
	}
	if code := pc.do("PUT", "/api/server-profile", map[string]any{
		"description": "  欢迎来玩  ", "layout_editors": "everyone", "widget_content_editable": true,
	}, nil); code != 200 {
		t.Fatalf("server profile: %d", code)
	}
	if code := pc.do("PUT", "/api/server-icon", map[string]string{"data": base64.StdEncoding.EncodeToString([]byte("not an image"))}, nil); code != 400 {
		t.Fatalf("bad icon: %d", code)
	}
	icon := base64.StdEncoding.EncodeToString(encodePNG(testImage(600, 300)))
	if code := pc.do("PUT", "/api/server-icon", map[string]string{"data": icon}, nil); code != 200 {
		t.Fatalf("server icon: %d", code)
	}
	sp := must(daveCli.ServerProfile(ctx))
	if sp.Description != "欢迎来玩" || sp.LayoutEditors != amv1.ProfileEditors_PROFILE_EDITORS_EVERYONE ||
		!sp.WidgetContentEditable || sp.MemberCount != 4 || sp.Icon == "" || sp.Icon != must(daveCli.ServerInfo(ctx)).Icon {
		t.Fatalf("server profile: %+v", sp)
	}
	resp := must(http.Get(base + sp.Icon)) // public, no token
	img, err := png.Decode(resp.Body)
	resp.Body.Close()
	if err != nil || img.Bounds().Dx() != 256 || img.Bounds().Dy() != 128 {
		t.Fatalf("server icon: %v %v", err, img)
	}
	pc.do("DELETE", "/api/server-icon", nil, nil)
	if must(daveCli.ServerInfo(ctx)).Icon != "" {
		t.Fatal("icon still set after delete")
	}

	// Audit log has the panel's actions.
	var al struct {
		Items []struct {
			Action  string `json:"action"`
			ActorID string `json:"actor_id"`
		} `json:"items"`
	}
	pc.do("GET", "/api/audit", nil, &al)
	seen := map[string]bool{}
	for _, it := range al.Items {
		seen[it.Action] = true
	}
	for _, want := range []string{"ban", "unban", "password_reset", "site_admin_grant", "invite_delete", "admin_delete", "channel_view",
		"server_profile"} {
		if !seen[want] {
			t.Errorf("audit log missing %s: %+v", want, al.Items)
		}
	}

	// Status counters.
	pc.do("GET", "/api/status", nil, &st)
	stats := st["stats"].(map[string]any)
	if stats["users"].(float64) != 4 || stats["evidence"].(float64) != 1 {
		t.Fatalf("stats: %v", stats)
	}

	// After registration the panel shows the server code (no invite).
	pc.do("GET", "/api/connect", nil, &cc)
	sc := must(amclient.ParseJoinCode(cc.Lan[len(cc.Lan)-1].ServerCode))
	if cc.Bootstrap || sc.Invite != "" || !bytes.Equal(sc.Pin, bytes.Repeat([]byte{7}, 16)) {
		t.Fatalf("server code: %+v %+v", cc, sc)
	}

	// Settings: invalid values are rejected and the file is untouched.
	before := must(os.ReadFile(cfgPath))
	if code := pc.do("PUT", "/api/settings", map[string]any{"values": map[string]any{"limits.max_upload_mb": 0}}, nil); code != 400 {
		t.Fatalf("invalid setting: %d", code)
	}
	if code := pc.do("PUT", "/api/settings", map[string]any{"values": map[string]any{"database.url": "x"}}, nil); code != 400 {
		t.Fatalf("unlisted setting: %d", code)
	}
	if !bytes.Equal(before, must(os.ReadFile(cfgPath))) {
		t.Fatal("config changed by rejected settings")
	}
	if code := pc.do("PUT", "/api/settings", map[string]any{"values": map[string]any{
		"server.public_address": "47.1.2.3:7000", "invites.per_user": 5,
	}}, nil); code != 200 {
		t.Fatalf("settings: %d", code)
	}
	reloaded, _, _ := config.Load(cfgPath)
	if reloaded.Server.PublicAddress != "47.1.2.3:7000" || reloaded.Invites.PerUser != 5 {
		t.Fatalf("settings not saved: %+v", reloaded.Server)
	}
	// Raw editor validates too.
	if code := pc.do("PUT", "/api/config", map[string]string{"text": "[server\nbroken"}, nil); code != 400 {
		t.Fatalf("raw invalid: %d", code)
	}
	pc.do("POST", "/api/restart", map[string]any{}, nil)
	if rt.restarts != 1 {
		t.Fatal("restart not requested")
	}
}

func itoa(id int64) string { return strings.TrimSpace(string(must(json.Marshal(id)))) }

// waitClosed waits until the server closes a WebSocket connection.
func waitClosed(t *testing.T, c *amclient.Conn) {
	t.Helper()
	timeout := time.After(5 * time.Second)
	for {
		select {
		case _, ok := <-c.Pushes:
			if !ok {
				return
			}
		case <-timeout:
			t.Fatal("connection was not closed")
		}
	}
}
