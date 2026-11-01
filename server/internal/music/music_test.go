package music

import "testing"

func TestParse(t *testing.T) {
	for link, want := range map[string]string{
		"https://music.163.com/#/song?id=186016":                  "song 186016",
		"https://music.163.com/song?id=186016&userid=1":           "song 186016",
		"https://y.music.163.com/m/song?id=186016&uct=x":          "song 186016",
		"https://music.163.com/#/playlist?id=2829883282":          "playlist 2829883282",
		"https://y.music.163.com/m/playlist?app_version=9&id=777": "playlist 777",
		"https://music.163.com/song/186016/":                      "song 186016",
		"https://example.com/song?id=1":                           "",
		"https://music.163.com/#/artist?id=6452":                  "",
		"晴天":                                                      "",
	} {
		kind, id, ok := parse(link)
		got := ""
		if ok {
			got = kind + " " + id
		}
		if got != want {
			t.Errorf("%s: got %q, want %q", link, got, want)
		}
	}
}
