package e2e

import (
	"net/http"
	"net/http/httptest"
	"testing"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/app"
	"github.com/OzakiJUN/am/server/internal/config"
)

// NetEase links in the music widgets, against a fake NetEase that answers
// like the real pages' JSON (the real one is not reachable from tests).
func TestMusicLinks(t *testing.T) {
	cover := encodePNG(testImage(30, 30))
	var fake *httptest.Server
	fake = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/cover.png":
			_, _ = w.Write(cover)
		case r.URL.Path == "/api/song/detail/" && r.URL.Query().Get("ids") == "[186016]":
			_, _ = w.Write([]byte(`{"code":200,"songs":[{"id":186016,"name":"晴天","artists":[{"name":"周杰伦"}],"album":{"picUrl":"` + fake.URL + `/cover.png"}}]}`))
		case r.URL.Path == "/api/song/detail/" && r.URL.Query().Get("ids") == "[1,2]":
			_, _ = w.Write([]byte(`{"code":200,"songs":[{"id":1,"name":"一","artists":[{"name":"甲"}]},{"id":2,"name":"二","artists":[{"name":"乙"},{"name":"丙"}]}]}`))
		case r.URL.Path == "/api/v6/playlist/detail" && r.URL.Query().Get("id") == "777":
			// Without a login only the ids come back: the server looks the songs up.
			_, _ = w.Write([]byte(`{"code":200,"playlist":{"name":"单曲循环","coverImgUrl":"` + fake.URL + `/cover.png","creator":{"nickname":"Weiqi"},"tracks":[],"trackIds":[{"id":1},{"id":2}]}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer fake.Close()
	forEachDB(t, func(t *testing.T, a *app.App, base string) { testMusicLinks(t, a, base) }, func(c *config.Config) { c.Media.NeteaseAPI = fake.URL })
}

func testMusicLinks(t *testing.T, a *app.App, base string) {
	ctx := ctxT(t)
	us := newServerUsers(t, a, base, "alice", "bob")
	alice, bob := us[0], us[1]

	s := must(alice.cli.ResolveMusic(ctx, "分享周杰伦的单曲《晴天》: https://music.163.com/#/song?id=186016&userid=1 (来自@网易云音乐)"))
	if s.Kind != "song" || s.NeteaseId != "186016" || s.Title != "晴天" || s.Artist != "周杰伦" || s.CoverMediaId == 0 || len(s.Tracks) != 1 {
		t.Fatalf("song: %+v", s)
	}
	p := must(alice.cli.ResolveMusic(ctx, "https://y.music.163.com/m/playlist?id=777"))
	if p.Kind != "playlist" || p.Title != "单曲循环" || p.Artist != "Weiqi" || len(p.Tracks) != 2 || p.Tracks[1].Artist != "乙 / 丙" {
		t.Fatalf("playlist: %+v", p)
	}
	_, err := alice.cli.ResolveMusic(ctx, "https://example.com/song?id=1")
	wantCode(t, err, "music_link_invalid")
	_, err = alice.cli.ResolveMusic(ctx, "https://music.163.com/#/song?id=404")
	wantCode(t, err, "music_unavailable")

	// The widgets store NetEase ids; the cover is alice's upload, visible to visitors.
	v := must(alice.cli.SaveProfile(ctx, alice.me.Id, &amv1.ProfileLayout{Widgets: []*amv1.Widget{
		widget("s", "song", 2, 1, 0, 0, 0, `{"title":"晴天","artist":"周杰伦","netease_id":"186016","cover_id":"`+itoa(s.CoverMediaId)+`"}`),
		widget("p", "playlist", 2, 2, 0, 2, 0, `{"title":"单曲循环","netease_id":"777","cover_id":"`+itoa(p.CoverMediaId)+`","songs":[{"title":"一","netease_id":"1"},{"title":"二","netease_id":"2"}]}`),
	}}, 0))
	if len(v.Layout.Widgets) != 2 {
		t.Fatalf("saved: %+v", v.Layout)
	}
	if _, _, err := bob.cli.Download(ctx, "/api/v1/media/"+itoa(s.CoverMediaId)); err != nil {
		t.Fatalf("bob cannot see the cover: %v", err)
	}
	// A song is either an upload or a NetEase id, not both; ids are digits.
	for _, cfg := range []string{`{"netease_id":"12a"}`, `{"netease_id":"1","audio_id":"` + itoa(s.CoverMediaId) + `"}`} {
		_, err := alice.cli.SaveProfile(ctx, alice.me.Id, &amv1.ProfileLayout{Widgets: []*amv1.Widget{widget("s", "song", 2, 1, 0, 0, 0, cfg)}}, v.Layout.Version)
		wantCode(t, err, "invalid_widget")
	}
}
