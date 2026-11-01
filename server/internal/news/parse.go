// Package news is 游戏资讯 (docs/design.md §10 内置 bot), ported from
// Weiqi's qqnews plugin: follow games / companies by keyword, gather what
// many sites say about them every hour, let a model group it into events
// and score them, push big news at once, post a digest every evening and
// an X (Twitter) report every week. The built-in bot posts everything.
//
// parse.go and rank.go are pure (tested); sources.go fetches, ai.go asks
// the model, service.go keeps state, schedules and answers commands.
package news

import (
	"fmt"
	"html"
	"net/mail"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
)

// Item is one thing a source found.
type Item struct {
	Src      string  `json:"src"` // bili news bing reddit youtube steam steamnews weibo tieba nga
	Title    string  `json:"title"`
	URL      string  `json:"url"`
	Heat     float64 `json:"heat"`
	HasHeat  bool    `json:"has_heat,omitempty"` // Heat is a real number (views, replies…)
	Official bool    `json:"official,omitempty"`
	TS       int64   `json:"ts,omitempty"` // unix seconds, 0 = unknown
	// Body: the start of the text (Steam media reports, group posts) for a Chinese summary.
	Body string `json:"body,omitempty"`
	// Feed: which Steam feed (media name / 群组公告).
	Feed string `json:"feed,omitempty"`
	// H: heat among this source's results (0–1), set by Rank.
	H float64 `json:"h,omitempty"`
	// Steam items: Chinese title and summary from the model.
	Zh      string `json:"zh,omitempty"`
	Summary string `json:"summary,omitempty"`
}

func newItem(src, title, url string, heat float64, hasHeat, official bool, ts int64) Item {
	t := []rune(Clean(title))
	if len(t) > 120 {
		t = t[:120]
	}
	return Item{Src: src, Title: string(t), URL: url, Heat: heat, HasHeat: hasHeat, Official: official, TS: ts}
}

// SrcName is how a source is shown.
var SrcName = map[string]string{"bili": "B站", "news": "新闻", "bing": "新闻", "reddit": "Reddit", "youtube": "YouTube",
	"steam": "Steam官方", "steamnews": "Steam新闻", "weibo": "微博", "tieba": "贴吧", "nga": "NGA"}

// AllSources in the order they are listed.
var AllSources = []string{"bili", "news", "bing", "reddit", "youtube", "steam", "weibo", "tieba", "nga"}

var (
	reTag   = regexp.MustCompile(`<[^>]+>`)
	reSpace = regexp.MustCompile(`\s+`)
	reNum   = regexp.MustCompile(`([\d.]+)\s*([万亿kKmMbB]?)`)
	reBB    = regexp.MustCompile(`\[/?[a-zA-Z0-9*]+(?:=[^\]]*)?\]`)
	reLink  = regexp.MustCompile(`https?://\S+|\{STEAM_CLAN_IMAGE\}\S*`)
	reAgo   = regexp.MustCompile(`(?i)(\d+)\s*(秒|分钟|小时|天|周|个月|月|年|second|minute|hour|day|week|month|year)`)
)

// Clean strips HTML tags and entities and squeezes spaces.
func Clean(t string) string {
	return strings.TrimSpace(reSpace.ReplaceAllString(html.UnescapeString(reTag.ReplaceAllString(t, "")), " "))
}

// Plain turns a Steam post (BBCode / HTML / links) into plain text.
func Plain(t string) string {
	t = reBB.ReplaceAllString(t, " ")
	t = reTag.ReplaceAllString(t, " ")
	t = reLink.ReplaceAllString(t, " ")
	return strings.TrimSpace(reSpace.ReplaceAllString(html.UnescapeString(t), " "))
}

// Num reads "1.2万次观看", "3,456 views", "1.2K" as a number.
func Num(text string) float64 {
	m := reNum.FindStringSubmatch(strings.ReplaceAll(text, ",", ""))
	if m == nil {
		return 0
	}
	v, _ := strconv.ParseFloat(m[1], 64)
	mul := map[string]float64{"万": 1e4, "亿": 1e8, "k": 1e3, "K": 1e3, "m": 1e6, "M": 1e6, "b": 1e9, "B": 1e9}[m[2]]
	if mul == 0 {
		mul = 1
	}
	return v * mul
}

// Ago reads "3 天前", "2 weeks ago", "Streamed 5 hours ago" (0 = can't tell).
func Ago(text string, now time.Time) int64 {
	m := reAgo.FindStringSubmatch(text)
	if m == nil {
		return 0
	}
	n, _ := strconv.Atoi(m[1])
	sec := map[string]int64{"秒": 1, "second": 1, "分钟": 60, "minute": 60, "小时": 3600, "hour": 3600, "天": 86400, "day": 86400,
		"周": 604800, "week": 604800, "个月": 2592000, "月": 2592000, "month": 2592000, "年": 31536000, "year": 31536000}[strings.ToLower(m[2])]
	if sec == 0 {
		return 0
	}
	return now.Unix() - int64(n)*sec
}

// RSSItem is one <item> of an RSS feed.
type RSSItem struct {
	Title, Link, Desc string
	TS                int64
}

var (
	reItem  = regexp.MustCompile(`(?s)<item>(.*?)</item>`)
	reTitle = regexp.MustCompile(`(?s)<title>(.*?)</title>`)
	reLinkT = regexp.MustCompile(`(?s)<link>(.*?)</link>`)
	rePub   = regexp.MustCompile(`(?s)<pubDate>(.*?)</pubDate>`)
	reDesc  = regexp.MustCompile(`(?s)<description>(.*?)</description>`)
	reCData = regexp.MustCompile(`<!\[CDATA\[|\]\]>`)
)

func cdata(t string) string { return strings.TrimSpace(reCData.ReplaceAllString(t, "")) }

// ParseRSS reads an RSS feed, keeping items from the last maxAgeDays
// (items without a date are kept; Steam feeds hold very old posts).
func ParseRSS(text string, maxAgeDays float64, now time.Time) []RSSItem {
	var out []RSSItem
	for _, m := range reItem.FindAllStringSubmatch(text, -1) {
		it := m[1]
		t, lk := reTitle.FindStringSubmatch(it), reLinkT.FindStringSubmatch(it)
		if t == nil || lk == nil {
			continue
		}
		var ts int64
		if pd := rePub.FindStringSubmatch(it); pd != nil {
			if d, err := mail.ParseDate(cdata(pd[1])); err == nil {
				ts = d.Unix()
				if float64(now.Unix()-ts) > maxAgeDays*86400 {
					continue
				}
			}
		}
		r := RSSItem{Title: html.UnescapeString(cdata(t[1])), Link: html.UnescapeString(cdata(lk[1])), TS: ts}
		if ds := reDesc.FindStringSubmatch(it); ds != nil {
			r.Desc = html.UnescapeString(cdata(ds[1]))
		}
		out = append(out, r)
	}
	return out
}

var (
	reYMD    = regexp.MustCompile(`^(\d{4})-(\d{1,2})-(\d{1,2})`)
	reMD     = regexp.MustCompile(`^(\d{1,2})-(\d{1,2})`)
	reHM     = regexp.MustCompile(`^(\d{1,2}):(\d{2})$`)
	reYM     = regexp.MustCompile(`^(\d{4})-(\d{1,2})$`)
	reMDOnly = regexp.MustCompile(`^(\d{1,2})-(\d{1,2})$`)
)

func atoi(s string) int { n, _ := strconv.Atoi(s); return n }

func day(y, m, d int, loc *time.Location) int64 {
	return time.Date(y, time.Month(m), d, 0, 0, 0, 0, loc).Unix()
}

// WeiboTime reads Weibo's created_at: "Mon Oct 13 12:00:00 +0800 2026",
// "刚刚", "5分钟前", "昨天 12:00", "10-12", "2024-10-12" (0 = can't tell).
func WeiboTime(s string, now time.Time) int64 {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0
	}
	if t, err := time.Parse("Mon Jan 02 15:04:05 -0700 2006", s); err == nil {
		return t.Unix()
	}
	if s == "刚刚" {
		return now.Unix()
	}
	if a := Ago(s, now); a != 0 {
		return a
	}
	loc := now.Location()
	if strings.HasPrefix(s, "昨天") {
		y := now.AddDate(0, 0, -1)
		return day(y.Year(), int(y.Month()), y.Day(), loc)
	}
	if m := reYMD.FindStringSubmatch(s); m != nil {
		return day(atoi(m[1]), atoi(m[2]), atoi(m[3]), loc)
	}
	if m := reMD.FindStringSubmatch(s); m != nil {
		return day(now.Year(), atoi(m[1]), atoi(m[2]), loc)
	}
	return 0
}

// TiebaTime reads a Tieba thread's creation time: "12:34" today, "10-12"
// this year (last year when that's in the future), "2024-05" older.
func TiebaTime(s string, now time.Time) int64 {
	s = strings.TrimSpace(s)
	loc := now.Location()
	if m := reHM.FindStringSubmatch(s); m != nil {
		return day(now.Year(), int(now.Month()), now.Day(), loc) + int64(atoi(m[1])*3600+atoi(m[2])*60)
	}
	if m := reYM.FindStringSubmatch(s); m != nil {
		return day(atoi(m[1]), atoi(m[2]), 1, loc)
	}
	if m := reMDOnly.FindStringSubmatch(s); m != nil {
		t := day(now.Year(), atoi(m[1]), atoi(m[2]), loc)
		if t > now.Unix() {
			t = day(now.Year()-1, atoi(m[1]), atoi(m[2]), loc)
		}
		return t
	}
	return 0
}

// MD shows a date as "10-12", or "2024-10-12" when not this year.
func MD(ts int64, now time.Time) string {
	if ts == 0 {
		return ""
	}
	d := time.Unix(ts, 0).In(now.Location())
	if d.Year() == now.Year() {
		return d.Format("01-02")
	}
	return d.Format("2006-01-02")
}

// Norm keeps letters and digits, lower case (for comparing names).
func Norm(t string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(t) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// IsASCII: only ASCII characters.
func IsASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 {
			return false
		}
	}
	return true
}

var reWords = regexp.MustCompile(`[A-Za-z0-9]+`)

// GroupCandidates guesses a company's Steam group names from its English
// names: MangoParty, Mango_Party, Mango-Party, mangoparty… (at most 8).
func GroupCandidates(names []string) []string {
	var out []string
	add := func(v string) {
		for _, x := range out {
			if x == v {
				return
			}
		}
		if v != "" {
			out = append(out, v)
		}
	}
	for _, n := range names {
		n = strings.TrimSpace(n)
		if n == "" || !IsASCII(n) {
			continue
		}
		w := reWords.FindAllString(n, -1)
		caps := make([]string, len(w))
		for i, x := range w {
			caps[i] = strings.ToUpper(x[:1]) + strings.ToLower(x[1:])
		}
		add(strings.Join(w, ""))
		add(strings.Join(w, "_"))
		add(strings.Join(w, "-"))
		add(strings.ToLower(strings.Join(w, "")))
		add(strings.Join(caps, ""))
	}
	if len(out) > 8 {
		out = out[:8]
	}
	return out
}

var (
	reSteamArg = regexp.MustCompile(`(?i)steam[:：]\s*(\d+)`)
	reSplitKW  = regexp.MustCompile(`[|｜/]`)
)

// ParseFollow reads 「关注游戏 dota2|刀塔 steam:570」: keyword, aliases, Steam appid.
func ParseFollow(raw string) (kw string, alias []string, steam int64) {
	if m := reSteamArg.FindStringSubmatch(raw); m != nil {
		steam, _ = strconv.ParseInt(m[1], 10, 64)
	}
	raw = strings.TrimSpace(reSteamArg.ReplaceAllString(raw, ""))
	for _, p := range reSplitKW.Split(raw, -1) {
		if p = strings.TrimSpace(p); p != "" {
			if kw == "" {
				kw = p
			} else {
				alias = append(alias, p)
			}
		}
	}
	if r := []rune(kw); len(r) > 30 {
		kw = string(r[:30])
	}
	if len(alias) > 5 {
		alias = alias[:5]
	}
	return kw, alias, steam
}

var (
	reKindGroup = regexp.MustCompile(`群组\s*[:：]\s*(?:https?://steamcommunity\.com/groups/)?([A-Za-z0-9_\-]+)/?`)
	reKindSteam = regexp.MustCompile(`(?i)steam\s*[:：]\s*([\d,，\s]+)`)
	reKindDrop  = regexp.MustCompile(`(?i)群组\s*[:：]\s*\S+|steam\s*[:：]\s*[\d,，\s]+`)
	reKindTail  = regexp.MustCompile(`^(.+?)\s+(厂商|公司|发行商|开发商|游戏|自动)$`)
	reDigits    = regexp.MustCompile(`\d+`)
)

// KindArgs is 「资讯类型 芒果派对 厂商 群组:MangoParty steam:1,2」.
type KindArgs struct {
	Name  string
	Kind  string // company | game | auto | "" (just show)
	Group string
	Apps  []int64
}

// ParseKind reads the 资讯类型 command.
func ParseKind(t string) KindArgs {
	var k KindArgs
	if m := reKindGroup.FindStringSubmatch(t); m != nil {
		k.Group = m[1]
	}
	if m := reKindSteam.FindStringSubmatch(t); m != nil {
		for _, d := range reDigits.FindAllString(m[1], -1) {
			if n, err := strconv.ParseInt(d, 10, 64); err == nil {
				k.Apps = append(k.Apps, n)
			}
		}
	}
	t = strings.TrimSpace(reKindDrop.ReplaceAllString(t, " "))
	m := reKindTail.FindStringSubmatch(t)
	if m == nil {
		k.Name = t
		return k
	}
	k.Name = strings.TrimSpace(m[1])
	switch m[2] {
	case "游戏":
		k.Kind = "game"
	case "自动":
		k.Kind = "auto"
	default:
		k.Kind = "company"
	}
	return k
}

// HM reads "21:00" (also with a full-width colon).
func HM(s string) (h, m int, err error) {
	p := strings.Split(strings.ReplaceAll(strings.TrimSpace(s), "：", ":"), ":")
	if len(p) != 2 {
		return 0, 0, fmt.Errorf("time %q is not HH:MM", s)
	}
	h, e1 := strconv.Atoi(p[0])
	m, e2 := strconv.Atoi(p[1])
	if e1 != nil || e2 != nil || h < 0 || h > 23 || m < 0 || m > 59 {
		return 0, 0, fmt.Errorf("time %q is not HH:MM", s)
	}
	return h, m, nil
}

// Weekday reads "sun", "mon"… or 0–6 (0 = Sunday).
func Weekday(s string) (time.Weekday, error) {
	s = strings.ToLower(strings.TrimSpace(s))
	for i, n := range []string{"sun", "mon", "tue", "wed", "thu", "fri", "sat"} {
		if strings.HasPrefix(s, n) || s == strconv.Itoa(i) {
			return time.Weekday(i), nil
		}
	}
	return 0, fmt.Errorf("weekday %q: use sun, mon … sat", s)
}
