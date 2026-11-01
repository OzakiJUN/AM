// Package plugin runs NoneBot2 (OneBot v11) plugins for AI accounts on the
// server (docs/design.md §10, docs/plugins.md): owners upload plugins, a
// site admin approves them, and am-server runs one NoneBot process per AI
// that talks to a OneBot v11 endpoint am-server serves on loopback. The
// plugins see the AI's channels and DMs as group / private messages and
// send as the AI.
//
// scan.go reads what the owner's UI needs from a plugin's source without
// running it: name, usage, commands, config keys (with defaults and types),
// the pip packages it imports, plus an optional am_plugin.json written by
// the author. Pure, unit-tested.
package plugin

import (
	"encoding/json"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// ConfigItem is one setting of a plugin, as the config form shows it.
type ConfigItem struct {
	Key   string `json:"key"`
	Label string `json:"label,omitempty"`
	Help  string `json:"help,omitempty"`
	// string | int | float | bool | list | path | select | text
	Type    string          `json:"type"`
	Default json.RawMessage `json:"default,omitempty"`
	Options []string        `json:"options,omitempty"`
	Group   string          `json:"group,omitempty"`
	// Secret values (tokens, keys) are never sent back to clients.
	Secret bool     `json:"secret,omitempty"`
	Min    *float64 `json:"min,omitempty"`
	Max    *float64 `json:"max,omitempty"`
}

// Meta is what we know about a plugin from its files.
type Meta struct {
	// Dir is the package (folder) name NoneBot loads.
	Dir         string       `json:"dir"`
	Name        string       `json:"name"`
	Description string       `json:"description"`
	Usage       string       `json:"usage"`
	Commands    []string     `json:"commands"`
	Config      []ConfigItem `json:"config"`
	// Requires: pip packages it imports (besides nonebot itself).
	Requires []string `json:"requires"`
}

// Manifest is am_plugin.json, written by the author to improve the UI.
type Manifest struct {
	Name        string       `json:"name"`
	Description string       `json:"description"`
	Usage       string       `json:"usage"`
	Commands    []string     `json:"commands"`
	Config      []ConfigItem `json:"config"`
	Requires    []string     `json:"requires"`
}

var (
	pyStr       = `(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)')`
	reMetaField = func(f string) *regexp.Regexp {
		return regexp.MustCompile(`(?s)PluginMetadata\(.*?\b` + f + `\s*=\s*` + pyStr)
	}
	reMetaName   = reMetaField("name")
	reMetaDesc   = reMetaField("description")
	reMetaUsage  = reMetaField("usage")
	reCommand    = regexp.MustCompile(`on_command\(\s*` + pyStr + `(?:[^)]*?aliases\s*=\s*[{\[(]([^}\])]*)[}\])])?`)
	reStrInList  = regexp.MustCompile(pyStr)
	reCfgCall    = regexp.MustCompile(`\b(cfg|cfg_bool|cfg_path|cfg_int|cfg_float)\(\s*["']([A-Za-z][A-Za-z0-9_]*)["']\s*(?:,\s*([^()\n]*(?:\([^()\n]*\)[^()\n]*)*?))?\)`)
	reGetattrCfg = regexp.MustCompile(`getattr\(\s*(?:_?cfg|_?config|_?conf|driver\.config|get_driver\(\)\.config|_driver_config)\s*,\s*["']([A-Za-z][A-Za-z0-9_]*)["']\s*(?:,\s*([^()\n]*(?:\([^()\n]*\)[^()\n]*)*?))?\)`)
	reConfigCls  = regexp.MustCompile(`(?m)^class\s+\w*Config\w*\s*\(\s*BaseModel\s*\)\s*:\s*\n((?:[ \t]+.*\n?|\s*\n)*)`)
	reField      = regexp.MustCompile(`^[ \t]+([a-z][a-z0-9_]*)\s*:\s*([A-Za-z_\[\], .|]+?)\s*(?:=\s*(.+?))?\s*(?:#.*)?$`)
	// Only imports at the top of a file are requirements; ones inside functions or try blocks are optional extras.
	reImport = regexp.MustCompile(`(?m)^(?:from\s+([A-Za-z_][A-Za-z0-9_]*)[\w.]*\s+import|import\s+([A-Za-z_][A-Za-z0-9_]*))`)
	// A helper like `def _c(key, default): v = getattr(_cfg, key, None) ...`.
	reHelper  = regexp.MustCompile(`(?m)^def\s+(\w+)\(\s*(\w+)\s*(?:,[^)]*)?\)\s*(?:->[^:]*)?:\s*\n((?:[ \t]+.*\n?){1,6})`)
	reRequire = regexp.MustCompile(`require\(\s*["']([a-z0-9_]+)["']\s*\)`)
)

// Settings NoneBot itself owns: never shown as plugin settings.
var coreKeys = map[string]bool{
	"command_start": true, "command_sep": true, "nickname": true, "superusers": true, "driver": true,
	"host": true, "port": true, "log_level": true, "api_timeout": true, "session_expire_timeout": true,
	"onebot_access_token": true, "onebot_ws_urls": true, "onebot_secret": true, "environment": true,
}

// Import names that are not on pip under the same name.
var pipName = map[string]string{
	"PIL": "Pillow", "yaml": "PyYAML", "cv2": "opencv-python", "bs4": "beautifulsoup4", "sklearn": "scikit-learn",
	"dateutil": "python-dateutil", "Crypto": "pycryptodome", "jwt": "PyJWT", "dotenv": "python-dotenv",
	"nonebot_plugin_apscheduler": "nonebot-plugin-apscheduler", "nonebot_plugin_localstore": "nonebot-plugin-localstore",
	"nonebot_plugin_htmlrender": "nonebot-plugin-htmlrender", "nonebot_plugin_alconna": "nonebot-plugin-alconna",
}

// Python standard library modules (common ones) and what NoneBot brings along.
var notPip = func() map[string]bool {
	m := map[string]bool{}
	for _, s := range strings.Fields(`__future__ abc argparse array ast asyncio base64 binascii bisect builtins bz2 calendar
		cmath codecs collections colorsys concurrent configparser contextlib contextvars copy csv ctypes dataclasses datetime
		decimal difflib dis email enum errno fnmatch fractions functools gc getpass gettext glob gzip hashlib heapq hmac html http
		imghdr importlib inspect io ipaddress itertools json keyword linecache locale logging lzma math mimetypes multiprocessing
		numbers operator os pathlib pickle platform pprint queue random re secrets select shlex shutil signal socket sqlite3
		ssl stat statistics string struct subprocess sys sysconfig tarfile tempfile textwrap threading time timeit token tokenize
		traceback types typing typing_extensions unicodedata urllib uuid warnings wave weakref xml zipfile zlib zoneinfo
		nonebot pydantic loguru anyio httpx websockets yarl multidict msgpack`) {
		m[s] = true
	}
	return m
}()

func pyUnquote(dq, sq string) string {
	s := dq
	q := `"`
	if s == "" {
		s, q = sq, `'`
	}
	if u, err := strconv.Unquote(`"` + strings.ReplaceAll(s, `\`+q, q) + `"`); err == nil {
		return u
	}
	return s
}

// literal turns a Python default expression into JSON and a type guess.
func literal(expr string) (json.RawMessage, string) {
	e := strings.TrimSpace(expr)
	switch {
	case e == "":
		return nil, "string"
	case e == "True" || e == "False":
		return json.RawMessage(strings.ToLower(e)), "bool"
	case e == "None":
		return nil, "string"
	}
	if _, err := strconv.ParseInt(e, 10, 64); err == nil {
		return json.RawMessage(e), "int"
	}
	if _, err := strconv.ParseFloat(e, 64); err == nil {
		return json.RawMessage(e), "float"
	}
	if m := regexp.MustCompile(`^` + pyStr + `$`).FindStringSubmatch(e); m != nil {
		b, _ := json.Marshal(pyUnquote(m[1], m[2]))
		return b, "string"
	}
	if strings.HasPrefix(e, "[") || strings.HasPrefix(e, "(") || strings.HasPrefix(e, "{") && !strings.Contains(e, ":") {
		var items []string
		for _, m := range reStrInList.FindAllStringSubmatch(e, -1) {
			items = append(items, pyUnquote(m[1], m[2]))
		}
		if items == nil {
			items = []string{}
		}
		b, _ := json.Marshal(items)
		return b, "list"
	}
	return nil, "string"
}

func secretKey(k string) bool {
	k = strings.ToLower(k)
	for _, w := range []string{"token", "secret", "password", "passwd", "api_key", "apikey", "cookie"} {
		if strings.Contains(k, w) {
			return true
		}
	}
	return strings.HasSuffix(k, "_key")
}

// Scan reads one plugin package: files maps paths inside the plugin folder
// ("__init__.py", "sub/x.py", "am_plugin.json") to their content.
func Scan(dir string, files map[string][]byte) Meta {
	m := Meta{Dir: dir, Commands: []string{}, Config: []ConfigItem{}, Requires: []string{}}
	names := make([]string, 0, len(files))
	for n := range files {
		names = append(names, n)
	}
	sort.Strings(names)
	// The package's own module names (imports of them are not pip packages).
	own := map[string]bool{dir: true}
	for _, n := range names {
		own[strings.TrimSuffix(path.Base(n), ".py")] = true
		if d := path.Dir(n); d != "." {
			own[strings.Split(d, "/")[0]] = true
		}
	}
	cfg := map[string]*ConfigItem{}
	var order []string
	addCfg := func(key, kind, def string) {
		if coreKeys[key] {
			return
		}
		raw, typ := literal(def)
		switch kind {
		case "cfg_bool":
			typ = "bool"
		case "cfg_path":
			typ = "path"
		case "cfg_int":
			typ = "int"
		case "cfg_float":
			typ = "float"
		}
		if c, ok := cfg[key]; ok {
			if c.Default == nil && raw != nil {
				c.Default, c.Type = raw, typ
			}
			return
		}
		cfg[key] = &ConfigItem{Key: key, Type: typ, Default: raw, Secret: secretKey(key)}
		order = append(order, key)
	}
	reqs := map[string]bool{}
	cmds := map[string]bool{}
	// Helpers that read the driver config by key, in any file of the plugin.
	helpers := map[string]string{} // name -> cfg kind
	for _, n := range names {
		if !strings.HasSuffix(n, ".py") {
			continue
		}
		for _, h := range reHelper.FindAllStringSubmatch(string(files[n]), -1) {
			if regexp.MustCompile(`getattr\(\s*\w*(?:cfg|conf|config)\w*\s*,\s*` + regexp.QuoteMeta(h[2]) + `\b`).MatchString(h[3]) {
				kind := "cfg"
				if strings.Contains(h[3], `"true"`) || strings.Contains(h[3], `'true'`) || strings.Contains(strings.ToLower(h[1]), "bool") || h[1] == "_b" {
					kind = "cfg_bool"
				}
				helpers[h[1]] = kind
			}
		}
	}
	var reHelperCall *regexp.Regexp
	if len(helpers) > 0 {
		var alts []string
		for h := range helpers {
			alts = append(alts, regexp.QuoteMeta(h))
		}
		sort.Strings(alts)
		reHelperCall = regexp.MustCompile(`\b(` + strings.Join(alts, "|") + `)\(\s*["']([A-Za-z][A-Za-z0-9_]*)["']\s*(?:,\s*([^()\n]*(?:\([^()\n]*\)[^()\n]*)*?))?\)`)
	}
	for _, n := range names {
		if !strings.HasSuffix(n, ".py") {
			continue
		}
		src := string(files[n])
		if reHelperCall != nil {
			for _, x := range reHelperCall.FindAllStringSubmatch(src, -1) {
				addCfg(x[2], helpers[x[1]], x[3])
			}
		}
		if m.Name == "" {
			if x := reMetaName.FindStringSubmatch(src); x != nil {
				m.Name = pyUnquote(x[1], x[2])
				if d := reMetaDesc.FindStringSubmatch(src); d != nil {
					m.Description = pyUnquote(d[1], d[2])
				}
				if u := reMetaUsage.FindStringSubmatch(src); u != nil {
					m.Usage = pyUnquote(u[1], u[2])
				}
			}
		}
		for _, x := range reCommand.FindAllStringSubmatch(src, -1) {
			c := pyUnquote(x[1], x[2])
			if !cmds[c] {
				cmds[c] = true
				m.Commands = append(m.Commands, c)
			}
			for _, a := range reStrInList.FindAllStringSubmatch(x[3], -1) {
				if c := pyUnquote(a[1], a[2]); !cmds[c] {
					cmds[c] = true
					m.Commands = append(m.Commands, c)
				}
			}
		}
		for _, x := range reCfgCall.FindAllStringSubmatch(src, -1) {
			addCfg(x[2], x[1], x[3])
		}
		for _, x := range reGetattrCfg.FindAllStringSubmatch(src, -1) {
			addCfg(x[1], "", x[2])
		}
		for _, body := range reConfigCls.FindAllStringSubmatch(src, -1) {
			for _, line := range strings.Split(body[1], "\n") {
				if f := reField.FindStringSubmatch(line); f != nil {
					addCfg(f[1], "", f[3])
					c := cfg[f[1]]
					if c == nil {
						continue
					}
					switch t := strings.ToLower(f[2]); {
					case strings.HasPrefix(t, "bool"):
						c.Type = "bool"
					case strings.HasPrefix(t, "int"):
						c.Type = "int"
					case strings.HasPrefix(t, "float"):
						c.Type = "float"
					case strings.HasPrefix(t, "list"), strings.HasPrefix(t, "set"), strings.HasPrefix(t, "tuple"):
						c.Type = "list"
					}
				}
			}
		}
		for _, x := range reImport.FindAllStringSubmatch(src, -1) {
			mod := x[1] + x[2]
			if mod == "" || own[mod] || notPip[mod] {
				continue
			}
			reqs[pipFor(mod)] = true
		}
		for _, x := range reRequire.FindAllStringSubmatch(src, -1) {
			if !own[x[1]] {
				reqs[pipFor(x[1])] = true
			}
		}
	}
	for _, k := range order {
		m.Config = append(m.Config, *cfg[k])
	}
	if raw, ok := files["am_plugin.json"]; ok {
		var man Manifest
		if json.Unmarshal(raw, &man) == nil {
			m.apply(man)
		}
	}
	for r := range reqs {
		m.Requires = append(m.Requires, r)
	}
	sort.Strings(m.Requires)
	if m.Name == "" {
		m.Name = dir
	}
	return m
}

func pipFor(mod string) string {
	if p, ok := pipName[mod]; ok {
		return p
	}
	return strings.ReplaceAll(mod, "_", "-")
}

// apply puts the author's am_plugin.json over what the scan found: their
// labels, types and groups win; settings only they list are added.
func (m *Meta) apply(man Manifest) {
	if man.Name != "" {
		m.Name = man.Name
	}
	if man.Description != "" {
		m.Description = man.Description
	}
	if man.Usage != "" {
		m.Usage = man.Usage
	}
	if len(man.Commands) > 0 {
		m.Commands = man.Commands
	}
	idx := map[string]int{}
	for i, c := range m.Config {
		idx[c.Key] = i
	}
	var listed []ConfigItem
	seen := map[string]bool{}
	for _, c := range man.Config {
		if c.Key == "" || coreKeys[c.Key] || seen[c.Key] {
			continue
		}
		seen[c.Key] = true
		if i, ok := idx[c.Key]; ok {
			base := m.Config[i]
			if c.Type == "" {
				c.Type = base.Type
			}
			if c.Default == nil {
				c.Default = base.Default
			}
			c.Secret = c.Secret || base.Secret
		} else if c.Type == "" {
			c.Type = "string"
		}
		listed = append(listed, c)
	}
	// The author's order first, then whatever the scan found that they left out.
	for _, c := range m.Config {
		if !seen[c.Key] {
			listed = append(listed, c)
		}
	}
	m.Config = listed
	for _, r := range man.Requires {
		if r = strings.TrimSpace(r); r != "" && validPip(r) {
			m.Requires = append(m.Requires, r)
		}
	}
}

// validPip accepts plain package requirements ("httpx", "Pillow>=10"), never
// URLs, paths or pip options.
var reReq = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9_,-]+\])?(\s*(==|>=|<=|~=|>|<|!=)\s*[A-Za-z0-9.*+!-]+)?$`)

func validPip(r string) bool { return reReq.MatchString(r) }
