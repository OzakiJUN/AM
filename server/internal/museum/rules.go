// Package museum is a channel's picture museum (docs/design.md §13 博物馆),
// ported from Weiqi's qqmuseum: a first hall of 8 positions per channel, a
// second hall of the most liked works across public channels, a
// warehouse, likes, and votes when the channel has more than a few people.
//
// rules.go is the pure part (hall moves, second-hall order, votes);
// unit-tested.
package museum

import (
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"
)

// Slots is the number of positions in a first hall.
const Slots = 8

// MaxTitle is the longest title (runes).
const MaxTitle = 12

// Hang puts art at position pos (1–8) of hall, or at the first empty one
// when pos is 0. Works behind it move back one; an empty place behind it
// takes up the move, otherwise the last work drops out (pushed). The art is
// first taken out of the hall if it is already in it. full = pos 0 and no
// empty place.
func Hang(hall []int64, art int64, pos int) (next []int64, at int, pushed int64, full bool) {
	h := make([]int64, Slots)
	copy(h, hall)
	for i, a := range h {
		if a == art {
			h[i] = 0
		}
	}
	if pos <= 0 {
		pos = 0
		for i, a := range h {
			if a == 0 {
				pos = i + 1
				break
			}
		}
		if pos == 0 {
			return hall, 0, 0, true
		}
	}
	if pos > Slots {
		pos = Slots
	}
	p := pos - 1
	n := make([]int64, 0, Slots+1)
	n = append(n, h[:p]...)
	n = append(n, art)
	n = append(n, h[p:]...)
	// An empty place behind takes up the move; otherwise the last one drops out.
	for i := p + 1; i < len(n); i++ {
		if n[i] == 0 {
			n = append(n[:i], n[i+1:]...)
			return n[:Slots], pos, 0, false
		}
	}
	pushed = n[len(n)-1]
	return n[:Slots], pos, pushed, false
}

// Remove takes art out of hall (its place becomes empty).
func Remove(hall []int64, art int64) ([]int64, bool) {
	h := append([]int64(nil), hall...)
	for i, a := range h {
		if a == art {
			h[i] = 0
			return h, true
		}
	}
	return h, false
}

// Swap exchanges positions a and b (1–8).
func Swap(hall []int64, a, b int) []int64 {
	h := append([]int64(nil), hall...)
	h[a-1], h[b-1] = h[b-1], h[a-1]
	return h
}

// Entry is a hung work as the second hall sees it.
type Entry struct {
	ID      int64
	Likes   int
	HungAt  int64
	Created int64
	NSFW    bool
}

// Second picks the second hall: the most liked hung works (ties: hung
// earlier, then made earlier), skipping NSFW ones when the viewer's
// channel doesn't allow them.
func Second(all []Entry, nsfwOK bool) []int64 {
	list := make([]Entry, 0, len(all))
	for _, e := range all {
		if nsfwOK || !e.NSFW {
			list = append(list, e)
		}
	}
	sort.SliceStable(list, func(i, j int) bool {
		a, b := list[i], list[j]
		if a.Likes != b.Likes {
			return a.Likes > b.Likes
		}
		if a.HungAt != b.HungAt {
			return a.HungAt < b.HungAt
		}
		return a.Created < b.Created
	})
	out := []int64{}
	for i := 0; i < len(list) && i < Slots; i++ {
		out = append(out, list[i].ID)
	}
	return out
}

// NeedsVote: changes need a vote when the channel has more members than min.
func NeedsVote(members, min int) bool { return members > min }

// Passed: a vote fails only when more are against than for.
func Passed(yes, no int) bool { return no <= yes }

var minorRe = regexp.MustCompile(`(?i)(?:^|[^a-z])(?:loli|minor)(?:[^a-z]|$)|萝莉|未成年`)

// CleanTitle trims a title to MaxTitle runes ("无题" when empty); bad = it
// names minors (never shown).
func CleanTitle(t string) (title string, bad bool) {
	t = strings.TrimSpace(strings.Trim(strings.TrimSpace(t), "《》\"“”'「」"))
	if minorRe.MatchString(t) {
		return "", true
	}
	if utf8.RuneCountInString(t) > MaxTitle {
		t = string([]rune(t)[:MaxTitle])
	}
	if t == "" {
		t = "无题"
	}
	return t, false
}
