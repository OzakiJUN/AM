package e2e

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/sdk/go/amclient"
	"github.com/OzakiJUN/am/server/internal/app"
	"github.com/OzakiJUN/am/server/internal/helper"
)

// 电子厕所 (docs/design.md §10 内置 bot): throwing in by replying to a
// picture, the culprit (a person's own picture → them; an AI's drawing →
// who asked), a model-made title, NSFW only where allowed, the list, one
// pit, flushing (not your own), and the oldest flushed past 16.
func TestToilet(t *testing.T) {
	forEachDB(t, testToilet)
}

func testToilet(t *testing.T, a *app.App, base string) {
	ctx := ctxT(t)
	us := newServerUsers(t, a, base, "admin", "bob")
	admin, bob := us[0], us[1]
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []map[string]any{{"message": map[string]string{"content": "《猫猫崩坏》"}}}})
	}))
	defer model.Close()
	a.Helper.SetModel(helper.Model{URL: model.URL, Name: "m"})
	botID := a.Helper.Bot().ID

	ch := must(admin.cli.CreatePublicChannel(ctx, "画室"))
	ai := must(bob.cli.CreateAI(ctx, "画师")).User
	aiCli := amclient.New(base, nil)
	aiCli.Token = must(bob.cli.RunAI(ctx, ai.Id, "PC")).Token
	aiWS := must(aiCli.Connect(ctx))
	defer aiWS.Close()
	must(admin.cli.InviteMembers(ctx, ch.Id, ai.Id))
	adminWS := must(admin.cli.Connect(ctx))
	defer adminWS.Close()
	bobWS := must(bob.cli.Connect(ctx))
	defer bobWS.Close()
	said := func(what, has string) *amv1.Event {
		return waitPushLong(t, adminWS, what, 20*time.Second, func(f *amv1.ServerFrame) bool {
			ev := f.GetEvent().GetEvent()
			return ev.GetSenderId() == botID && strings.Contains(ev.GetText().GetText(), has)
		}).GetEvent().GetEvent()
	}
	pic := func(seed int64) int64 {
		return must(bob.cli.Upload(ctx, "p.png", bytes.NewReader(encodePNG(stickerPic(seed, 64, 64))))).Id
	}

	// Someone's own picture: they are the culprit.
	mine := must(bobWS.SendImage(ctx, ch.Id, pic(1)))
	must(adminWS.Reply(ctx, ch.Id, mine.EventId, "/投厕 手残"))
	said("thrown", "🚽《手残》已投进电子厕所第 1 坑（罪犯：bob）")
	// No picture replied to: how to use it.
	must(adminWS.SendText(ctx, ch.Id, "/投厕"))
	said("usage", "用法：回复一张图")

	// An AI's drawing: who asked is the culprit; no title → the model names it.
	aiPic := must(aiCli.Upload(ctx, "ai.png", bytes.NewReader(encodePNG(stickerPic(2, 64, 64))))).Id
	drawn := must(aiWS.SendImageFor(ctx, ch.Id, aiPic, "NovelAI V5", false, admin.me.Id, "画一只猫"))
	if drawn.GetImage().GetMadeFor() != admin.me.Id || drawn.GetImage().GetMadeFrom() != "画一只猫" {
		t.Fatalf("made_for / made_from dropped: %+v", drawn.GetImage())
	}
	must(bobWS.Reply(ctx, ch.Id, drawn.EventId, "/扔厕所"))
	said("ai thrown", "🚽《猫猫崩坏》已投进电子厕所第 1 坑（罪犯：admin）")
	// A person can't claim someone else asked.
	if h := must(bobWS.SendImageFor(ctx, ch.Id, pic(3), "x", false, admin.me.Id, "y")); h.GetImage().GetMadeFor() != 0 {
		t.Fatal("a person set made_for")
	}

	// NSFW: not in a channel without it.
	nsfw := must(aiWS.SendImageFor(ctx, ch.Id, must(aiCli.Upload(ctx, "n.png", bytes.NewReader(encodePNG(stickerPic(4, 64, 64))))).Id, "NovelAI V5", true, bob.me.Id, "x"))
	must(bobWS.Reply(ctx, ch.Id, nsfw.EventId, "/投厕"))
	said("nsfw refused", "这里没开 NSFW")
	if err := a.Conv.SetNsfw(ctx, ch.Id, true); err != nil {
		t.Fatal(err)
	}
	must(bobWS.Reply(ctx, ch.Id, nsfw.EventId, "/投厕 色图"))
	said("nsfw thrown", "《色图》已投进")
	if err := a.Conv.SetNsfw(ctx, ch.Id, false); err != nil {
		t.Fatal(err)
	}

	// The list: newest first; NSFW hidden here now.
	must(adminWS.SendText(ctx, ch.Id, "/厕所"))
	list := said("list", "🚽 电子厕所 第 1~8 坑").GetText().GetText()
	for _, want := range []string{"1. NSFW 已隐藏", "2.《猫猫崩坏》罪犯：admin｜bob 投的", "3.《手残》罪犯：bob｜admin 投的", "4. （空）"} {
		if !strings.Contains(list, want) {
			t.Fatalf("list: no %q in %q", want, list)
		}
	}
	// One pit: a caption and the picture, sent by the bot.
	must(adminWS.SendText(ctx, ch.Id, "/坑位 2"))
	said("pit", "🚽 第 2 坑《猫猫崩坏》｜罪犯：admin")
	waitPushLong(t, adminWS, "pit picture", 20*time.Second, func(f *amv1.ServerFrame) bool {
		ev := f.GetEvent().GetEvent()
		return ev.GetSenderId() == botID && ev.GetImage().GetMediaId() == aiPic
	})
	must(adminWS.SendText(ctx, ch.Id, "/捞 1"))
	said("nsfw fish refused", "这张是 NSFW")
	must(adminWS.SendText(ctx, ch.Id, "/坑位 9"))
	said("empty pit", "第 9 坑是空的")

	// Flushing: not your own; others can.
	must(adminWS.SendText(ctx, ch.Id, "/冲 2"))
	said("own flush refused", "罪犯本人不能冲自己的罪证")
	must(bobWS.SendText(ctx, ch.Id, "/冲 2"))
	said("flushed", "《猫猫崩坏》被冲走了")
	if pits := must(a.Store.ToiletPits(ctx)); len(pits) != 2 {
		t.Fatalf("pits after flush: %d", len(pits))
	}

	// 16 pits: the 17th flushes the oldest.
	for i := 0; i < 15; i++ {
		ev := must(bobWS.SendImage(ctx, ch.Id, pic(int64(10+i))))
		must(adminWS.Reply(ctx, ch.Id, ev.EventId, "/投厕 第"+string(rune('a'+i))))
		said("thrown "+string(rune('a'+i)), "《第"+string(rune('a'+i))+"》已投进")
	}
	pits := must(a.Store.ToiletPits(ctx))
	if len(pits) != 16 || pits[15].Title != "色图" {
		t.Fatalf("after 17: %d, oldest %q", len(pits), pits[len(pits)-1].Title)
	}
}
