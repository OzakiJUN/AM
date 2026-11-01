package plugin

// OneBot v11 on our side: AM events become OneBot message events, and the
// messages plugins send (segments or CQ-code strings) become AM messages.
// Ids map 1:1: user_id = AM user id, group_id = channel id, message_id = AM
// event id. Pure, unit-tested (onebot_test.go).

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
)

// Segment is one OneBot message segment.
type Segment struct {
	Type string         `json:"type"`
	Data map[string]any `json:"data"`
}

func (s Segment) str(k string) string {
	switch v := s.Data[k].(type) {
	case string:
		return v
	case float64:
		return strconv.FormatInt(int64(v), 10)
	case json.Number:
		return v.String()
	case int64:
		return strconv.FormatInt(v, 10)
	case int:
		return strconv.Itoa(v)
	}
	return ""
}

var reCQ = regexp.MustCompile(`\[CQ:([a-zA-Z0-9_.-]+)((?:,[^\]]*)?)\]`)

func cqUnescape(s string) string {
	return strings.NewReplacer("&#91;", "[", "&#93;", "]", "&#44;", ",", "&amp;", "&").Replace(s)
}

// CQEscape escapes text for a CQ-code string.
func CQEscape(s string) string {
	return strings.NewReplacer("&", "&amp;", "[", "&#91;", "]", "&#93;").Replace(s)
}

// ParseCQ splits a CQ-code string into segments.
func ParseCQ(s string) []Segment {
	var out []Segment
	text := func(t string) {
		if t != "" {
			out = append(out, Segment{Type: "text", Data: map[string]any{"text": cqUnescape(t)}})
		}
	}
	last := 0
	for _, m := range reCQ.FindAllStringSubmatchIndex(s, -1) {
		text(s[last:m[0]])
		seg := Segment{Type: s[m[2]:m[3]], Data: map[string]any{}}
		for _, kv := range strings.Split(strings.TrimPrefix(s[m[4]:m[5]], ","), ",") {
			if k, v, ok := strings.Cut(kv, "="); ok {
				seg.Data[k] = cqUnescape(v)
			}
		}
		out = append(out, seg)
		last = m[1]
	}
	text(s[last:])
	return out
}

// ParseMessage reads the `message` of a send action: a CQ string, one
// segment, or a list of segments.
func ParseMessage(raw json.RawMessage, autoEscape bool) ([]Segment, error) {
	raw = json.RawMessage(strings.TrimSpace(string(raw)))
	if len(raw) == 0 {
		return nil, nil
	}
	switch raw[0] {
	case '"':
		var s string
		if err := json.Unmarshal(raw, &s); err != nil {
			return nil, err
		}
		if autoEscape {
			return []Segment{{Type: "text", Data: map[string]any{"text": s}}}, nil
		}
		return ParseCQ(s), nil
	case '{':
		var seg Segment
		if err := json.Unmarshal(raw, &seg); err != nil {
			return nil, err
		}
		return []Segment{seg}, nil
	}
	var segs []Segment
	err := json.Unmarshal(raw, &segs)
	return segs, err
}

// Outgoing is what a plugin's message turns into on AM: one text message
// (with @-mentions and a reply) and the pictures, each its own message.
type Outgoing struct {
	Text     string
	Mentions []int64
	ReplyTo  int64
	// Images: "base64://…", "http(s)://…" or "file://…" as OneBot gives them.
	Images []string
	// Things AM can't show (voice, video, faces…), for the log.
	Dropped []string
}

// Plan turns segments into an Outgoing. nameOf gives a user's name for "@name".
func Plan(segs []Segment, nameOf func(int64) string) Outgoing {
	var o Outgoing
	var b strings.Builder
	for _, s := range segs {
		switch s.Type {
		case "text":
			b.WriteString(s.str("text"))
		case "at":
			q := s.str("qq")
			if q == "all" {
				b.WriteString("@全体成员 ")
				continue
			}
			id, err := strconv.ParseInt(q, 10, 64)
			if err != nil {
				continue
			}
			name := s.str("name")
			if name == "" {
				name = nameOf(id)
			}
			b.WriteString("@" + name + " ")
			o.Mentions = append(o.Mentions, id)
		case "reply":
			if id, err := strconv.ParseInt(s.str("id"), 10, 64); err == nil {
				o.ReplyTo = id
			}
		case "image":
			f := s.str("file")
			if f == "" {
				f = s.str("url")
			}
			if f != "" {
				o.Images = append(o.Images, f)
			}
		case "face":
			b.WriteString("[表情]")
		default:
			o.Dropped = append(o.Dropped, s.Type)
		}
	}
	o.Text = strings.TrimSpace(b.String())
	return o
}

// Sender is who sent an event, as a OneBot sender object.
type Sender struct {
	ID   int64
	Name string
	// owner | admin | member (group messages)
	Role string
}

// EventInfo is what MessageEvent needs besides the event itself.
type EventInfo struct {
	SelfID int64
	// Group: a channel (group message); otherwise a DM with the AI (private).
	Group  bool
	Sender Sender
	// NameOf for "@name" in the raw text.
	NameOf func(int64) string
	// ImageURL: where plugins can download a picture (loopback, with a token).
	ImageURL func(mediaID int64) string
}

// MessageEvent turns an AM message into a OneBot message event (ok = false
// for things that aren't messages: system notes, strikes, deletions).
func MessageEvent(ev *amv1.Event, in EventInfo) (map[string]any, bool) {
	var segs []map[string]any
	var raw strings.Builder
	add := func(t string, data map[string]any) {
		segs = append(segs, map[string]any{"type": t, "data": data})
	}
	switch b := ev.GetBody().(type) {
	case *amv1.Event_Text:
		if r := b.Text.GetReplyTo(); r != 0 {
			id := strconv.FormatInt(r, 10)
			add("reply", map[string]any{"id": id})
			raw.WriteString("[CQ:reply,id=" + id + "]")
		}
		text := b.Text.GetText()
		// "@name" in the text with a matching mention becomes an at segment.
		for _, m := range b.Text.GetMentions() {
			at := "@" + in.NameOf(m)
			if i := strings.Index(text, at); i >= 0 {
				if t := text[:i]; t != "" {
					add("text", map[string]any{"text": t})
					raw.WriteString(CQEscape(t))
				}
				id := strconv.FormatInt(m, 10)
				add("at", map[string]any{"qq": id})
				raw.WriteString("[CQ:at,qq=" + id + "]")
				text = strings.TrimPrefix(text[i+len(at):], " ")
			}
		}
		if text != "" {
			add("text", map[string]any{"text": text})
			raw.WriteString(CQEscape(text))
		}
	case *amv1.Event_Image:
		id := b.Image.GetMediaId()
		file := strconv.FormatInt(id, 10) + ".image"
		url := in.ImageURL(id)
		add("image", map[string]any{"file": file, "url": url})
		raw.WriteString("[CQ:image,file=" + file + ",url=" + CQEscape(url) + "]")
	default:
		return nil, false
	}
	if ev.GetRedaction() != nil {
		return nil, false
	}
	out := map[string]any{
		"time": ev.GetCreatedAt() / 1000, "self_id": in.SelfID, "post_type": "message",
		"message_id": ev.GetEventId(), "user_id": ev.GetSenderId(), "message": segs,
		"raw_message": raw.String(), "font": 0,
	}
	sender := map[string]any{"user_id": in.Sender.ID, "nickname": in.Sender.Name, "sex": "unknown", "age": 0}
	if in.Group {
		out["message_type"], out["sub_type"], out["group_id"] = "group", "normal", ev.GetConvId()
		out["anonymous"] = nil
		sender["card"] = ""
		sender["role"] = in.Sender.Role
	} else {
		out["message_type"], out["sub_type"] = "private", "friend"
	}
	out["sender"] = sender
	return out, true
}

// Role maps AM channel roles to OneBot ones.
func Role(r amv1.MemberRole) string {
	switch r {
	case amv1.MemberRole_MEMBER_ROLE_OWNER:
		return "owner"
	case amv1.MemberRole_MEMBER_ROLE_ADMIN:
		return "admin"
	}
	return "member"
}
