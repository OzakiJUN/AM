package plugin

// The service behind the panel's 插件 page: plugins run as the server's
// built-in bot (docs/design.md §10 内置 bot), and only site admins upload
// them (in the panel), change their settings, turn them on / off and delete
// them. Every change asks the host to catch up (Sync). Plugins AIs had
// before are retired once (RetireAIPlugins).

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/OzakiJUN/am/server/internal/account"
	"github.com/OzakiJUN/am/server/internal/apperr"
	"github.com/OzakiJUN/am/server/internal/idgen"
	"github.com/OzakiJUN/am/server/internal/media"
	"github.com/OzakiJUN/am/server/internal/store"
)

var (
	ErrPluginsOff   = apperr.New(http.StatusForbidden, "plugins_off", "plugins are turned off on this server")
	ErrPluginLimit  = apperr.New(http.StatusForbidden, "plugin_limit", "this AI already has the most plugins allowed")
	ErrPluginConfig = apperr.New(http.StatusBadRequest, "invalid_plugin_config", "a plugin setting has the wrong type or is out of range")
)

const maxConfigBytes = 64 << 10

// Limits of uploads (config.toml [plugins]).
type Limits struct {
	MaxZip, MaxUnpacked int64
	MaxPerAI            int
}

// Service manages AI plugins.
type Service struct {
	st     *store.Store
	ids    *idgen.Generator
	md     *media.Service
	acct   *account.Service
	host   *Host
	limits Limits
	log    *slog.Logger
	now    func() time.Time
	bot    int64 // the built-in bot: plugins run as it
}

// MaxZip is the largest plugin zip accepted.
func (s *Service) MaxZip() int64 { return s.limits.MaxZip }

// SetBot sets the built-in bot's account (at startup).
func (s *Service) SetBot(id int64) { s.bot = id }

func NewService(st *store.Store, ids *idgen.Generator, md *media.Service, acct *account.Service, host *Host, limits Limits, log *slog.Logger) *Service {
	return &Service{st: st, ids: ids, md: md, acct: acct, host: host, limits: limits, log: log, now: time.Now}
}

// Host runs the approved plugins.
func (s *Service) Host() *Host { return s.host }

// CommandStart is what plugin commands start with.
func (s *Service) CommandStart() []string { return s.host.cfg.CommandStart }

// Enabled: plugins may be uploaded and run on this server.
func (s *Service) Enabled() bool { return s.host.cfg.Enabled }

// View is a plugin as its owner sees it: settings without secret values.
type View struct {
	*store.AIPlugin
	Meta Meta
	// Values: current settings (secret ones left out); SecretsSet: secret keys that have a value.
	Values     map[string]json.RawMessage
	SecretsSet []string
}

func (s *Service) view(p *store.AIPlugin) *View {
	v := &View{AIPlugin: p, Values: map[string]json.RawMessage{}}
	_ = json.Unmarshal([]byte(p.Meta), &v.Meta)
	var vals map[string]json.RawMessage
	_ = json.Unmarshal([]byte(p.Config), &vals)
	secret := map[string]bool{}
	for _, c := range v.Meta.Config {
		if c.Secret {
			secret[c.Key] = true
		}
	}
	for k, val := range vals {
		if secret[k] || secretKey(k) {
			v.SecretsSet = append(v.SecretsSet, k)
			continue
		}
		v.Values[k] = val
	}
	sort.Strings(v.SecretsSet)
	return v
}

// List returns the bot's plugins and the state of its plugin host.
func (s *Service) List(ctx context.Context) ([]*View, Status, error) {
	list, err := s.st.ListPlugins(ctx, s.bot)
	if err != nil {
		return nil, Status{}, err
	}
	out := make([]*View, len(list))
	for i, p := range list {
		out[i] = s.view(p)
	}
	return out, s.host.StatusOf(s.bot), nil
}

// Upload adds the plugins in a zip to the bot (or replaces the ones with the
// same folder name). Site admins upload in the panel (actor 0), so they run
// at once.
func (s *Service) Upload(ctx context.Context, data []byte) ([]*View, error) {
	if !s.Enabled() {
		return nil, ErrPluginsOff
	}
	if int64(len(data)) > s.limits.MaxZip {
		return nil, apperr.New(http.StatusBadRequest, "bad_plugin", fmt.Sprintf("zip 太大了（最多 %d MB）", s.limits.MaxZip>>20))
	}
	aiID, uploader := s.bot, int64(0)
	pkgs, err := Unpack(data, s.limits.MaxUnpacked)
	if err != nil {
		var bz *ErrBadZip
		if errors.As(err, &bz) {
			return nil, apperr.New(http.StatusBadRequest, "bad_plugin", bz.Reason)
		}
		return nil, err
	}
	existing, err := s.st.ListPlugins(ctx, aiID)
	if err != nil {
		return nil, err
	}
	byDir := map[string]*store.AIPlugin{}
	for _, p := range existing {
		byDir[p.Dir] = p
	}
	added := 0
	for _, pkg := range pkgs {
		if byDir[pkg.Dir] == nil {
			added++
		}
	}
	if len(existing)+added > s.limits.MaxPerAI {
		return nil, ErrPluginLimit
	}
	now := s.now().UnixMilli()
	var out []*View
	for _, pkg := range pkgs {
		meta := Scan(pkg.Dir, pkg.Files)
		mb, _ := json.Marshal(meta)
		sha := pkg.SHA256()
		p := byDir[pkg.Dir]
		if p != nil && p.FilesSHA256 == sha {
			out = append(out, s.view(p)) // same files: nothing changes
			continue
		}
		if p == nil {
			p = &store.AIPlugin{ID: s.ids.Next(), AIID: aiID, Dir: pkg.Dir, Status: "pending", Enabled: true, Config: "{}"}
		}
		if err := s.writeFiles(p.ID, pkg); err != nil {
			return nil, err
		}
		p.Meta, p.FilesSHA256, p.UploadedBy, p.UploadedAt = string(mb), sha, uploader, now
		p.Status, p.DecidedBy, p.DecidedAt, p.RejectReason = "pending", 0, 0, ""
		err := s.st.InTx(ctx, func(q *store.Queries) error {
			if byDir[pkg.Dir] == nil {
				if err := q.InsertPlugin(ctx, p); err != nil {
					return err
				}
			} else if err := q.ReplacePluginFiles(ctx, p.ID, p.Meta, sha, uploader, now); err != nil {
				return err
			}
			p.Status, p.DecidedBy, p.DecidedAt = "approved", uploader, now
			if err := q.DecidePlugin(ctx, p.ID, "approved", uploader, "", now); err != nil {
				return err
			}
			return s.audit(ctx, q, uploader, "plugin_upload", p, "")
		})
		if err != nil {
			return nil, err
		}
		s.log.Info("plugin uploaded", "plugin", p.Dir)
		out = append(out, s.view(p))
	}
	s.host.Sync()
	return out, nil
}

// writeFiles puts a package's files at PkgDir(id)/<dir> (replacing an older version).
func (s *Service) writeFiles(id int64, pkg Package) error {
	final := s.host.PkgDir(id)
	tmp := final + ".new"
	_ = os.RemoveAll(tmp)
	for name, b := range pkg.Files {
		p := filepath.Join(tmp, pkg.Dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(p, b, 0o644); err != nil {
			return err
		}
	}
	if err := os.RemoveAll(final); err != nil {
		return err
	}
	return os.Rename(tmp, final)
}

// get returns a plugin by id (not_found when there is none).
func (s *Service) get(ctx context.Context, id int64) (*store.AIPlugin, error) {
	p, err := s.st.GetPlugin(ctx, id)
	if errors.Is(err, store.ErrNotFound) {
		return nil, apperr.ErrNotFound
	}
	return p, err
}

// mine returns one of the bot's plugins.
func (s *Service) mine(ctx context.Context, id int64) (*store.AIPlugin, error) {
	p, err := s.get(ctx, id)
	if err == nil && p.AIID != s.bot {
		return nil, apperr.ErrNotFound
	}
	return p, err
}

// Update turns a plugin on / off (enabled != nil) and changes settings:
// patch is a JSON object, key -> value sets it, key -> null goes back to the
// plugin's default, keys left out stay as they are (so secret values the
// admin can't see are kept).
func (s *Service) Update(ctx context.Context, id int64, enabled *bool, patch string) (*View, error) {
	p, err := s.mine(ctx, id)
	if err != nil {
		return nil, err
	}
	if enabled != nil && *enabled != p.Enabled {
		if err := s.st.SetPluginEnabled(ctx, id, *enabled); err != nil {
			return nil, err
		}
		p.Enabled = *enabled
	}
	if strings.TrimSpace(patch) != "" {
		var meta Meta
		_ = json.Unmarshal([]byte(p.Meta), &meta)
		cfg, err := ApplyConfig(p.Config, patch, meta.Config)
		if err != nil {
			return nil, err
		}
		if cfg != p.Config {
			if err := s.st.SetPluginConfig(ctx, id, cfg); err != nil {
				return nil, err
			}
			p.Config = cfg
		}
	}
	s.host.Sync()
	return s.view(p), nil
}

// Delete removes a plugin and its files (what it saved in its data folder stays).
func (s *Service) Delete(ctx context.Context, id int64) error {
	if _, err := s.mine(ctx, id); err != nil {
		return err
	}
	if err := s.st.DeletePlugin(ctx, id); err != nil {
		return err
	}
	_ = os.RemoveAll(s.host.PkgDir(id))
	s.host.Sync()
	return nil
}

var reConfigKey = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]{0,63}$`)

// ApplyConfig merges a settings patch into the stored settings, checking
// each value against what the plugin declares. Pure, unit-tested.
func ApplyConfig(current, patch string, items []ConfigItem) (string, error) {
	vals := map[string]json.RawMessage{}
	_ = json.Unmarshal([]byte(current), &vals)
	var p map[string]json.RawMessage
	if err := json.Unmarshal([]byte(patch), &p); err != nil {
		return "", ErrPluginConfig
	}
	known := map[string]ConfigItem{}
	for _, c := range items {
		known[strings.ToLower(c.Key)] = c
	}
	for k, raw := range p {
		k = strings.ToLower(k)
		if !reConfigKey.MatchString(k) || coreKeys[k] {
			return "", apperr.New(http.StatusBadRequest, "invalid_plugin_config", fmt.Sprintf("setting %q can't be changed here", k))
		}
		if string(raw) == "null" {
			delete(vals, k)
			continue
		}
		if c, ok := known[k]; ok {
			if err := checkValue(c, raw); err != nil {
				return "", apperr.New(http.StatusBadRequest, "invalid_plugin_config", k+": "+err.Error())
			}
		} else if !json.Valid(raw) {
			return "", ErrPluginConfig
		}
		vals[k] = raw
	}
	out, _ := json.Marshal(vals)
	if len(out) > maxConfigBytes {
		return "", apperr.New(http.StatusRequestEntityTooLarge, "too_large", "plugin settings are too large")
	}
	return string(out), nil
}

func checkValue(c ConfigItem, raw json.RawMessage) error {
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return errors.New("not valid JSON")
	}
	num := func(integer bool) error {
		f, ok := v.(float64)
		if !ok {
			// Numbers in strings are fine too (NoneBot reads .env as text).
			s, isStr := v.(string)
			if !isStr {
				return errors.New("must be a number")
			}
			var err error
			if f, err = strconv.ParseFloat(strings.TrimSpace(s), 64); err != nil {
				return errors.New("must be a number")
			}
		}
		if integer && f != math.Trunc(f) {
			return errors.New("must be a whole number")
		}
		if c.Min != nil && f < *c.Min || c.Max != nil && f > *c.Max {
			return errors.New("out of range")
		}
		return nil
	}
	switch c.Type {
	case "bool":
		if _, ok := v.(bool); !ok {
			return errors.New("must be true or false")
		}
	case "int":
		return num(true)
	case "float":
		return num(false)
	case "list":
		if _, ok := v.([]any); !ok {
			return errors.New("must be a list")
		}
	case "select":
		s, ok := v.(string)
		if !ok {
			return errors.New("must be text")
		}
		if len(c.Options) > 0 {
			for _, o := range c.Options {
				if o == s {
					return nil
				}
			}
			return errors.New("not one of the choices")
		}
	case "string", "path", "text":
		if _, ok := v.(string); !ok {
			return errors.New("must be text")
		}
	}
	return nil
}

// ---- site admins (panel) ----

func (s *Service) audit(ctx context.Context, q *store.Queries, actor int64, action string, p *store.AIPlugin, detail string) error {
	d := p.Dir
	if detail != "" {
		d += ": " + detail
	}
	return q.AddAudit(ctx, &store.AuditEntry{ID: s.ids.Next(), ActorID: actor, Action: action, TargetID: p.AIID,
		Detail: d, CreatedAt: s.now().UnixMilli()})
}

// FileInfo is one file of a plugin, for reviewing it in the panel.
type FileInfo struct {
	Path string `json:"path"`
	Size int64  `json:"size"`
}

// Files lists a plugin's files.
func (s *Service) Files(ctx context.Context, id int64) ([]FileInfo, error) {
	p, err := s.get(ctx, id)
	if err != nil {
		return nil, err
	}
	root := filepath.Join(s.host.PkgDir(id), p.Dir)
	var out []FileInfo
	err = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, path)
		out = append(out, FileInfo{Path: filepath.ToSlash(rel), Size: info.Size()})
		return nil
	})
	return out, err
}

// File reads one file of a plugin (path as Files lists it).
func (s *Service) File(ctx context.Context, id int64, name string) ([]byte, error) {
	files, err := s.Files(ctx, id)
	if err != nil {
		return nil, err
	}
	p, err := s.get(ctx, id)
	if err != nil {
		return nil, err
	}
	for _, f := range files {
		if f.Path == name {
			return os.ReadFile(filepath.Join(s.host.PkgDir(id), p.Dir, filepath.FromSlash(name)))
		}
	}
	return nil, apperr.ErrNotFound
}

// ValuesJSON encodes settings values as a JSON object.
func ValuesJSON(v map[string]json.RawMessage) string {
	if len(v) == 0 {
		return "{}"
	}
	b, _ := json.Marshal(v)
	return string(b)
}

// RetireAIPlugins removes the plugins AIs had before plugins moved to the
// built-in bot (once per server; Weiqi 2026-11-02: 「现在 ai 上那几个插件设置直接废弃」).
func (s *Service) RetireAIPlugins(ctx context.Context) error {
	set, err := s.st.ServerSettings(ctx)
	if err != nil || set["plugins_on_bot"] == "1" {
		return err
	}
	list, err := s.st.ListPluginsAdmin(ctx, "")
	if err != nil {
		return err
	}
	for _, p := range list {
		if p.AIID == s.bot {
			continue
		}
		if err := s.st.DeletePlugin(ctx, p.ID); err != nil {
			return err
		}
		_ = os.RemoveAll(s.host.PkgDir(p.ID))
		s.log.Info("plugins: retired an AI's plugin (plugins run as the built-in bot now)", "ai", p.AIID, "plugin", p.Dir)
	}
	s.host.Sync()
	return s.st.SetServerSetting(ctx, "plugins_on_bot", "1")
}

// Command is one command of the bot's running plugins.
type Command struct {
	Name, Plugin, Usage string
}

// Commands lists the commands of the bot's approved, enabled plugins (for
// 指令查询 and so AIs leave them alone).
func (s *Service) Commands(ctx context.Context) []Command {
	list, err := s.st.ListPlugins(ctx, s.bot)
	if err != nil {
		return nil
	}
	var out []Command
	for _, p := range list {
		if p.Status != "approved" || !p.Enabled {
			continue
		}
		v := s.view(p)
		name := v.Meta.Name
		if name == "" {
			name = p.Dir
		}
		for _, c := range v.Meta.Commands {
			out = append(out, Command{Name: c, Plugin: name, Usage: v.Meta.Usage})
		}
	}
	return out
}
