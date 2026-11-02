package helper

import (
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

// 指令查询 (from Weiqi's qqhelp): the command list, looking a command up,
// and catching typos. The functions here are pure (tested).

// Entry is a command in the help: the bot's own, or one something else
// answers (an AI's drawing commands), which is only listed and suggested.
type Entry struct {
	Name, Group, Usage, Help string
	Aliases                  []string
	// Safe: a typo may just run it (not a command that deletes something).
	Safe bool
	// Own: the bot runs it (otherwise only suggested).
	Own bool
}

// AIDrawing lists the drawing commands an AI answers (client
// lib/ai/nai.ts CMDS; keep in sync).
var AIDrawing = []Entry{
	{Name: "nai", Usage: "nai [横图/方图] [*4] <描述>", Help: "叫有 NovelAI 的 AI 画画（V4.5，中文会先翻成英文）；频道里要 @ 它"},
	{Name: "nai5", Usage: "nai5 <描述>", Help: "NovelAI V5，直接写中文"},
	{Name: "nai余额", Aliases: []string{"nai额度"}, Usage: "nai余额", Help: "查 NovelAI 还剩多少 Anlas"},
	{Name: "角色参考", Aliases: []string{"角色迁移", "人物参考"}, Usage: "角色参考 <新画面> + 回复一张角色图", Help: "画同一个角色的新画面（换动作、场景、衣服）"},
	{Name: "风格迁移", Aliases: []string{"画风迁移", "vibe"}, Usage: "风格迁移 [强度0.8] <要画什么> + 回复一张图", Help: "照这张图的画风画新内容"},
	{Name: "放大", Aliases: []string{"高清放大", "upscale"}, Usage: "放大 + 回复一张图", Help: "NovelAI 放大"},
	{Name: "查标签", Aliases: []string{"查画师", "标签联想"}, Usage: "查画师 <名字>", Help: "查 NovelAI 认不认识这个画师 / 标签"},
}

// AIDrawingGroup is the group name of AIDrawing.
const AIDrawingGroup = "🖌 AI 画画（叫自己的 AI 画，频道里 @ 它）"

// Overview lists every group and its command names.
func Overview(entries []Entry) string {
	lines := []string{"📖 指令一览（前面加 /，发「/指令 关键词」看具体用法）"}
	var groups []string
	byGroup := map[string][]string{}
	for _, e := range entries {
		if _, ok := byGroup[e.Group]; !ok {
			groups = append(groups, e.Group)
		}
		byGroup[e.Group] = append(byGroup[e.Group], e.Name)
	}
	for _, g := range groups {
		lines = append(lines, g+"："+strings.Join(byGroup[g], "、"))
	}
	return strings.Join(lines, "\n")
}

func usageLine(e Entry) string {
	s := "• /" + e.Usage
	if e.Help != "" {
		s += "\n  " + e.Help
	}
	if len(e.Aliases) > 0 {
		s += "\n  别名：" + strings.Join(e.Aliases, "、")
	}
	return s
}

// Lookup answers 「/指令 关键词」: a group, a command (or alias), commands
// whose text mentions it, or a guess.
func Lookup(q string, entries []Entry) string {
	ql := strings.ToLower(strings.TrimLeft(strings.TrimSpace(q), "/／"))
	if ql == "" {
		return Overview(entries)
	}
	var group []Entry
	gname := ""
	for _, e := range entries {
		if strings.Contains(strings.ToLower(e.Group), ql) && (gname == "" || gname == e.Group) {
			gname = e.Group
			group = append(group, e)
		}
	}
	if len(group) > 0 {
		lines := []string{gname}
		for _, e := range group {
			lines = append(lines, usageLine(e))
		}
		return strings.Join(lines, "\n")
	}
	for _, e := range entries {
		if strings.ToLower(e.Name) == ql || containsFold(e.Aliases, ql) {
			s := "📌 /" + e.Usage + "\n" + e.Help
			if len(e.Aliases) > 0 {
				s += "\n别名：" + strings.Join(e.Aliases, "、")
			}
			return s
		}
	}
	var hits []string
	for _, e := range entries {
		hay := strings.ToLower(strings.Join(append([]string{e.Name, e.Usage, e.Help}, e.Aliases...), " "))
		if strings.Contains(hay, ql) {
			hits = append(hits, usageLine(e))
		}
	}
	if len(hits) > 0 {
		if len(hits) > 12 {
			hits = hits[:12]
		}
		return "🔎「" + q + "」相关的指令：\n" + strings.Join(hits, "\n")
	}
	if sug := Suggest(ql, entries, 3); len(sug) > 0 {
		var names []string
		for _, s := range sug {
			names = append(names, "/"+s.Entry.Name)
		}
		return "没找到「" + q + "」，你是不是想找：" + strings.Join(names, "、")
	}
	return "没找到「" + q + "」相关的指令，发「/指令」看全部"
}

func containsFold(list []string, s string) bool {
	for _, x := range list {
		if strings.ToLower(x) == s {
			return true
		}
	}
	return false
}

// Guess is a command a mistyped one may have meant.
type Guess struct {
	Entry Entry
	Score float64
	// Cut: how many runes of the text were the (mistyped) command.
	Cut int
}

// Suggest finds the commands text (what follows the "/") may have meant,
// best first, one per command (qqhelp's rule: the start of the text
// compared with every name and alias, a bit shorter or longer).
func Suggest(text string, entries []Entry, limit int) []Guess {
	t := []rune(strings.ToLower(text))
	type cand struct {
		e     Entry
		name  string
		score float64
		cut   int
	}
	var res []cand
	for _, e := range entries {
		for _, n := range append([]string{e.Name}, e.Aliases...) {
			nr := []rune(strings.ToLower(n))
			if len(nr) < 2 {
				continue
			}
			best, cut := 0.0, 0
			for L := len(nr) - 1; L <= len(nr)+1; L++ {
				if L < 1 || L > len(t) {
					continue
				}
				r := Ratio(t[:L], nr) * float64(min(L, len(nr))) / float64(max(L, len(nr)))
				if L < len(t) && IsASCIIWord(n) && t[L] < 128 && (unicode.IsLetter(t[L]) || unicode.IsDigit(t[L])) {
					r *= 0.7 // an English command going on with letters: not cut right
				}
				if r > best {
					best, cut = r, L
				}
			}
			if best >= 0.6 || (best >= 0.5 && len(nr) == 2 && cut == 2) {
				res = append(res, cand{e, n, best, cut})
			}
		}
	}
	sort.SliceStable(res, func(a, b int) bool {
		if res[a].score != res[b].score {
			return res[a].score > res[b].score
		}
		return utf8.RuneCountInString(res[a].name) > utf8.RuneCountInString(res[b].name)
	})
	seen := map[string]bool{}
	var out []Guess
	for _, c := range res {
		if seen[c.e.Name] {
			continue
		}
		seen[c.e.Name] = true
		out = append(out, Guess{Entry: c.e, Score: c.score, Cut: c.cut})
		if len(out) == limit {
			break
		}
	}
	return out
}

// IsASCIIWord: letters and digits only, ASCII.
func IsASCIIWord(s string) bool {
	for _, r := range s {
		if r >= 128 || !(unicode.IsLetter(r) || unicode.IsDigit(r)) {
			return false
		}
	}
	return s != ""
}

// Ratio is Python difflib.SequenceMatcher(None, a, b).ratio(): 2·matches /
// total length, matches found as the longest common block, then the same
// on both sides of it (no junk heuristic; the texts are short).
func Ratio(a, b []rune) float64 {
	if len(a)+len(b) == 0 {
		return 1
	}
	return 2 * float64(matches(a, b)) / float64(len(a)+len(b))
}

func matches(a, b []rune) int {
	if len(a) == 0 || len(b) == 0 {
		return 0
	}
	// Longest common block; on ties the earliest in a, then in b (like difflib).
	bi, bj, bk := 0, 0, 0
	for i := range a {
		for j := range b {
			k := 0
			for i+k < len(a) && j+k < len(b) && a[i+k] == b[j+k] {
				k++
			}
			if k > bk {
				bi, bj, bk = i, j, k
			}
		}
	}
	if bk == 0 {
		return 0
	}
	return bk + matches(a[:bi], b[:bj]) + matches(a[bi+bk:], b[bj+bk:])
}

// Typo decides what to do with "/<body>" that is no command: fix (run
// entry with the rest as its arguments) or suggest; nothing when it isn't
// like any command. known: names that something else answers (skip).
func Typo(body string, entries []Entry, known []string) (fix *Guess, rest string, suggest []Guess) {
	if body == "" {
		return nil, "", nil
	}
	r, _ := utf8.DecodeRuneInString(body)
	if unicode.IsSpace(r) || unicode.IsDigit(r) || unicode.IsPunct(r) || strings.ContainsRune("/\\:：.。!！?？", r) {
		return nil, "", nil
	}
	low := strings.ToLower(body)
	for _, k := range known {
		if k != "" && strings.HasPrefix(low, strings.ToLower(k)) {
			return nil, "", nil
		}
	}
	sug := Suggest(body, entries, 3)
	if len(sug) == 0 {
		return nil, "", nil
	}
	second := 0.0
	if len(sug) > 1 {
		second = sug[1].Score
	}
	if top := sug[0]; top.Entry.Own && top.Entry.Safe && top.Score >= 0.74 && top.Score-second >= 0.05 {
		return &top, strings.TrimSpace(string([]rune(body)[top.Cut:])), nil
	}
	return nil, "", sug
}
