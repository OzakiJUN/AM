package toilet

import (
	"strings"
	"testing"
	"time"
)

func TestRules(t *testing.T) {
	for _, c := range []struct {
		in     string
		have   int
		n      int
		ok     bool
		hasMsg bool
	}{
		{"3", 5, 3, true, false},
		{"No.3", 5, 3, true, false},
		{"#2", 5, 2, true, false},
		{"", 5, 0, true, false},
		{"啊", 5, 0, false, false},
		{"一下", 5, 0, false, false},
		{"9", 5, 0, true, true},
		{"17", 16, 0, true, true},
		{"0", 16, 0, true, true},
	} {
		n, ok, msg := PitNo(c.in, c.have)
		if n != c.n || ok != c.ok || (msg != "") != c.hasMsg {
			t.Errorf("PitNo(%q, %d) = %d %v %q", c.in, c.have, n, ok, msg)
		}
	}
	if p, ok := Page("二"); p != 1 || !ok {
		t.Fatal("Page 二")
	}
	if _, ok := Page("很臭"); ok {
		t.Fatal("chat is not a page")
	}
	if nsfw, title := ThrowArgs("NSFW 好图"); !nsfw || title != "好图" {
		t.Fatal("ThrowArgs nsfw", nsfw, title)
	}
	if nsfw, title := ThrowArgs("nsfwx"); nsfw || title != "nsfwx" {
		t.Fatal("ThrowArgs word", nsfw, title)
	}
	if title, bad := CleanTitle(""); title != "" || bad {
		t.Fatal("empty title")
	}
	if _, bad := CleanTitle("萝莉"); !bad {
		t.Fatal("minor title")
	}
	if AITitle("《手指十二根》〔AI〕") != "手指十二根" || AITitle("  ") != "无名烂图" {
		t.Fatal("AITitle")
	}
	loc := time.FixedZone("CST", 8*3600)
	at := time.Date(2026, 10, 20, 12, 0, 0, 0, loc).UnixMilli()
	got := List([]Line{{No: 1, Title: "烂", Culprit: "小克", By: "Weiqi", At: at}, {No: 3, Hidden: true}}, 0, loc)
	for _, want := range []string{"第 1~8 坑", "1.《烂》罪犯：小克｜Weiqi 投的｜10-20", "2. （空）", "3. NSFW 已隐藏", "/厕所 2 看第 9~16 坑"} {
		if !strings.Contains(got, want) {
			t.Fatalf("List: no %q in %q", want, got)
		}
	}
	if got := List(nil, 1, loc); !strings.Contains(got, "第 9~16 坑") || !strings.Contains(got, "9. （空）") {
		t.Fatalf("page 2 %q", got)
	}
}
