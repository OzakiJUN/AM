package e2e

import (
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/OzakiJUN/am/sdk/go/amclient"
	"github.com/OzakiJUN/am/server/internal/app"
	"github.com/OzakiJUN/am/server/internal/config"
	"github.com/OzakiJUN/am/server/internal/hosting"
)

// AIs hosted on the server (docs/design.md §10 托管): ask, admin approves in
// the panel, the server writes the host client's file (this test plays the
// client), the owner takes it back.
func TestHosting(t *testing.T) {
	forEachDB(t, testHosting, func(c *config.Config) { c.Hosting.NoSpawn = true })
}

func readHostFile(t *testing.T, a *app.App, aiID int64) *hosting.HostFile {
	t.Helper()
	file := filepath.Join(filepath.Dir(a.Hosting.WorkDir(aiID)), "host.json")
	var hf hosting.HostFile
	waitFor(t, "host.json", func() bool {
		b, err := os.ReadFile(file)
		return err == nil && json.Unmarshal(b, &hf) == nil
	})
	return &hf
}

func testHosting(t *testing.T, a *app.App, base string) {
	ctx := ctxT(t)
	u, _ := url.Parse(base)
	a.Hosting.SetEndpoint(u.Host, true, "")
	us := newServerUsers(t, a, base, "admin", "bob", "carol")
	admin, bob, carol := us[0], us[1], us[2]
	if !must(bob.cli.ServerInfo(ctx)).Hosting {
		t.Fatal("server says hosting is off")
	}
	ai := must(bob.cli.CreateAI(ctx, "小鱼")).User
	ai2 := must(bob.cli.CreateAI(ctx, "小虾")).User
	const providers = `[{"id":"p1","name":"DeepSeek","baseUrl":"https://api.deepseek.com","key":"sk-secret-123"}]`

	// Asking: not someone else's AI; waits for the admin; one per person.
	_, err := carol.cli.HostAI(ctx, ai.Id, providers)
	wantCode(t, err, "user_not_found")
	if h := must(bob.cli.HostAI(ctx, ai.Id, providers)); h.Status != "pending" || h.WorkDir != "" {
		t.Fatalf("request %+v", h)
	}
	_, err = bob.cli.HostAI(ctx, ai2.Id, providers)
	wantCode(t, err, "hosting_limit")
	if l := must(bob.cli.ListAI(ctx)).Ais; l[0].GetHosting().GetStatus() != "pending" || l[1].Hosting != nil {
		t.Fatalf("list %+v / %+v", l[0].Hosting, l[1].Hosting)
	}
	// The keys are stored encrypted.
	if row := must(a.Store.GetHosting(ctx, ai.Id)); strings.Contains(row.Secrets, "sk-secret") {
		t.Fatal("keys stored in the clear")
	}

	// The panel: listed with the badge, approved.
	pc := panelFor(t, a)
	var st struct {
		Stats map[string]int64 `json:"stats"`
	}
	pc.do("GET", "/api/status", nil, &st)
	if st.Stats["hosting_pending"] != 1 {
		t.Fatalf("badge %v", st.Stats)
	}
	var hl struct {
		Items []struct {
			AIID  string `json:"ai_id"`
			Owner string `json:"owner_name"`
		} `json:"items"`
	}
	pc.do("GET", "/api/hosting?status=pending", nil, &hl)
	if len(hl.Items) != 1 || hl.Items[0].Owner != "bob" || hl.Items[0].AIID != strconv.FormatInt(ai.Id, 10) {
		t.Fatalf("panel %+v", hl)
	}
	if code := pc.do("POST", "/api/hosting/"+hl.Items[0].AIID+"/decide", map[string]any{"approve": true}, nil); code != 200 {
		t.Fatalf("approve %d", code)
	}

	// The host client's file: the AI's login, the providers, its own folder.
	hf := readHostFile(t, a, ai.Id)
	if hf.AIID != strconv.FormatInt(ai.Id, 10) || !hf.Server.Plain || hf.Server.Address != u.Host || hf.WorkDir != a.Hosting.WorkDir(ai.Id) {
		t.Fatalf("host file %+v", hf)
	}
	if string(hf.Providers) != providers {
		t.Fatalf("providers %s", hf.Providers)
	}
	if st, err := os.Stat(hf.WorkDir); err != nil || !st.IsDir() {
		t.Fatal("no work folder")
	}
	host := amclient.New(base, nil)
	host.Token = hf.Token
	mine := must(host.MyAI(ctx))
	var settings struct {
		Runner struct{ ID, Name string } `json:"runner"`
	}
	if err := json.Unmarshal([]byte(mine.Settings), &settings); err != nil || settings.Runner.ID != hosting.RunnerID {
		t.Fatalf("runner %s", mine.Settings)
	}
	// It saves its own settings (persona changes), like the owner would.
	must(host.PutMyAISettings(ctx, mine.Settings, mine.SettingsUpdatedAt))
	_, err = host.PutMyAISettings(ctx, mine.Settings, mine.SettingsUpdatedAt)
	wantCode(t, err, "state_conflict")
	_, err = bob.cli.MyAI(ctx)
	wantCode(t, err, "no_permission")
	if l := must(host.ListPlugins(ctx, ai.Id)); l == nil {
		t.Fatal("the AI can't list its own plugins")
	}
	// Online = running.
	ws := must(host.Connect(ctx))
	waitFor(t, "running", func() bool {
		return must(bob.cli.ListAI(ctx)).Ais[0].GetHosting().GetState() == "running"
	})
	if h := must(bob.cli.ListAI(ctx)).Ais[0].Hosting; h.WorkDir == "" || h.Status != "approved" {
		t.Fatalf("approved view %+v", h)
	}

	// The owner runs it on their own device again: hosting ends, the host is logged out.
	runner := amclient.New(base, nil)
	runner.Token = must(bob.cli.RunAI(ctx, ai.Id, "PC")).Token
	waitClosed(t, ws)
	if l := must(bob.cli.ListAI(ctx)).Ais[0]; l.Hosting != nil {
		t.Fatalf("still hosted: %+v", l.Hosting)
	}

	// Asking again and withdrawing: nobody runs it afterwards.
	waitFor(t, "old host file gone", func() bool {
		_, err := os.Stat(filepath.Join(filepath.Dir(a.Hosting.WorkDir(ai.Id)), "host.json"))
		return os.IsNotExist(err)
	})
	must(bob.cli.HostAI(ctx, ai.Id, providers))
	if err := pc.do("POST", "/api/hosting/"+hl.Items[0].AIID+"/decide", map[string]any{"approve": true}, nil); err != 200 {
		t.Fatalf("approve again %d", err)
	}
	hf = readHostFile(t, a, ai.Id)
	host.Token = hf.Token
	must(host.MyAI(ctx)) // the new login works…
	if err := bob.cli.UnhostAI(ctx, ai.Id); err != nil {
		t.Fatal(err)
	}
	_, err = host.MyAI(ctx) // …until it's taken off
	wantCode(t, err, "unauthorized")
	if s := must(bob.cli.ListAI(ctx)).Ais[0].Settings; strings.Contains(s, hosting.RunnerID) {
		t.Fatalf("runner left as the server: %s", s)
	}

	// Rejected (with a reason the owner sees), then another AI is fine.
	must(bob.cli.HostAI(ctx, ai.Id, providers))
	pc.do("POST", "/api/hosting/"+hl.Items[0].AIID+"/decide", map[string]any{"approve": false, "reason": "电脑跑不动"}, nil)
	if h := must(bob.cli.ListAI(ctx)).Ais[0].Hosting; h.Status != "rejected" || h.RejectReason != "电脑跑不动" {
		t.Fatalf("rejected %+v", h)
	}
	if h := must(bob.cli.HostAI(ctx, ai2.Id, providers)); h.Status != "pending" {
		t.Fatalf("second AI after a rejection: %+v", h)
	}

	// A site admin's own request is approved at once.
	adminAI := must(admin.cli.CreateAI(ctx, "管家")).User
	if h := must(admin.cli.HostAI(ctx, adminAI.Id, `[]`)); h.Status != "approved" {
		t.Fatalf("admin's own: %+v", h)
	}
	_, err = admin.cli.HostAI(ctx, adminAI.Id, `not json`)
	wantCode(t, err, "bad_request")
}
