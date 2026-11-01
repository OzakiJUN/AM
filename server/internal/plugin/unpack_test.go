package plugin

import (
	"archive/zip"
	"bytes"
	"strings"
	"testing"
)

func zipOf(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, body := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte(body))
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func dirs(ps []Package) string {
	var out []string
	for _, p := range ps {
		out = append(out, p.Dir)
	}
	return strings.Join(out, ",")
}

func TestUnpack(t *testing.T) {
	const mb = 1 << 20
	// A folder of plugins inside one wrapper folder, plus litter.
	ps, err := Unpack(zipOf(t, map[string]string{
		"myplugins/qqhelp/__init__.py":       "x",
		"myplugins/qqhelp/data/help.txt":     "帮助",
		"myplugins/qqhelp/__pycache__/a.pyc": "junk",
		"myplugins/qqdraw/__init__.py":       "y",
		"myplugins/qqdraw/sub/__init__.py":   "nested package stays inside",
		"myplugins/single.py":                "z",
		"myplugins/bot.py":                   "the project's own",
		"myplugins/.env":                     "SECRET=1",
		"__MACOSX/myplugins/._qqhelp":        "",
	}), 10*mb)
	if err != nil {
		t.Fatal(err)
	}
	if got := dirs(ps); got != "qqdraw,qqhelp,single" {
		t.Fatalf("plugins %s", got)
	}
	help := ps[1].Files
	if string(help["data/help.txt"]) != "帮助" || help["__pycache__/a.pyc"] != nil || len(help) != 2 {
		t.Fatalf("qqhelp files %v", help)
	}
	if len(ps[0].Files) != 2 || ps[2].Files["__init__.py"] == nil {
		t.Fatalf("files %v / %v", ps[0].Files, ps[2].Files)
	}
	// Same files, same hash; any change, another one.
	again, _ := Unpack(zipOf(t, map[string]string{"qqhelp/__init__.py": "x", "qqhelp/data/help.txt": "帮助"}), 10*mb)
	if again[0].SHA256() != ps[1].SHA256() {
		t.Fatal("hash depends on the zip layout")
	}
	changed, _ := Unpack(zipOf(t, map[string]string{"qqhelp/__init__.py": "x2", "qqhelp/data/help.txt": "帮助"}), 10*mb)
	if changed[0].SHA256() == ps[1].SHA256() {
		t.Fatal("hash ignores content")
	}
	// A NoneBot project: src/plugins/<name>.
	ps, err = Unpack(zipOf(t, map[string]string{"bot.py": "", "pyproject.toml": "", "src/plugins/weather/__init__.py": ""}), mb)
	if err != nil || dirs(ps) != "weather" {
		t.Fatalf("project: %v %v", dirs(ps), err)
	}

	for name, files := range map[string]map[string]string{
		"escape":   {"../evil/__init__.py": ""},
		"absolute": {"/etc/__init__.py": ""},
		"drive":    {"C:/x/__init__.py": ""},
		"bad name": {"my-plugin/__init__.py": ""},
		"reserved": {"nonebot_plugin_x/__init__.py": ""},
		"dupe":     {"a/foo/__init__.py": "", "b/foo/__init__.py": ""},
		"empty":    {"readme.txt": "no plugin here"},
	} {
		if _, err := Unpack(zipOf(t, files), mb); err == nil {
			t.Errorf("%s: accepted", name)
		} else if _, ok := err.(*ErrBadZip); !ok {
			t.Errorf("%s: %T %v", name, err, err)
		}
	}
	if _, err := Unpack(zipOf(t, map[string]string{"big/__init__.py": strings.Repeat("x", 2*mb)}), mb); err == nil {
		t.Error("too large accepted")
	}
	if _, err := Unpack([]byte("not a zip"), mb); err == nil {
		t.Error("not a zip accepted")
	}
}

func TestApplyConfig(t *testing.T) {
	one, ten := 1.0, 10.0
	items := []ConfigItem{
		{Key: "demo_url", Type: "string"},
		{Key: "demo_limit", Type: "int", Min: &one, Max: &ten},
		{Key: "demo_on", Type: "bool"},
		{Key: "demo_mode", Type: "select", Options: []string{"a", "b"}},
		{Key: "demo_list", Type: "list"},
		{Key: "demo_token", Type: "string", Secret: true},
	}
	cfg, err := ApplyConfig(`{"demo_token":"s3cret","demo_url":"x"}`,
		`{"demo_limit":5,"demo_on":true,"demo_mode":"b","demo_list":[1,2],"DEMO_URL":null,"extra_key":"kept"}`, items)
	if err != nil {
		t.Fatal(err)
	}
	if cfg != `{"demo_limit":5,"demo_list":[1,2],"demo_mode":"b","demo_on":true,"demo_token":"s3cret","extra_key":"kept"}` {
		t.Fatalf("merged %s", cfg)
	}
	if cfg, err := ApplyConfig(`{}`, `{"demo_limit":"7"}`, items); err != nil || cfg != `{"demo_limit":"7"}` {
		t.Fatalf("number as text: %s %v", cfg, err)
	}
	for _, bad := range []string{
		`{"demo_limit":11}`, `{"demo_limit":2.5}`, `{"demo_limit":"many"}`, `{"demo_on":"yes"}`, `{"demo_mode":"c"}`,
		`{"demo_list":"1,2"}`, `{"demo_url":3}`, `{"command_start":["!"]}`, `{"superusers":["1"]}`, `{"bad key":1}`, `[1]`,
	} {
		if _, err := ApplyConfig(`{}`, bad, items); err == nil {
			t.Errorf("accepted %s", bad)
		}
	}
	if _, err := ApplyConfig(`{}`, `{"x":"`+strings.Repeat("a", maxConfigBytes)+`"}`, items); err == nil {
		t.Error("huge settings accepted")
	}
}
