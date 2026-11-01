package sticker

import (
	"encoding/hex"
	"math/bits"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/OzakiJUN/am/server/internal/store"
)

// Pure helpers: when two pictures count as the same, and how everyone's
// tags are put together. Unit-tested in match_test.go.

type print struct {
	h        [4]uint64
	animated bool
	ratio    int
}

func parsePrint(fp string, animated bool, ratio int) (print, bool) {
	b, err := hex.DecodeString(fp)
	if err != nil || len(b) != 32 {
		return print{}, false
	}
	var p print
	for i := 0; i < 4; i++ {
		for j := 0; j < 8; j++ {
			p.h[i] = p.h[i]<<8 | uint64(b[i*8+j])
		}
	}
	p.animated, p.ratio = animated, ratio
	return p, true
}

// comparable reports whether near-duplicate matching may be used at all:
// the picture had enough contrast to get a fingerprint.
func (p print) comparable() bool { return p.h != [4]uint64{} }

func distance(a, b print) int {
	n := 0
	for i := range a.h {
		n += bits.OnesCount64(a.h[i] ^ b.h[i])
	}
	return n
}

// same reports whether b looks like the same picture as a: both have a
// fingerprint, both animated or both still, nearly the same shape, and
// fingerprints at most maxDist bits apart.
func same(a, b print, maxDist int) bool {
	if maxDist <= 0 || !a.comparable() || !b.comparable() || a.animated != b.animated {
		return false
	}
	lo, hi := a.ratio, b.ratio
	if lo > hi {
		lo, hi = hi, lo
	}
	if lo <= 0 || (hi-lo)*100 > lo*5 {
		return false
	}
	return distance(a, b) <= maxDist
}

// closest returns the library picture that looks most like p (0 = none).
func closest(p print, list []store.LibraryPrint, maxDist int) int64 {
	best, bestD := int64(0), maxDist+1
	for _, l := range list {
		q, ok := parsePrint(l.Fingerprint, l.Animated, l.Ratio)
		if !ok || !same(p, q, maxDist) {
			continue
		}
		if d := distance(p, q); d < bestD {
			best, bestD = l.ID, d
		}
	}
	return best
}

// ratioOf is width/height in thousandths.
func ratioOf(w, h int) int {
	if h <= 0 {
		return 0
	}
	return w * 1000 / h
}

// tagKey is how tags are compared: case and spacing do not matter.
func tagKey(t string) string {
	return strings.ToLower(strings.Join(strings.Fields(t), " "))
}

// cleanTags trims tags, drops empty and repeated ones and keeps at most max
// of at most MaxTagLen characters.
func cleanTags(in []string, max int) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, t := range in {
		t = strings.Join(strings.Fields(t), " ")
		if utf8.RuneCountInString(t) > MaxTagLen {
			t = string([]rune(t)[:MaxTagLen])
		}
		k := strings.ToLower(t)
		if t == "" || seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, t)
		if len(out) == max {
			break
		}
	}
	return out
}

// mergeTags puts everyone's tags on one picture together: one entry per
// tag, the most-added first (then the oldest), written the way the first
// person wrote it. mine are the ones `me` added.
func mergeTags(rows []store.LibraryTag, me int64) (all, mine []string) {
	type agg struct {
		tag   string
		n     int
		first int64
		mine  bool
	}
	by := map[string]*agg{}
	var keys []string
	for _, r := range rows {
		a := by[r.Key]
		if a == nil {
			a = &agg{tag: r.Tag, first: r.AddedAt}
			by[r.Key] = a
			keys = append(keys, r.Key)
		}
		a.n++
		if r.AddedAt < a.first {
			a.first, a.tag = r.AddedAt, r.Tag
		}
		if r.AddedBy == me {
			a.mine = true
		}
	}
	sort.SliceStable(keys, func(i, j int) bool {
		a, b := by[keys[i]], by[keys[j]]
		if a.n != b.n {
			return a.n > b.n
		}
		return a.first < b.first
	})
	all, mine = []string{}, []string{}
	for _, k := range keys {
		all = append(all, by[k].tag)
		if by[k].mine {
			mine = append(mine, by[k].tag)
		}
	}
	return all, mine
}
