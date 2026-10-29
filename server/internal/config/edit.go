package config

import (
	"fmt"
	"strconv"
	"strings"
	"unicode"
)

// Change sets one key. Value must be a string, bool, int or []string.
type Change struct {
	Section string
	Key     string
	Value   any
}

// Apply returns text with the changes made, keeping comments, order and
// line endings. A key's line is replaced in place; a missing key is added at
// the end of its section; a missing section is appended. Only single-line
// values are supported (all settings the admin panel edits are). The result
// is validated.
func Apply(text string, changes []Change) (string, error) {
	nl := "\n"
	if strings.Contains(text, "\r\n") {
		nl = "\r\n"
	}
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	for _, c := range changes {
		v, err := encodeValue(c.Value)
		if err != nil {
			return "", fmt.Errorf("%s.%s: %w", c.Section, c.Key, err)
		}
		lines = applyOne(lines, c.Section, c.Key, v)
	}
	out := strings.Join(lines, nl)
	if _, err := Parse(out); err != nil {
		return "", err
	}
	return out, nil
}

func applyOne(lines []string, section, key, value string) []string {
	start, end := -1, len(lines) // section body is lines[start+1:end]
	for i, l := range lines {
		name, ok := sectionName(l)
		if !ok {
			continue
		}
		if start >= 0 {
			end = i
			break
		}
		if name == section {
			start = i
		}
	}
	newLine := key + " = " + value
	if start < 0 {
		// Append a new section, separated by a blank line.
		for len(lines) > 0 && strings.TrimSpace(lines[len(lines)-1]) == "" {
			lines = lines[:len(lines)-1]
		}
		return append(lines, "", "["+section+"]", newLine, "")
	}
	for i := start + 1; i < end; i++ {
		if lineKey(lines[i]) == key {
			indent := lines[i][:len(lines[i])-len(strings.TrimLeftFunc(lines[i], unicode.IsSpace))]
			lines[i] = indent + newLine
			return lines
		}
	}
	// Insert after the last non-blank line of the section.
	at := end
	for at > start+1 && strings.TrimSpace(lines[at-1]) == "" {
		at--
	}
	lines = append(lines[:at], append([]string{newLine}, lines[at:]...)...)
	return lines
}

// sectionName returns "server" for a line like "[server]  # comment".
func sectionName(line string) (string, bool) {
	l := strings.TrimSpace(line)
	if !strings.HasPrefix(l, "[") || strings.HasPrefix(l, "[[") {
		return "", false
	}
	endIdx := strings.Index(l, "]")
	if endIdx < 0 {
		return "", false
	}
	return strings.TrimSpace(l[1:endIdx]), true
}

// lineKey returns the bare key of a "key = value" line, "" otherwise.
func lineKey(line string) string {
	l := strings.TrimSpace(line)
	if l == "" || l[0] == '#' || l[0] == '[' {
		return ""
	}
	eq := strings.Index(l, "=")
	if eq <= 0 {
		return ""
	}
	return strings.Trim(strings.TrimSpace(l[:eq]), `"`)
}

func encodeValue(v any) (string, error) {
	switch x := v.(type) {
	case string:
		return quote(x), nil
	case bool:
		return strconv.FormatBool(x), nil
	case int:
		return strconv.Itoa(x), nil
	case int64:
		return strconv.FormatInt(x, 10), nil
	case []string:
		parts := make([]string, len(x))
		for i, s := range x {
			parts[i] = quote(s)
		}
		return "[" + strings.Join(parts, ", ") + "]", nil
	default:
		return "", fmt.Errorf("unsupported value type %T", v)
	}
}

// quote writes a TOML basic string.
func quote(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch {
		case r == '"':
			b.WriteString(`\"`)
		case r == '\\':
			b.WriteString(`\\`)
		case r == '\n':
			b.WriteString(`\n`)
		case r == '\t':
			b.WriteString(`\t`)
		case r < 0x20 || r == 0x7f:
			fmt.Fprintf(&b, `\u%04X`, r)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}
