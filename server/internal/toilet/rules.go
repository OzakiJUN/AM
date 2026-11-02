// Package toilet is 电子厕所 (docs/design.md §10 内置 bot), from Weiqi's
// qqtoilet plugin: bad pictures (mostly AI drawings gone wrong) are thrown
// into 16 pits shared by the whole server and shown with who made them. The
// built-in bot runs the commands. rules.go is pure (tested).
package toilet

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/OzakiJUN/am/server/internal/museum"
)

// Pits is how many pictures the toilet holds; a new one flushes the oldest.
const Pits = 16

// PerPage pits are listed at a time.
const PerPage = 8

// PitNo reads 「冲 3」「坑位 No.3」: the pit number. ok = false when the text
// isn't a number at all (「冲啊」 is chat, not a command); msg says what's
// wrong with a number (empty pit, out of range).
func PitNo(args string, have int) (n int, ok bool, msg string) {
	t := strings.TrimSpace(args)
	t = strings.TrimPrefix(strings.TrimPrefix(t, "No."), "no.")
	t = strings.TrimLeft(t, "#＃")
	if t == "" {
		return 0, true, ""
	}
	n, err := strconv.Atoi(t)
	if err != nil {
		return 0, false, ""
	}
	switch {
	case n < 1 || n > Pits:
		return 0, true, fmt.Sprintf("坑位只有 1~%d", Pits)
	case n > have:
		return 0, true, fmt.Sprintf("第 %d 坑是空的", n)
	}
	return n, true, ""
}

// Page reads 「厕所 2」: 0 = pits 1–8, 1 = pits 9–16; ok = false for other text.
func Page(args string) (page int, ok bool) {
	switch strings.TrimSpace(args) {
	case "", "1", "一", "上":
		return 0, true
	case "2", "二", "下", "9":
		return 1, true
	}
	return 0, false
}

var reNsfwFlag = regexp.MustCompile(`(?i)^(nsfw|r18|NSFW)(\s+|$)`)

// ThrowArgs reads 「投厕 [nsfw] [标题]」: the NSFW mark and the title as typed.
func ThrowArgs(args string) (nsfw bool, title string) {
	t := strings.TrimSpace(args)
	if m := reNsfwFlag.FindString(t); m != "" {
		return true, strings.TrimSpace(t[len(m):])
	}
	return false, t
}

// CleanTitle is the museum's rule (12 characters, no 《》, nothing about
// minors); empty stays empty here (the caller names it).
func CleanTitle(t string) (title string, bad bool) {
	if strings.TrimSpace(strings.Trim(strings.TrimSpace(t), "《》\"“”'「」")) == "" {
		return "", false
	}
	return museum.CleanTitle(t)
}

var reAITitle = regexp.MustCompile(`\s*〔[^〕]*〕\s*$`)

// AITitle tidies the model's title: no brackets or quotes, at most 12.
func AITitle(t string) string {
	t = strings.TrimSpace(reAITitle.ReplaceAllString(t, ""))
	t = strings.Trim(t, "《》\"“”'「」。. \n")
	if r := []rune(t); len(r) > 12 {
		t = string(r[:12])
	}
	if t == "" {
		return "无名烂图"
	}
	return t
}

// Line is one pit in the list.
type Line struct {
	No      int
	Title   string
	Culprit string // "" = unknown
	By      string
	At      int64 // ms
	Hidden  bool  // NSFW where it isn't allowed
}

// List is 「厕所」's answer: one page of pits.
func List(lines []Line, page int, loc *time.Location) string {
	from := page*PerPage + 1
	out := []string{fmt.Sprintf("🚽 电子厕所 第 %d~%d 坑（全服务器共享）", from, from+PerPage-1)}
	for i := 0; i < PerPage; i++ {
		no := from + i
		var l *Line
		for j := range lines {
			if lines[j].No == no {
				l = &lines[j]
			}
		}
		switch {
		case l == nil:
			out = append(out, fmt.Sprintf("%d. （空）", no))
		case l.Hidden:
			out = append(out, fmt.Sprintf("%d. NSFW 已隐藏", no))
		default:
			who := "罪犯不明"
			if l.Culprit != "" {
				who = "罪犯：" + l.Culprit
			}
			out = append(out, fmt.Sprintf("%d.《%s》%s｜%s 投的｜%s", no, l.Title, who, l.By, time.UnixMilli(l.At).In(loc).Format("01-02")))
		}
	}
	more := "/厕所 2 看第 9~16 坑"
	if page == 1 {
		more = "/厕所 看第 1~8 坑"
	}
	return strings.Join(out, "\n") + "\n/坑位 <序号> 单看，/捞 <序号> 发原图，/冲 <序号> 冲掉；" + more
}
