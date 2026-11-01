package news

import (
	"crypto/md5"
	"encoding/hex"
	"fmt"
	"math"
	"slices"
	"sort"
	"strings"
	"time"
)

// Event is what the model grouped: one thing many posts talk about.
type Event struct {
	Title     string   `json:"title"`
	Type      string   `json:"type"`
	Major     bool     `json:"major,omitempty"`
	Repeat    bool     `json:"repeat,omitempty"`
	Platforms []string `json:"platforms"`
	N         int      `json:"n"`
	MaxH      float64  `json:"maxh"`
	Official  bool     `json:"official,omitempty"`
	URL       string   `json:"url"`
	TS        int64    `json:"ts,omitempty"`
	Summary   string   `json:"summary,omitempty"`
	Score     float64  `json:"score"`
}

// Hash is the short id of a link (seen lists).
func Hash(url string) string {
	s := md5.Sum([]byte(url))
	return hex.EncodeToString(s[:])[:16]
}

// Rank sets each item's heat among its source's results (rank percentile;
// no number = 0.5, official = 1) and keeps the hottest perSource of each
// source (twice as many for B站 and news).
func Rank(items []Item, perSource int) []Item {
	by := map[string][]Item{}
	var order []string
	for _, it := range items {
		if _, ok := by[it.Src]; !ok {
			order = append(order, it.Src)
		}
		by[it.Src] = append(by[it.Src], it)
	}
	var out []Item
	for _, src := range order {
		lst := by[src]
		var valued []int
		for i := range lst {
			if lst[i].HasHeat {
				valued = append(valued, i)
			}
		}
		sort.SliceStable(valued, func(a, b int) bool { return lst[valued[a]].Heat < lst[valued[b]].Heat })
		for rank, i := range valued {
			lst[i].H = math.Round(float64(rank+1)/float64(len(valued))*1000) / 1000
		}
		for i := range lst {
			if lst[i].Official {
				lst[i].H = 1
			} else if !lst[i].HasHeat {
				lst[i].H = 0.5
			}
		}
		sort.SliceStable(lst, func(a, b int) bool { return lst[a].H > lst[b].H })
		n := perSource
		if src == "bili" || src == "news" || src == "bing" {
			n *= 2
		}
		out = append(out, lst[:min(n, len(lst))]...)
	}
	return out
}

// Score = 3×platforms + 2×log2(1+posts) + 3×top heat + 3 official + 2 major.
func Score(e Event) float64 {
	s := 3*float64(len(e.Platforms)) + 2*math.Log2(1+float64(e.N)) + 3*e.MaxH
	if e.Official {
		s += 3
	}
	if e.Major {
		s += 2
	}
	return math.Round(s*100) / 100
}

var pushTypes = []string{"official_update", "content", "esports", "controversy"}

// Urgent: pushed at once — big, new (this week), not pushed before, and
// official / on 2+ platforms / in the top 10% of its site.
func Urgent(e Event, now time.Time) bool {
	if e.TS != 0 && now.Unix()-e.TS > 7*86400 {
		return false
	}
	return e.Major && !e.Repeat && slices.Contains(pushTypes, e.Type) &&
		(e.Official || len(e.Platforms) >= 2 || e.MaxH >= 0.9)
}

// PickDigest takes the top events; ones only on B站 take at most half.
func PickDigest(events []Event, top int) []Event {
	sorted := slices.Clone(events)
	sort.SliceStable(sorted, func(a, b int) bool { return sorted[a].Score > sorted[b].Score })
	var out []Event
	biliOnly := 0
	for _, e := range sorted {
		if len(e.Platforms) == 1 && e.Platforms[0] == "B站" {
			if biliOnly >= top/2 {
				continue
			}
			biliOnly++
		}
		out = append(out, e)
		if len(out) >= top {
			break
		}
	}
	return out
}

var typeMark = map[string]string{"official_update": "📢", "content": "✨", "esports": "🏆", "controversy": "💥", "meme": "😂", "discussion": "💬"}

// FormatEvent is one event in a message.
func FormatEvent(e Event, now time.Time) string {
	fire := "🔥"
	if e.Score >= 14 {
		fire = "🔥🔥🔥"
	} else if e.Score >= 9 {
		fire = "🔥🔥"
	}
	mark := typeMark[e.Type]
	if mark == "" {
		mark = "•"
	}
	date := ""
	if e.TS != 0 {
		date = "｜" + MD(e.TS, now)
	}
	summ := ""
	if e.Summary != "" {
		summ = "\n   📝 " + e.Summary
	}
	return fmt.Sprintf("%s %s\n   %s %s｜%d 条%s%s\n   %s", mark, e.Title, fire, strings.Join(e.Platforms, "·"), e.N, date, summ, e.URL)
}

// FormatSteam is one Steam item in a message.
func FormatSteam(i Item, now time.Time) string {
	tag := i.Feed
	if tag == "" {
		tag = "媒体"
		if i.Official {
			tag = "官方"
		}
	}
	date := ""
	if i.TS != 0 {
		date = "〔" + MD(i.TS, now) + "〕"
	}
	title := i.Zh
	if title == "" {
		title = i.Title
	}
	line := fmt.Sprintf("• %s%s｜%s", date, title, tag)
	if i.Summary != "" {
		line += "\n   📝 " + i.Summary
	}
	return line + "\n   " + i.URL
}

// ClusterLines lists items for the model: "1. [B站] 标题 (0.8) 〔10-12〕｜正文：…".
func ClusterLines(items []Item, now time.Time) string {
	var b strings.Builder
	for n, i := range items {
		fmt.Fprintf(&b, "%d. [%s", n+1, SrcName[i.Src])
		if i.Feed != "" {
			b.WriteString("·" + i.Feed)
		}
		fmt.Fprintf(&b, "] %s (%g)", i.Title, i.H)
		if i.TS != 0 {
			b.WriteString(" 〔" + MD(i.TS, now) + "〕")
		}
		if i.Body != "" {
			b.WriteString("｜正文：" + cut(i.Body, 220))
		}
		b.WriteByte('\n')
	}
	return strings.TrimRight(b.String(), "\n")
}

func cut(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}

// AIEvent is one event as the model wrote it.
type AIEvent struct {
	Title   string `json:"title"`
	Items   []int  `json:"items"`
	Type    string `json:"type"`
	Major   bool   `json:"major"`
	Repeat  bool   `json:"repeat"`
	Summary string `json:"summary"`
}

var dropTypes = []string{"ad", "irrelevant", "guide"}

// BuildEvents turns the model's grouping into scored events (best first).
// Ads / unrelated / guides are dropped, except official posts (a launch or
// a sale is not an ad); each item counts in one event only.
func BuildEvents(items []Item, ai []AIEvent) []Event {
	used := map[int]bool{}
	valid := func(k int) bool { return k >= 1 && k <= len(items) }
	var out []Event
	for _, e := range ai {
		if slices.Contains(dropTypes, e.Type) {
			official := false
			for _, k := range e.Items {
				if valid(k) && items[k-1].Official {
					official = true
				}
			}
			if !official {
				for _, k := range e.Items {
					used[k] = true
				}
				continue
			}
			e.Type = "official_update"
		}
		var mem []Item
		for _, k := range e.Items {
			if valid(k) && !used[k] {
				used[k] = true
				mem = append(mem, items[k-1])
			}
		}
		if len(mem) == 0 || strings.TrimSpace(e.Title) == "" {
			continue
		}
		if e.Type == "" {
			e.Type = "discussion"
		}
		best := mem[0]
		ev := Event{Title: cut(strings.TrimSpace(e.Title), 80), Type: e.Type, Major: e.Major, Repeat: e.Repeat, N: len(mem), Summary: cut(strings.TrimSpace(e.Summary), 150)}
		plat := map[string]bool{}
		for _, i := range mem {
			plat[SrcName[i.Src]] = true
			ev.MaxH = max(ev.MaxH, i.H)
			ev.Official = ev.Official || i.Official
			ev.TS = max(ev.TS, i.TS)
			if (i.Official && !best.Official) || (i.Official == best.Official && i.H > best.H) {
				best = i
			}
		}
		ev.Platforms = sortedKeys(plat)
		ev.URL = best.URL
		ev.Score = Score(ev)
		out = append(out, ev)
	}
	sort.SliceStable(out, func(a, b int) bool { return out[a].Score > out[b].Score })
	return out
}

// Plain events, one per item: when no model is set up (or it failed).
func PlainEvents(items []Item) []Event {
	var out []Event
	for _, i := range items {
		ev := Event{Title: i.Title, Type: "discussion", Platforms: []string{SrcName[i.Src]}, N: 1, MaxH: i.H, Official: i.Official, URL: i.URL, TS: i.TS}
		if i.Official {
			ev.Type = "official_update"
		}
		ev.Score = Score(ev)
		out = append(out, ev)
	}
	sort.SliceStable(out, func(a, b int) bool { return out[a].Score > out[b].Score })
	return out
}

func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// AIGroup is one group from the evening merge.
type AIGroup struct {
	Title string `json:"title"`
	Items []int  `json:"items"`
}

// MergeGroups merges the day's events the model said are the same thing:
// posts and platforms add up; ungrouped events stay as they are.
func MergeGroups(events []Event, groups []AIGroup) []Event {
	used := map[int]bool{}
	var out []Event
	for _, g := range groups {
		var mem []Event
		for _, k := range g.Items {
			if k >= 1 && k <= len(events) && !used[k] {
				used[k] = true
				mem = append(mem, events[k-1])
			}
		}
		if len(mem) == 0 {
			continue
		}
		best := mem[0]
		for _, e := range mem[1:] {
			if e.Score > best.Score {
				best = e
			}
		}
		ev := best
		if t := strings.TrimSpace(g.Title); t != "" {
			ev.Title = cut(t, 80)
		}
		plat := map[string]bool{}
		ev.N, ev.MaxH, ev.Official, ev.Major, ev.TS = 0, 0, false, false, 0
		for _, e := range mem {
			for _, p := range e.Platforms {
				plat[p] = true
			}
			ev.N += e.N
			ev.MaxH = max(ev.MaxH, e.MaxH)
			ev.Official = ev.Official || e.Official
			ev.Major = ev.Major || e.Major
			ev.TS = max(ev.TS, e.TS)
		}
		ev.Platforms = sortedKeys(plat)
		ev.Score = Score(ev)
		out = append(out, ev)
	}
	for k, e := range events {
		if !used[k+1] {
			out = append(out, e)
		}
	}
	return out
}
