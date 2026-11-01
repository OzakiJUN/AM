package helper

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestMatch(t *testing.T) {
	names := []string{"资讯", "资讯源", "关注游戏", "nai", "周报"}
	cases := []struct {
		in, name, args string
		ok             bool
	}{
		{"/资讯 dota2", "资讯", "dota2", true},
		{"/资讯源", "资讯源", "", true},
		{"/资讯dota2", "资讯", "dota2", true},
		{"  @小助手 /关注游戏 刀塔|dota2 ", "关注游戏", "刀塔|dota2", true},
		{"／周报", "周报", "", true},
		{"/NAI 猫", "nai", "猫", true},
		{"/naive", "", "", false},
		{"资讯 dota2", "", "", false},
		{"/没这个", "", "", false},
		{"@只有提到", "", "", false},
	}
	for _, c := range cases {
		n, a, ok := Match(c.in, names)
		if n != c.name || a != c.args || ok != c.ok {
			t.Errorf("Match(%q) = %q %q %v", c.in, n, a, ok)
		}
	}
}

func TestSplit(t *testing.T) {
	if got := Split("短", 10); len(got) != 1 || got[0] != "短" {
		t.Fatal(got)
	}
	text := strings.Repeat("一二三四五\n", 4) + "\n" + strings.Repeat("长", 23)
	parts := Split(text, 12)
	for _, p := range parts {
		if utf8.RuneCountInString(p) > 12 || p == "" {
			t.Fatalf("bad part %q", p)
		}
	}
	if strings.ReplaceAll(strings.Join(parts, ""), "\n", "") != strings.ReplaceAll(text, "\n", "") {
		t.Fatalf("lost text: %q", parts)
	}
	if parts[0] != "一二三四五\n一二三四五" {
		t.Fatalf("should cut at line ends: %q", parts[0])
	}
}
