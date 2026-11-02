package e2e

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/sdk/go/amclient"
	"github.com/OzakiJUN/am/server/internal/app"
	"github.com/OzakiJUN/am/server/internal/config"
	"github.com/OzakiJUN/am/server/internal/helper"
)

// Drawing on the built-in bot (docs/design.md §10 画画): the server's
// NovelAI key, /nai5 and /nai (translated by the bot's model), the balance,
// NSFW refused where it is off, the daily limit, and an AI drawing itself
// from its avatar — in a channel (the bot posts) and in its DM (posted as
// the AI) — against a fake NovelAI.
func TestDraw(t *testing.T) {
	var nai *fakeNai
	forEachDB(t, func(t *testing.T, a *app.App, base string) { testDraw(t, a, base, nai) }, func(c *config.Config) {
		nai = newFakeNai()
		c.Draw.Token = "nai-token"
		c.Draw.API = nai.srv.URL
		c.Draw.DailyPerPerson = 4
	})
}

type fakeNai struct {
	srv      *httptest.Server
	mu       sync.Mutex
	payloads []map[string]any
	auth     string
}

func newFakeNai() *fakeNai {
	f := &fakeNai{}
	png := encodePNG(stickerPic(77, 64, 64))
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.auth = r.Header.Get("Authorization")
		f.mu.Unlock()
		switch r.URL.Path {
		case "/user/subscription":
			_, _ = w.Write([]byte(`{"tier":3,"trainingStepsLeft":{"fixedTrainingStepsLeft":1000,"purchasedTrainingSteps":0}}`))
		case "/ai/generate-image":
			var p map[string]any
			b, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(b, &p)
			f.mu.Lock()
			f.payloads = append(f.payloads, p)
			f.mu.Unlock()
			n := int(p["parameters"].(map[string]any)["n_samples"].(float64))
			zw := zip.NewWriter(w)
			for i := 0; i < n; i++ {
				fw, _ := zw.Create("image_" + string(rune('0'+i)) + ".png")
				_, _ = fw.Write(png)
			}
			_ = zw.Close()
		default:
			http.NotFound(w, r)
		}
	}))
	return f
}

func (f *fakeNai) last() map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.payloads[len(f.payloads)-1]
}

func testDraw(t *testing.T, a *app.App, base string, nai *fakeNai) {
	defer nai.srv.Close()
	ctx := ctxT(t)
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []map[string]any{{"message": map[string]string{"content": "a girl with silver hair"}}}})
	}))
	defer model.Close()
	a.Helper.SetModel(helper.Model{URL: model.URL, Name: "m"})
	botID := a.Helper.Bot().ID
	us := newServerUsers(t, a, base, "admin", "bob")
	admin, bob := us[0], us[1]
	ch := must(admin.cli.CreatePublicChannel(ctx, "画室"))
	bobWS := must(bob.cli.Connect(ctx))
	defer bobWS.Close()
	said := func(what, has string) *amv1.Event {
		return waitPushLong(t, bobWS, what, 20*time.Second, func(f *amv1.ServerFrame) bool {
			ev := f.GetEvent().GetEvent()
			return ev.GetSenderId() == botID && strings.Contains(ev.GetText().GetText(), has)
		}).GetEvent().GetEvent()
	}
	picture := func(what string, from int64) *amv1.ImageMsg {
		return waitPushLong(t, bobWS, what, 20*time.Second, func(f *amv1.ServerFrame) bool {
			ev := f.GetEvent().GetEvent()
			return ev.GetSenderId() == from && ev.GetImage() != nil
		}).GetEvent().GetEvent().GetImage()
	}

	// /nai5: Chinese as it is, the server's key, a labelled picture from the bot.
	must(bobWS.SendText(ctx, ch.Id, "/nai5 横图 银发猫耳"))
	said("drawing", "收到，NovelAI V5 画图中")
	img := picture("picture", botID)
	if img.GetMadeWith() != "NovelAI V5" || img.GetMadeFor() != bob.me.Id || img.GetMadeFrom() != "/nai5 横图 银发猫耳" {
		t.Fatalf("picture %+v", img)
	}
	said("done", "NovelAI V5，")
	if p := nai.last(); !strings.HasPrefix(p["input"].(string), "银发猫耳") || p["parameters"].(map[string]any)["width"].(float64) != 1216 || nai.auth != "Bearer nai-token" {
		t.Fatalf("payload %v / %q", p["input"], nai.auth)
	}
	// /nai: translated by the bot's model.
	must(bobWS.SendText(ctx, ch.Id, "/nai 银发少女"))
	said("done v4.5", "NovelAI V4.5，")
	if p := nai.last(); !strings.HasPrefix(p["input"].(string), "a girl with silver hair") {
		t.Fatalf("translated %v", p["input"])
	}
	// Not here: NSFW (the channel doesn't allow it); the balance.
	must(bobWS.SendText(ctx, ch.Id, "/nai nude girl"))
	said("nsfw", "这里没开 NSFW")
	must(bobWS.SendText(ctx, ch.Id, "/nai余额"))
	said("balance", "剩余 1000 Anlas")

	// An AI draws itself from its avatar, in the channel (the bot posts).
	ai := must(bob.cli.CreateAI(ctx, "小鱼")).User
	aiCli := amclient.New(base, nil)
	aiCli.Token = must(bob.cli.RunAI(ctx, ai.Id, "PC")).Token
	must(admin.cli.InviteMembers(ctx, ch.Id, ai.Id))
	av := must(bob.cli.Upload(ctx, "av.png", bytes.NewReader(encodePNG(stickerPic(9, 64, 64))))).Id
	must(bob.cli.UpdateAI(ctx, ai.Id, &amv1.UpdateProfileRequest{AvatarMediaId: &av}))
	r := must(aiCli.HelperRun(ctx, ch.Id, "/nai 用我的头像 原样 on the beach", 0, true))
	if !r.Shown {
		t.Fatalf("not shown %+v", r)
	}
	if img := picture("ai picture", botID); img.GetMadeFor() != ai.Id {
		t.Fatalf("made_for %+v", img)
	}
	if refs, _ := nai.last()["parameters"].(map[string]any)["director_reference_images"].([]any); len(refs) != 1 || !strings.HasPrefix(nai.last()["input"].(string), "on the beach") {
		t.Fatalf("no avatar reference: %v", nai.last()["input"])
	}
	// In its DM with bob the bot isn't there: posted as the AI itself.
	dm := must(bob.cli.OpenDM(ctx, ai.Id))
	r = must(aiCli.HelperRun(ctx, dm.Id, "/nai 原样 a cat", 0, true))
	if !r.Shown {
		t.Fatalf("dm not shown %+v", r)
	}
	if img := picture("picture in the DM", ai.Id); img.GetMadeWith() != "NovelAI V4.5" {
		t.Fatalf("dm picture %+v", img)
	}

	// The daily limit (4 here): bob drew 2, two more, then no.
	must(bobWS.SendText(ctx, ch.Id, "/nai5 *2 猫"))
	said("two more", "2 张")
	said("two more done", "NovelAI V5，")
	must(bobWS.SendText(ctx, ch.Id, "/nai5 狗"))
	said("limit", "今天画得够多啦")
}
