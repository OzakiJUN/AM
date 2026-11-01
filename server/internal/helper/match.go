// Package helper is the server's built-in bot (docs/design.md §10 内置 bot):
// one bot account that answers "/" commands in channels and in DMs with it.
// Features (游戏资讯, 电子厕所, 指令查询) register their commands here.
package helper

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

// Match finds the command a message starts with: "/资讯 dota2" →
// ("资讯", "dota2"). Leading @-mentions are skipped; the longest name wins
// ("/资讯源" is 资讯源, not 资讯 with "源"); ASCII names ignore case. names
// are the command names and aliases without "/".
func Match(text string, names []string) (name, args string, ok bool) {
	t := strings.TrimSpace(text)
	for strings.HasPrefix(t, "@") {
		i := strings.IndexFunc(t, unicode.IsSpace)
		if i < 0 {
			return "", "", false
		}
		t = strings.TrimSpace(t[i:])
	}
	switch {
	case strings.HasPrefix(t, "/"):
		t = t[1:]
	case strings.HasPrefix(t, "／"):
		t = t[len("／"):]
	default:
		return "", "", false
	}
	low := strings.ToLower(t)
	for _, n := range names {
		if n == "" || len(n) <= len(name) {
			continue
		}
		if strings.HasPrefix(low, strings.ToLower(n)) {
			rest := t[len(n):]
			// "/nai5" is not "/nai" + "5" when the name ends in a letter and the
			// rest goes on with one: ASCII words must end at a word boundary.
			if r, _ := utf8.DecodeRuneInString(rest); rest != "" && isWord(lastRune(n)) && isWord(r) {
				continue
			}
			name, args = n, strings.TrimSpace(rest)
		}
	}
	return name, args, name != ""
}

func isWord(r rune) bool { return r < 128 && (unicode.IsLetter(r) || unicode.IsDigit(r)) }

func lastRune(s string) rune {
	r, _ := utf8.DecodeLastRuneInString(s)
	return r
}

// Split cuts a long text into pieces of at most max runes, at blank lines
// when it can, then at line ends, then anywhere.
func Split(text string, max int) []string {
	text = strings.TrimSpace(text)
	if max < 1 || utf8.RuneCountInString(text) <= max {
		return []string{text}
	}
	var out []string
	cur := ""
	flush := func() {
		if s := strings.TrimSpace(cur); s != "" {
			out = append(out, s)
		}
		cur = ""
	}
	add := func(part, sep string) {
		if cur == "" {
			cur = part
		} else if utf8.RuneCountInString(cur)+utf8.RuneCountInString(sep+part) <= max {
			cur += sep + part
		} else {
			flush()
			cur = part
		}
	}
	for _, block := range strings.Split(text, "\n\n") {
		if utf8.RuneCountInString(block) <= max {
			add(block, "\n\n")
			continue
		}
		for _, line := range strings.Split(block, "\n") {
			for utf8.RuneCountInString(line) > max {
				r := []rune(line)
				add(string(r[:max]), "\n")
				line = string(r[max:])
			}
			add(line, "\n")
		}
	}
	flush()
	return out
}
