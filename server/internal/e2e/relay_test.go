package e2e

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/admin"
	"github.com/OzakiJUN/am/server/internal/app"
	"github.com/OzakiJUN/am/server/internal/config"
	"github.com/OzakiJUN/am/server/internal/logx"
)

// Changing the relay address in the panel: the new address must reach this
// server; then it is saved, given to clients at login and pushed to online ones.
func TestRelayMove(t *testing.T) { forEachDB(t, testRelayMove) }

func testRelayMove(t *testing.T, a *app.App, base string) {
	ctx := ctxT(t)
	cfgPath := filepath.Join(t.TempDir(), "config.toml")
	cfg := must(func() (*config.Config, error) { c, _, err := config.Load(cfgPath); return c, err }())
	cfg.TLS.Mode = "off" // the test server is plain HTTP
	rt := &fakeRuntime{a: a, cfg: cfg, cfgPath: cfgPath, ring: logx.NewRing(10)}
	const key = "test-admin-key-0123456789"
	srv := httptest.NewServer(admin.New(rt, key, "127.0.0.1:8444", slog.New(slog.NewTextHandler(io.Discard, nil))))
	t.Cleanup(srv.Close)
	jar, _ := cookiejar.New(nil)
	pc := &panelClient{t: t, base: srv.URL, http: &http.Client{Jar: jar}}
	pc.do("GET", "/login?key="+key, nil, nil)

	us := newServerUsers(t, a, base, "owner")
	ws := must(us[0].cli.Connect(ctx))
	defer ws.Close()
	if ws.Auth.PublicAddress != "" {
		t.Fatal("no public address yet")
	}
	here := strings.TrimPrefix(base, "http://")

	// Who uses which address.
	var relay struct {
		Current     string `json:"current"`
		Connections []struct {
			Address string `json:"address"`
			Devices int    `json:"devices"`
		} `json:"connections"`
	}
	pc.do("GET", "/api/relay", nil, &relay)
	if len(relay.Connections) != 1 || relay.Connections[0].Address != here || relay.Connections[0].Devices != 1 {
		t.Fatalf("connections %+v", relay.Connections)
	}

	// An address that doesn't reach this server is refused.
	var e struct{ Code, Message string }
	if code := pc.do("POST", "/api/relay/test", map[string]string{"address": "127.0.0.1:1"}, &e); code != 400 || e.Code != "relay_unreachable" {
		t.Fatalf("bad address: %d %+v", code, e)
	}
	if code := pc.do("POST", "/api/relay/test", map[string]string{"address": "no-port"}, &e); code != 400 {
		t.Fatalf("no port: %d", code)
	}
	if code := pc.do("POST", "/api/relay/test", map[string]string{"address": here}, nil); code != 200 {
		t.Fatalf("good address: %d", code)
	}

	// "localhost:port" reaches the same server: move there.
	moved := "localhost:" + strings.Split(here, ":")[1]
	if code := pc.do("POST", "/api/relay/move", map[string]string{"address": moved}, nil); code != 200 {
		t.Fatalf("move: %d", code)
	}
	waitPush(t, ws, "server moved", func(f *amv1.ServerFrame) bool { return f.GetServerMoved().GetAddress() == moved })
	if text := string(must(os.ReadFile(cfgPath))); !strings.Contains(text, `public_address = "`+moved+`"`) {
		t.Fatal("config.toml not updated")
	}
	again := must(us[0].cli.Connect(ctx))
	defer again.Close()
	if again.Auth.PublicAddress != moved {
		t.Fatalf("login reply address %q", again.Auth.PublicAddress)
	}
	// New invites carry the new address.
	if inv := must(us[0].cli.ListInvites(ctx)); !strings.HasPrefix(inv.Invites[0].JoinCode, "AM1-") {
		t.Fatal("invite has no join code with the new address")
	}
	// The old address is remembered.
	var after struct {
		Current  string   `json:"current"`
		Previous []string `json:"previous"`
	}
	pc.do("GET", "/api/relay", nil, &after)
	if after.Current != moved {
		t.Fatalf("current %q", after.Current)
	}
	// Moving again keeps the one before in the list.
	if code := pc.do("POST", "/api/relay/move", map[string]string{"address": here}, nil); code != 200 {
		t.Fatalf("move back: %d", code)
	}
	pc.do("GET", "/api/relay", nil, &after)
	if len(after.Previous) != 1 || after.Previous[0] != moved {
		t.Fatalf("previous %v", after.Previous)
	}
}
