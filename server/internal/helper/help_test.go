package helper

import (
	"math"
	"strings"
	"testing"
)

func TestRatio(t *testing.T) {
	// Values from Python: difflib.SequenceMatcher(None, a, b).ratio()
	for _, c := range []struct {
		a, b string
		want float64
	}{
		{"资讯原", "资讯源", 2.0 * 2 / 6},
		{"abcd", "bcde", 0.75},
		{"guanzhu", "guanzhu", 1},
		{"abc", "xyz", 0},
		{"风格转移", "风格迁移", 0.75},
	} {
		if got := Ratio([]rune(c.a), []rune(c.b)); math.Abs(got-c.want) > 1e-9 {
			t.Errorf("Ratio(%q, %q) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}

var testEntries = []Entry{
	{Name: "资讯源", Aliases: []string{"资讯来源"}, Group: "🎮 游戏资讯", Usage: "资讯源 [关键词]", Help: "测来源", Own: true, Safe: true},
	{Name: "资讯", Group: "🎮 游戏资讯", Usage: "资讯 [关键词]", Help: "马上查", Own: true, Safe: true},
	{Name: "关注游戏", Group: "🎮 游戏资讯", Usage: "关注游戏 名字", Help: "关注", Own: true, Safe: true},
	{Name: "取消关注", Group: "🎮 游戏资讯", Usage: "取消关注 <序号>", Help: "不再关注", Own: true},
	{Name: "冲", Group: "🚽 电子厕所", Usage: "冲 <序号>", Help: "冲掉", Own: true},
	{Name: "nai", Group: "🖌 别人的指令", Usage: "nai <描述>", Help: "画画"},
}

func TestHelpText(t *testing.T) {
	ov := Overview(testEntries)
	if !strings.Contains(ov, "🎮 游戏资讯：资讯源、资讯、关注游戏、取消关注") || !strings.Contains(ov, "🚽 电子厕所：冲") {
		t.Fatalf("overview %q", ov)
	}
	if got := Lookup("游戏资讯", testEntries); !strings.HasPrefix(got, "🎮 游戏资讯\n• /资讯源 [关键词]") {
		t.Fatalf("group lookup %q", got)
	}
	if got := Lookup("/资讯来源", testEntries); got != "📌 /资讯源 [关键词]\n测来源\n别名：资讯来源" {
		t.Fatalf("alias lookup %q", got)
	}
	if got := Lookup("关注", testEntries); !strings.Contains(got, "相关的指令") || !strings.Contains(got, "/取消关注") {
		t.Fatalf("search %q", got)
	}
	if got := Lookup("资询", testEntries); !strings.HasPrefix(got, "没找到「资询」，你是不是想找：/资讯") {
		t.Fatalf("guess %q", got)
	}
	if got := Lookup("zzzz", testEntries); !strings.Contains(got, "发「/指令」看全部") {
		t.Fatalf("nothing %q", got)
	}
}

func TestTypo(t *testing.T) {
	// Close enough to one safe command: run it, the rest is its argument.
	fix, rest, _ := Typo("关注游嬉 dota2", testEntries, nil)
	if fix == nil || fix.Entry.Name != "关注游戏" || rest != "dota2" {
		t.Fatalf("fix %+v %q", fix, rest)
	}
	// A command that deletes: only suggested.
	fix, _, sug := Typo("取消关住 1", testEntries, nil)
	if fix != nil || len(sug) == 0 || sug[0].Entry.Name != "取消关注" {
		t.Fatalf("unsafe %+v %+v", fix, sug)
	}
	// Starts with a real command: that command handles it, not the typo fixer.
	if fix, _, sug := Typo("资讯原", testEntries, []string{"资讯"}); fix != nil || len(sug) != 0 {
		t.Fatalf("own command %+v %+v", fix, sug)
	}
	// A character missing still counts (like qqhelp).
	fix, rest, _ = Typo("关注游 dota", testEntries, nil)
	if fix == nil || fix.Entry.Name != "关注游戏" || rest != "dota" {
		t.Fatalf("missing char %+v %q", fix, rest)
	}
	// Someone else's command, not like anything, numbers, a smiley: nothing.
	for _, body := range []string{"nai 猫", "完全不相干的话", "123", "：）"} {
		if fix, _, sug := Typo(body, testEntries, []string{"nai"}); fix != nil || len(sug) != 0 {
			t.Fatalf("%q: %+v %+v", body, fix, sug)
		}
	}
	// Commands something else answers are only suggested.
	if fix, _, sug := Typo("nia 猫", testEntries, nil); fix != nil || len(sug) == 0 || sug[0].Entry.Name != "nai" {
		t.Fatalf("nia %+v %+v", fix, sug)
	}
}
