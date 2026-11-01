package e2e

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/app"
	"github.com/OzakiJUN/am/server/internal/config"
)

// The built-in bot and 游戏资讯 (docs/design.md §10 内置 bot): commands in a
// channel and in a DM with the bot, the first round as a baseline, Steam and
// big news pushed at once, the evening digest and the X report — against
// fake sites and a fake model.
func TestNews(t *testing.T) {
	forEachDB(t, testNews, func(c *config.Config) {
		c.News.AIURL = "http://ai/v1"
		c.News.AIModel = "m"
		c.News.XAIKey = "xk"
		c.News.Sources = []string{"bili", "news", "steam", "nga"}
	})
}

// fakeSites answers as Steam, B站, Google News, the model and xAI.
type fakeSites struct {
	mu     sync.Mutex
	now    time.Time
	steam  []map[string]any
	bili   []map[string]any
	asked  []string // system prompts the model got
	xAsked string
}

func (f *fakeSites) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	host, path, _ := strings.Cut(strings.TrimPrefix(r.URL.Path, "/"), "/")
	path = "/" + path
	js := func(v any) { _ = json.NewEncoder(w).Encode(v) }
	switch {
	case host == "store.steampowered.com" && path == "/api/storesearch/":
		js(map[string]any{"items": []map[string]any{{"id": 570, "name": "Dota 2"}}})
	case host == "api.steampowered.com":
		js(map[string]any{"appnews": map[string]any{"newsitems": f.steam}})
	case host == "www.bilibili.com":
		w.WriteHeader(http.StatusOK)
	case host == "api.bilibili.com":
		js(map[string]any{"code": 0, "data": map[string]any{"result": f.bili}})
	case host == "news.google.com":
		fmt.Fprintf(w, `<rss><item><title>刀塔新英雄公布</title><link>https://news.example/%s</link><pubDate>%s</pubDate></item></rss>`,
			r.URL.Query().Get("gl"), f.now.Add(-time.Hour).Format(time.RFC1123Z))
	case host == "ai":
		var req struct {
			Messages []struct{ Content string } `json:"messages"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		sys, user := req.Messages[0].Content, req.Messages[1].Content
		f.asked = append(f.asked, sys)
		var answer string
		switch {
		case strings.Contains(sys, "是「游戏」还是"):
			answer = `{"kind":"game","en":"Dota 2"}`
		case strings.Contains(sys, "在 Steam 上的消息"):
			answer = `{"items":[{"n":1,"zh":"中文标题","summary":"一句话小结"}]}`
		case strings.Contains(sys, "游戏资讯编辑"):
			// Everything is one big event; ads stay ads.
			var ids []string
			for i, line := range strings.Split(user, "\n") {
				if !strings.Contains(line, "广告") {
					ids = append(ids, fmt.Sprint(i+1))
				}
			}
			answer = `{"events":[{"title":"新英雄来了","items":[` + strings.Join(ids, ",") + `],"type":"content","major":true,"summary":""}]}`
		case strings.Contains(sys, "合并成组"):
			answer = `{"groups":[{"title":"今天的大事","items":[1,2]}]}`
		}
		js(map[string]any{"choices": []map[string]any{{"message": map[string]string{"content": "好的：" + answer}}}})
	case host == "api.x.ai":
		b, _ := io.ReadAll(r.Body)
		f.xAsked = string(b)
		js(map[string]any{"output": []map[string]any{{"content": []map[string]any{{"type": "output_text", "text": "X 上在聊新英雄 [[1]](https://x.com/a)\nhttps://x.com/a"}}}},
			"usage": map[string]any{"server_side_tool_usage_details": map[string]any{"x_posts_fetched": 60}}})
	default:
		http.Error(w, "no", http.StatusNotFound)
	}
}

func testNews(t *testing.T, a *app.App, base string) {
	ctx := ctxT(t)
	us := newServerUsers(t, a, base, "admin", "bob")
	admin, bob := us[0], us[1]
	now := time.Now()
	fake := &fakeSites{now: now}
	srv := httptest.NewServer(fake)
	defer srv.Close()
	a.News.SetRewrite(func(raw string) string {
		u, _ := url.Parse(raw)
		return srv.URL + "/" + u.Host + u.Path + "?" + u.RawQuery
	})
	a.News.SetClock(func() time.Time { return now })
	fake.steam = []map[string]any{{"title": "Patch 7.40", "url": "https://steam/old", "feedname": "steam_community_announcements", "date": now.Add(-48 * time.Hour).Unix()}}
	fake.bili = []map[string]any{{"title": "旧视频", "bvid": "BV1", "play": "1.2万", "pubdate": now.Add(-5 * time.Hour).Unix()}}

	info := must(admin.cli.ServerInfo(ctx))
	if info.HelperId == 0 || !strings.Contains(strings.Join(info.Commands, ","), "关注游戏") {
		t.Fatalf("server info: %+v", info)
	}
	botID := info.HelperId
	// The bot isn't a person: not counted, not put into new public channels.
	pub := must(admin.cli.CreatePublicChannel(ctx, "游戏"))
	for _, m := range pub.Members {
		if m.GetId() == botID {
			t.Fatal("bot put into a public channel")
		}
	}

	adminWS := must(admin.cli.Connect(ctx))
	defer adminWS.Close()
	fromBot := func(what, has string) *amv1.Event {
		f := waitPushLong(t, adminWS, what, 20*time.Second, func(f *amv1.ServerFrame) bool {
			ev := f.GetEvent().GetEvent()
			if ev.GetSenderId() == botID {
				t.Logf("bot: %q", ev.GetText().GetText())
			}
			return ev.GetSenderId() == botID && strings.Contains(ev.GetText().GetText(), has)
		})
		return f.GetEvent().GetEvent()
	}

	// Following in a channel brings the bot in; the first round is a baseline (nothing pushed).
	cmd := must(adminWS.SendText(ctx, pub.Id, "/关注游戏 dota2|刀塔"))
	ack := fromBot("follow ack", "已关注「dota2」")
	if ack.GetText().GetReplyTo() != cmd.EventId || !strings.Contains(ack.GetText().GetText(), "Steam 上找到：Dota 2") {
		t.Fatalf("ack %v", ack.GetText())
	}
	fromBot("baseline", "基线建好了，最近的 1 个事件")
	must(adminWS.SendText(ctx, pub.Id, "/关注列表"))
	fromBot("list", "1. dota2（刀塔）")

	// A new hour: a Steam post and a hot video. Steam is pushed (translated), and the big event.
	fake.mu.Lock()
	fake.steam = append(fake.steam, map[string]any{"title": "New hero", "url": "https://steam/new", "feedname": "steam_community_announcements", "date": now.Add(-time.Hour).Unix()})
	fake.bili = append(fake.bili, map[string]any{"title": "新英雄实战", "bvid": "BV2", "play": 99999, "pubdate": now.Add(-time.Hour).Unix()},
		map[string]any{"title": "广告：充值", "bvid": "BV3", "play": 1, "pubdate": now.Add(-time.Hour).Unix()})
	fake.mu.Unlock()
	if _, err := a.News.Check(ctx, "", true); err != nil {
		t.Fatal(err)
	}
	st := fromBot("steam push", "Steam 新消息")
	if !strings.Contains(st.GetText().GetText(), "中文标题｜官方\n   📝 一句话小结\n   https://steam/new") {
		t.Fatalf("steam push %q", st.GetText().GetText())
	}
	big := fromBot("urgent", "⚡【dota2】大事")
	if !strings.Contains(big.GetText().GetText(), "✨ 新英雄来了") || strings.Contains(big.GetText().GetText(), "BV3") {
		t.Fatalf("urgent %q", big.GetText().GetText())
	}
	// The same thing isn't pushed again.
	if _, err := a.News.Check(ctx, "", true); err != nil {
		t.Fatal(err)
	}

	// The evening: one digest with Steam first, the day's events merged.
	if err := a.News.Daily(ctx); err != nil {
		t.Fatal(err)
	}
	dg := fromBot("digest", "🎮【dota2】今日动态").GetText().GetText()
	if !strings.Contains(dg, "📢 Steam 新消息") || !strings.Contains(dg, "今天的大事") || strings.Index(dg, "Steam") > strings.Index(dg, "其他平台") {
		t.Fatalf("digest %q", dg)
	}

	// /周报 costs money: site admins only; the weekly run posts it.
	bobWS := must(bob.cli.Connect(ctx))
	defer bobWS.Close()
	must(bobWS.SendText(ctx, pub.Id, "/周报"))
	fromBot("weekly refused", "只有站点管理员")
	if err := a.News.Weekly(ctx); err != nil {
		t.Fatal(err)
	}
	wk := fromBot("weekly", "本周 X（推特）圈内动态").GetText().GetText()
	if !strings.Contains(wk, "X 上在聊新英雄\nhttps://x.com/a") || !strings.Contains(wk, "60 条，约 $0.30") || !strings.Contains(fake.xAsked, "dota2 OR 刀塔") {
		t.Fatalf("weekly %q / %s", wk, fake.xAsked)
	}

	// In a DM with the bot; a typo isn't a command; one command at a time per person.
	dm := must(bob.cli.OpenDM(ctx, botID))
	must(bobWS.SendText(ctx, dm.Id, "/资讯源 dota2"))
	src := waitPushLong(t, bobWS, "sources", 20*time.Second, func(f *amv1.ServerFrame) bool {
		return strings.Contains(f.GetEvent().GetEvent().GetText().GetText(), "📡 资讯来源测试")
	}).GetEvent().GetEvent().GetText().GetText()
	for _, want := range []string{"✅ B站：", "✅ Steam：官方公告 2 条", "⏸ Reddit：配置里关掉了", "❌ NGA：失败：没填 nga cookie"} {
		if !strings.Contains(src, want) {
			t.Fatalf("sources: no %q in %q", want, src)
		}
	}
	must(bobWS.SendText(ctx, dm.Id, "/取消关注 dota2"))
	waitPushLong(t, bobWS, "unfollow in the DM", 20*time.Second, func(f *amv1.ServerFrame) bool {
		return strings.Contains(f.GetEvent().GetEvent().GetText().GetText(), "没找到")
	})
	// A DM between two people: the bot stays out.
	other := must(bob.cli.OpenDM(ctx, admin.me.Id))
	must(bobWS.SendText(ctx, other.Id, "/关注列表"))
	must(adminWS.SendText(ctx, pub.Id, "/取消关注 1"))
	fromBot("unfollow", "已取消关注「dota2」")
	if subs := must(a.Store.NewsSubs(ctx, 0)); len(subs) != 0 {
		t.Fatalf("subs left: %+v", subs)
	}
}
