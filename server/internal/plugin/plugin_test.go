package plugin

import (
	"encoding/json"
	"strings"
	"testing"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
)

const demoInit = `
from nonebot import get_driver, on_command, require
from nonebot.plugin import PluginMetadata
from PIL import Image
import httpx, json
from . import helpers

require("nonebot_plugin_localstore")

__plugin_meta__ = PluginMetadata(
    name="演示",
    description="一个演示插件",
    usage="打招呼 / hi",
)

_cfg = get_driver().config

def _c(key, default):
    v = getattr(_cfg, key, None)
    return default if v in (None, "") else v

def _b(key, default):
    v = getattr(_cfg, key, None)
    return default if v in (None, "") else str(v).lower() in ("1", "true")

URL = _c("demo_url", "http://127.0.0.1:4000")
LIMIT = int(_c("demo_limit", 5))
ON = _b("demo_enabled", True)
TOKEN = getattr(_cfg, "demo_token", "")
STARTS = getattr(_cfg, "command_start", {"/"})

hi = on_command("打招呼", aliases={"hi", 'hello'}, priority=5, block=True)

def later():
    import meme_generator  # optional
`

const demoHelpers = `
import numpy as np

class DemoConfig(BaseModel):
    demo_ratio: float = 0.5
    demo_tags: list[str] = ["a", "b"]
`

func TestScan(t *testing.T) {
	m := Scan("demo", map[string][]byte{"__init__.py": []byte(demoInit), "helpers.py": []byte(demoHelpers)})
	if m.Name != "演示" || m.Description != "一个演示插件" || m.Usage != "打招呼 / hi" {
		t.Fatalf("meta: %+v", m)
	}
	if strings.Join(m.Commands, ",") != "打招呼,hi,hello" {
		t.Fatalf("commands: %v", m.Commands)
	}
	got := map[string]ConfigItem{}
	for _, c := range m.Config {
		got[c.Key] = c
	}
	check := func(k, typ, def string, secret bool) {
		t.Helper()
		c, ok := got[k]
		if !ok || c.Type != typ || string(c.Default) != def || c.Secret != secret {
			t.Errorf("%s: %+v (default %s)", k, c, c.Default)
		}
	}
	check("demo_url", "string", `"http://127.0.0.1:4000"`, false)
	check("demo_limit", "int", "5", false)
	check("demo_enabled", "bool", "true", false)
	check("demo_token", "string", `""`, true)
	check("demo_ratio", "float", "0.5", false)
	check("demo_tags", "list", `["a","b"]`, false)
	if _, ok := got["command_start"]; ok {
		t.Error("NoneBot's own settings are not plugin settings")
	}
	// Top-level imports and require() are requirements; imports inside functions are optional.
	if strings.Join(m.Requires, ",") != "Pillow,nonebot-plugin-localstore,numpy" {
		t.Errorf("requires: %v", m.Requires)
	}
}

func TestManifest(t *testing.T) {
	man := `{"name":"好名字","config":[
		{"key":"demo_limit","label":"每次最多","type":"int","min":1,"max":20,"group":"基本"},
		{"key":"demo_mode","label":"模式","type":"select","options":["快","慢"]},
		{"key":"command_start","label":"不许改"}],
		"requires":["onnxruntime>=1.17","-e git+https://evil", "../x"]}`
	m := Scan("demo", map[string][]byte{"__init__.py": []byte(demoInit), "am_plugin.json": []byte(man)})
	if m.Name != "好名字" || m.Config[0].Key != "demo_limit" || m.Config[0].Label != "每次最多" || string(m.Config[0].Default) != "5" {
		t.Fatalf("manifest first: %+v", m.Config[0])
	}
	if m.Config[1].Key != "demo_mode" || m.Config[1].Type != "select" {
		t.Fatalf("only in manifest: %+v", m.Config[1])
	}
	for _, c := range m.Config {
		if c.Key == "command_start" {
			t.Fatal("core key from manifest")
		}
	}
	if !strings.Contains(strings.Join(m.Requires, " "), "onnxruntime>=1.17") || strings.Contains(strings.Join(m.Requires, " "), "evil") || strings.Contains(strings.Join(m.Requires, " "), "..") {
		t.Fatalf("requires: %v", m.Requires)
	}
}

func TestCQ(t *testing.T) {
	segs := ParseCQ("你好[CQ:at,qq=42] 看图[CQ:image,file=base64://AAA&#44;B]&#91;不是码&#93;")
	if len(segs) != 5 || segs[1].Type != "at" || segs[1].str("qq") != "42" || segs[3].str("file") != "base64://AAA,B" || segs[4].str("text") != "[不是码]" {
		t.Fatalf("%+v", segs)
	}
	if CQEscape("[a]&") != "&#91;a&#93;&amp;" {
		t.Fatal("escape")
	}
	for _, raw := range []string{`"[CQ:at,qq=1]hi"`, `[{"type":"text","data":{"text":"hi"}}]`, `{"type":"text","data":{"text":"hi"}}`} {
		if s, err := ParseMessage(json.RawMessage(raw), false); err != nil || len(s) == 0 {
			t.Fatalf("%s: %v %v", raw, s, err)
		}
	}
	if s, _ := ParseMessage(json.RawMessage(`"[CQ:at,qq=1]"`), true); s[0].Type != "text" {
		t.Fatal("auto_escape keeps CQ codes as text")
	}
}

func TestPlan(t *testing.T) {
	segs := []Segment{
		{Type: "reply", Data: map[string]any{"id": "77"}},
		{Type: "at", Data: map[string]any{"qq": float64(5)}},
		{Type: "text", Data: map[string]any{"text": "画好了"}},
		{Type: "image", Data: map[string]any{"file": "base64://xyz"}},
		{Type: "record", Data: map[string]any{"file": "a.mp3"}},
	}
	o := Plan(segs, func(id int64) string { return "小克" })
	if o.Text != "@小克 画好了" || o.ReplyTo != 77 || len(o.Mentions) != 1 || o.Mentions[0] != 5 || len(o.Images) != 1 || o.Dropped[0] != "record" {
		t.Fatalf("%+v", o)
	}
}

func TestMessageEvent(t *testing.T) {
	ev := &amv1.Event{EventId: 9, ConvId: 100, SenderId: 5, CreatedAt: 1_700_000_000_000,
		Body: &amv1.Event_Text{Text: &amv1.TextMsg{Text: "@小鱼 画图 猫", Mentions: []int64{3}, ReplyTo: 8}}}
	in := EventInfo{SelfID: 3, Group: true, Sender: Sender{ID: 5, Name: "小克", Role: "member"},
		NameOf: func(int64) string { return "小鱼" }, ImageURL: func(id int64) string { return "http://x/" }}
	out, ok := MessageEvent(ev, in)
	if !ok || out["message_type"] != "group" || out["group_id"] != int64(100) || out["self_id"] != int64(3) {
		t.Fatalf("%v", out)
	}
	if out["raw_message"] != "[CQ:reply,id=8][CQ:at,qq=3]画图 猫" {
		t.Fatalf("raw %q", out["raw_message"])
	}
	segs := out["message"].([]map[string]any)
	if len(segs) != 3 || segs[1]["type"] != "at" || segs[2]["data"].(map[string]any)["text"] != "画图 猫" {
		t.Fatalf("%v", segs)
	}
	img := &amv1.Event{EventId: 10, ConvId: 7, SenderId: 5, Body: &amv1.Event_Image{Image: &amv1.ImageMsg{MediaId: 44}}}
	in.Group = false
	in.ImageURL = func(id int64) string { return "http://127.0.0.1:1/media/44?t=k" }
	out, ok = MessageEvent(img, in)
	if !ok || out["message_type"] != "private" || !strings.Contains(out["raw_message"].(string), "url=http://127.0.0.1:1/media/44?t=k") {
		t.Fatalf("%v", out)
	}
	if _, ok := MessageEvent(&amv1.Event{Body: &amv1.Event_Strike{}}, in); ok {
		t.Fatal("strike is not a message")
	}
}
