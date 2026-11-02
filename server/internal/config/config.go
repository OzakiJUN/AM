// Package config loads config.toml. Every tunable lives here so nobody has
// to edit code to change a setting. The admin panel edits the file through
// Apply / WriteFile, which keep the comments and the user's layout.
package config

import (
	"crypto/rand"
	_ "embed"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/BurntSushi/toml"
)

//go:embed default.toml
var defaultTOML string

type Config struct {
	Server    Server    `toml:"server"`
	TLS       TLS       `toml:"tls"`
	Database  Database  `toml:"database"`
	Invites   Invites   `toml:"invites"`
	Limits    Limits    `toml:"limits"`
	Retention Retention `toml:"retention"`
	Media     Media     `toml:"media"`
	Stickers  Stickers  `toml:"stickers"`
	Plugins   Plugins   `toml:"plugins"`
	Hosting   Hosting   `toml:"hosting"`
	Museum    Museum    `toml:"museum"`
	Helper    Helper    `toml:"helper"`
	News      News      `toml:"news"`
	Draw      Draw      `toml:"draw"`
	Admin     Admin     `toml:"admin"`
	Log       Log       `toml:"log"`
}

type Server struct {
	Name          string `toml:"name"`
	Listen        string `toml:"listen"`
	PublicAddress string `toml:"public_address"`
	NodeID        int64  `toml:"node_id"`
	DataDir       string `toml:"data_dir"`
	ProxyProtocol bool   `toml:"proxy_protocol"`
	// Public channel created for the first (admin) account. Empty = none.
	DefaultChannel string `toml:"default_channel"`
}

type TLS struct {
	// "self_signed" (default), "files", or "off".
	Mode     string   `toml:"mode"`
	Hosts    []string `toml:"hosts"`
	CertFile string   `toml:"cert_file"`
	KeyFile  string   `toml:"key_file"`
}

type Database struct {
	Driver     string `toml:"driver"`
	SQLiteFile string `toml:"sqlite_file"`
	URL        string `toml:"url"`
	MaxConns   int    `toml:"max_conns"`
}

type Invites struct {
	PerUser        int    `toml:"per_user"`
	AdminUnlimited bool   `toml:"admin_unlimited"`
	DownloadURL    string `toml:"download_url"`
}

type Limits struct {
	MaxForwardMessages     int `toml:"max_forward_messages"`
	MaxPinsPerMessage      int `toml:"max_pins_per_message"`
	MaxTextLength          int `toml:"max_text_length"`
	SyncPageSize           int `toml:"sync_page_size"`
	SyncMaxPageSize        int `toml:"sync_max_page_size"`
	LoginAttemptsPerMinute int `toml:"login_attempts_per_minute"`
	MaxGroupMembers        int `toml:"max_group_members"`
	MaxUploadMB            int `toml:"max_upload_mb"`
	MaxDevices             int `toml:"max_devices"`
	PairCodeMinutes        int `toml:"pair_code_minutes"`
	MaxAIPerUser           int `toml:"max_ai_per_user"`
	MaxStickers            int `toml:"max_stickers"`
	MaxGamesPerConv        int `toml:"max_games_per_conv"`
}

type Retention struct {
	EvidenceDays    int `toml:"evidence_days"`
	LoginRecordDays int `toml:"login_record_days"`
	GamesDays       int `toml:"games_days"`
}

// Stickers configures the shared sticker library (docs/design.md §11).
type Stickers struct {
	SyncKBps       int  `toml:"sync_kbps"`
	Library        bool `toml:"library"`
	DefaultPublic  bool `toml:"default_public"`
	DedupeDistance int  `toml:"dedupe_distance"`
}

// Plugins configures NoneBot plugins of AI accounts (docs/plugins.md).
type Plugins struct {
	Enabled       bool     `toml:"enabled"`
	Python        string   `toml:"python"`
	PipIndex      string   `toml:"pip_index"`
	CommandStart  []string `toml:"command_start"`
	MaxZipMB      int      `toml:"max_zip_mb"`
	MaxUnpackedMB int      `toml:"max_unpacked_mb"`
	MaxPerAI      int      `toml:"max_per_ai"`
	// NoSpawn: run the OneBot endpoint but no NoneBot processes (tests connect themselves).
	NoSpawn bool `toml:"-"`
}

// Hosting configures AIs that run on the server (docs/design.md §10 托管).
type Hosting struct {
	Enabled    bool   `toml:"enabled"`
	MaxPerUser int    `toml:"max_per_user"`
	ClientPath string `toml:"client_path"`
	// NoSpawn: keep the records but start no clients (tests).
	NoSpawn bool `toml:"-"`
}

// Museum configures channel museums (docs/design.md §13 博物馆).
type Museum struct {
	Enabled     bool `toml:"enabled"`
	MinMembers  int  `toml:"min_members"`
	VoteMinutes int  `toml:"vote_minutes"`
}

// Helper is the server's built-in bot (docs/design.md §10 内置 bot).
type Helper struct {
	Name string `toml:"name"`
	// Autofix: a mistyped command close to a safe one just runs it.
	Autofix bool `toml:"autofix"`
	// The model its features share (an OpenAI-compatible API).
	AIURL   string `toml:"ai_url"`
	AIKey   string `toml:"ai_key"`
	AIModel string `toml:"ai_model"`
	AIProxy string `toml:"ai_proxy"`
}

// Draw configures NovelAI drawing on the built-in bot (docs/design.md §10 画画).
type Draw struct {
	Enabled        bool     `toml:"enabled"`
	Token          string   `toml:"token"`
	Proxy          string   `toml:"proxy"`
	API            string   `toml:"api"`
	DailyPerPerson int      `toml:"daily_per_person"`
	NsfwInDM       bool     `toml:"nsfw_in_dm"`
	MaxCount       int      `toml:"max_count"`
	Steps          int      `toml:"steps"`
	Scale          float64  `toml:"scale"`
	Sampler        string   `toml:"sampler"`
	Strength       float64  `toml:"strength"`
	VibeStrength   float64  `toml:"vibe_strength"`
	RefStrength    float64  `toml:"ref_strength"`
	RefFidelity    float64  `toml:"ref_fidelity"`
	Model          string   `toml:"model"`
	V5Model        string   `toml:"v5_model"`
	V5Native       bool     `toml:"v5_native"`
	Quality        string   `toml:"quality"`
	QualityV5      string   `toml:"quality_v5"`
	Negative       string   `toml:"negative"`
	BlockWords     []string `toml:"block_words"`
	AutoNsfw       bool     `toml:"auto_nsfw"`
}

// News configures 游戏资讯 (docs/design.md §10 内置 bot).
type News struct {
	Enabled        bool     `toml:"enabled"`
	AIURL          string   `toml:"ai_url"`
	AIKey          string   `toml:"ai_key"`
	AIModel        string   `toml:"ai_model"`
	AIProxy        string   `toml:"ai_proxy"`
	Proxy          string   `toml:"proxy"`
	CommunityProxy string   `toml:"steam_community_proxy"`
	CheckMinutes   int      `toml:"check_minutes"`
	DailyTime      string   `toml:"daily_time"`
	XWeekly        bool     `toml:"x_weekly"`
	WeeklyDay      string   `toml:"weekly_day"`
	WeeklyTime     string   `toml:"weekly_time"`
	WeeklyAnyone   bool     `toml:"weekly_anyone"`
	XAIKey         string   `toml:"xai_key"`
	XAIModel       string   `toml:"xai_model"`
	XAIProxy       string   `toml:"xai_proxy"`
	Sources        []string `toml:"sources"`
	PerSource      int      `toml:"per_source"`
	DigestTop      int      `toml:"digest_top"`
	SteamTop       int      `toml:"steam_top"`
	SteamPush      bool     `toml:"steam_push"`
	SteamCC        string   `toml:"steam_cc"`
	MaxPerConv     int      `toml:"max_per_conv"`
	WeiboCookie    string   `toml:"weibo_cookie"`
	TiebaCookie    string   `toml:"tieba_cookie"`
	NGACookie      string   `toml:"nga_cookie"`
	BiliCookie     string   `toml:"bili_cookie"`
	SteamCookie    string   `toml:"steam_cookie"`
}

type Media struct {
	BlockDistance int    `toml:"block_distance"`
	Netease       bool   `toml:"netease"`
	NeteaseAPI    string `toml:"netease_api"`
}

type Admin struct {
	Listen      string `toml:"listen"`
	OpenBrowser bool   `toml:"open_browser"` // open the panel at start (name kept for old configs)
	Window      bool   `toml:"window"`
	Tray        bool   `toml:"tray"`
}

type Log struct {
	Level     string `toml:"level"`
	File      string `toml:"file"`
	MaxSizeMB int    `toml:"max_size_mb"`
}

// Load reads the config file. If it does not exist, a default one is
// written first (with a random database password) and created=true is
// returned so the caller can tell the user to review it.
func Load(path string) (cfg *Config, created bool, err error) {
	if _, statErr := os.Stat(path); errors.Is(statErr, os.ErrNotExist) {
		if err := writeDefault(path); err != nil {
			return nil, false, err
		}
		created = true
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, false, err
	}
	cfg, err = Parse(string(data))
	if err != nil {
		return nil, false, fmt.Errorf("%s: %w", path, err)
	}
	return cfg, created, nil
}

// Defaults returns the built-in default settings.
func Defaults() *Config {
	cfg := &Config{}
	if _, err := toml.Decode(strings.Replace(defaultTOML, "__DB_PASSWORD__", "x", 1), cfg); err != nil {
		panic("config: built-in defaults do not parse: " + err.Error())
	}
	return cfg
}

// Parse decodes config text on top of the defaults (so keys missing from an
// older file get their default value) and validates it.
func Parse(text string) (*Config, error) {
	cfg := Defaults()
	if _, err := toml.Decode(text, cfg); err != nil {
		return nil, err
	}
	if err := cfg.validate(); err != nil {
		return nil, err
	}
	return cfg, nil
}

func writeDefault(path string) error {
	buf := make([]byte, 12)
	if _, err := rand.Read(buf); err != nil {
		return err
	}
	content := strings.Replace(defaultTOML, "__DB_PASSWORD__", hex.EncodeToString(buf), 1)
	if dir := filepath.Dir(path); dir != "" {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return err
		}
	}
	return os.WriteFile(path, []byte(content), 0o600)
}

// WriteFile validates text and replaces the config file with it. The
// previous version is kept as <path>.bak.
func WriteFile(path, text string) error {
	if _, err := Parse(text); err != nil {
		return err
	}
	if old, err := os.ReadFile(path); err == nil {
		if err := os.WriteFile(path+".bak", old, 0o600); err != nil {
			return err
		}
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(text), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// SQLitePath is the database file path (inside data_dir unless absolute).
func (c *Config) SQLitePath() string { return c.InDataDir(c.Database.SQLiteFile) }

// LogPath is the log file path, "" if file logging is off.
func (c *Config) LogPath() string {
	if c.Log.File == "" {
		return ""
	}
	return c.InDataDir(c.Log.File)
}

// InDataDir resolves a path relative to data_dir (absolute paths stay).
func (c *Config) InDataDir(p string) string {
	if filepath.IsAbs(p) {
		return p
	}
	return filepath.Join(c.Server.DataDir, p)
}

// DefaultTemplate returns the commented default config, for docs/examples.
func DefaultTemplate() string { return defaultTOML }

func (c *Config) validate() error {
	switch c.TLS.Mode {
	case "self_signed", "off":
	case "files":
		if c.TLS.CertFile == "" || c.TLS.KeyFile == "" {
			return errors.New("tls.mode = \"files\" needs tls.cert_file and tls.key_file")
		}
	default:
		return fmt.Errorf("unknown tls.mode %q", c.TLS.Mode)
	}
	if _, _, err := net.SplitHostPort(c.Server.Listen); err != nil {
		return fmt.Errorf("server.listen %q: %v", c.Server.Listen, err)
	}
	if _, _, err := net.SplitHostPort(c.Admin.Listen); err != nil {
		return fmt.Errorf("admin.listen %q: %v", c.Admin.Listen, err)
	}
	if c.Server.PublicAddress != "" {
		if host, port, err := net.SplitHostPort(c.Server.PublicAddress); err != nil || host == "" || port == "" {
			return fmt.Errorf("server.public_address %q must look like 47.1.2.3:7000 or example.com:8443", c.Server.PublicAddress)
		}
	}
	if len([]rune(c.Server.Name)) > 32 {
		return errors.New("server.name must be at most 32 characters")
	}
	if c.Server.NodeID < 0 || c.Server.NodeID > 1023 {
		return errors.New("server.node_id must be 0-1023")
	}
	switch c.Database.Driver {
	case "sqlite":
		if c.Database.SQLiteFile == "" {
			return errors.New("database.sqlite_file is empty")
		}
	case "postgres":
		if c.Database.URL == "" {
			return errors.New("database.url is empty")
		}
	default:
		return fmt.Errorf("unknown database.driver %q (use sqlite or postgres)", c.Database.Driver)
	}
	if c.Limits.MaxGroupMembers < 2 || c.Limits.MaxUploadMB < 1 {
		return errors.New("limits.max_group_members must be >= 2 and limits.max_upload_mb >= 1")
	}
	if c.Limits.MaxForwardMessages < 1 || c.Limits.MaxForwardMessages > 100 || c.Limits.MaxPinsPerMessage < 1 {
		return errors.New("invalid chat tool limits")
	}
	if c.Limits.MaxTextLength < 1 {
		return errors.New("limits.max_text_length must be >= 1")
	}
	if c.Limits.MaxStickers < 0 {
		return errors.New("limits.max_stickers must be >= 0")
	}
	if c.Limits.MaxGamesPerConv < 0 {
		return errors.New("limits.max_games_per_conv must be >= 0")
	}
	if c.Limits.MaxAIPerUser < 0 {
		return errors.New("limits.max_ai_per_user must be >= 0")
	}
	if c.Limits.MaxDevices < 0 || c.Limits.PairCodeMinutes < 1 {
		return errors.New("limits.max_devices must be >= 0 and limits.pair_code_minutes >= 1")
	}
	if c.Limits.LoginAttemptsPerMinute < 0 {
		return errors.New("limits.login_attempts_per_minute must be >= 0")
	}
	if c.Retention.EvidenceDays < 1 || c.Retention.LoginRecordDays < 1 {
		return errors.New("retention days must be >= 1")
	}
	if c.Retention.GamesDays < 1 {
		return errors.New("retention.games_days must be >= 1")
	}
	if c.Stickers.SyncKBps < 0 || c.Stickers.SyncKBps > 1048576 {
		return errors.New("stickers.sync_kbps must be 0-1048576")
	}
	if c.Stickers.DedupeDistance < 0 || c.Stickers.DedupeDistance > 64 {
		return errors.New("stickers.dedupe_distance must be 0-64")
	}
	if c.Plugins.MaxZipMB < 1 || c.Plugins.MaxUnpackedMB < c.Plugins.MaxZipMB || c.Plugins.MaxPerAI < 1 {
		return errors.New("plugins: max_zip_mb >= 1, max_unpacked_mb >= max_zip_mb, max_per_ai >= 1")
	}
	if u := c.Plugins.PipIndex; u != "" && !strings.HasPrefix(u, "https://") && !strings.HasPrefix(u, "http://") {
		return errors.New("plugins.pip_index must start with https://")
	}
	if c.Museum.MinMembers < 0 || c.Museum.VoteMinutes < 1 {
		return errors.New("museum: min_members >= 0, vote_minutes >= 1")
	}
	if n := utf8.RuneCountInString(strings.TrimSpace(c.Helper.Name)); n < 1 || n > 32 {
		return errors.New("helper.name must be 1-32 characters")
	}
	if u := c.Helper.AIURL; u != "" && !strings.HasPrefix(u, "https://") && !strings.HasPrefix(u, "http://") {
		return errors.New("helper.ai_url must start with http:// or https://")
	}
	if d := c.Draw; d.DailyPerPerson < 0 || d.MaxCount < 1 || d.MaxCount > 16 || d.Steps < 1 || d.Steps > 50 ||
		d.Scale <= 0 || d.Strength <= 0 || d.Strength > 1 || d.VibeStrength <= 0 || d.VibeStrength > 1 || d.RefStrength <= 0 || d.RefFidelity <= 0 {
		return errors.New("draw: daily_per_person >= 0, max_count 1-16, steps 1-50, scale > 0, strengths 0-1")
	}
	if u := c.Draw.API; !strings.HasPrefix(u, "https://") && !strings.HasPrefix(u, "http://") {
		return errors.New("draw.api must start with https://")
	}
	if err := c.News.check(); err != nil {
		return err
	}
	if c.Hosting.MaxPerUser < 0 {
		return errors.New("hosting.max_per_user must be >= 0")
	}
	if c.Media.BlockDistance < 0 || c.Media.BlockDistance > 64 {
		return errors.New("media.block_distance must be 0-64")
	}
	if c.Invites.PerUser < 0 || c.Invites.PerUser > 100 {
		return errors.New("invites.per_user must be 0-100")
	}
	if u := c.Invites.DownloadURL; u != "" && !strings.HasPrefix(u, "https://") && !strings.HasPrefix(u, "http://") {
		return errors.New("invites.download_url must start with https://")
	}
	if c.Limits.SyncPageSize <= 0 || c.Limits.SyncMaxPageSize < c.Limits.SyncPageSize {
		return errors.New("limits.sync_page_size must be > 0 and <= sync_max_page_size")
	}
	switch strings.ToLower(c.Log.Level) {
	case "debug", "info", "warn", "error":
	default:
		return fmt.Errorf("log.level %q: use debug, info, warn or error", c.Log.Level)
	}
	if c.Log.MaxSizeMB < 1 {
		return errors.New("log.max_size_mb must be >= 1")
	}
	return nil
}

var newsSources = []string{"bili", "news", "bing", "reddit", "youtube", "steam", "weibo", "tieba", "nga"}

func (n *News) check() error {
	hm := func(key, v string) error {
		p := strings.Split(strings.ReplaceAll(v, "：", ":"), ":")
		if len(p) == 2 {
			h, e1 := strconv.Atoi(p[0])
			m, e2 := strconv.Atoi(p[1])
			if e1 == nil && e2 == nil && h >= 0 && h < 24 && m >= 0 && m < 60 {
				return nil
			}
		}
		return fmt.Errorf("news.%s must be HH:MM, like 21:00", key)
	}
	if err := hm("daily_time", n.DailyTime); err != nil {
		return err
	}
	if err := hm("weekly_time", n.WeeklyTime); err != nil {
		return err
	}
	if !slices.Contains([]string{"sun", "mon", "tue", "wed", "thu", "fri", "sat"}, strings.ToLower(n.WeeklyDay)) {
		return errors.New("news.weekly_day must be sun, mon, tue, wed, thu, fri or sat")
	}
	for _, s := range n.Sources {
		if !slices.Contains(newsSources, s) {
			return fmt.Errorf("news.sources: unknown source %q (known: %s)", s, strings.Join(newsSources, ", "))
		}
	}
	if n.CheckMinutes < 15 || n.PerSource < 3 || n.DigestTop < 3 || n.SteamTop < 1 || n.MaxPerConv < 0 {
		return errors.New("news: check_minutes >= 15, per_source >= 3, digest_top >= 3, steam_top >= 1, max_per_conv >= 0")
	}
	if u := n.AIURL; u != "" && !strings.HasPrefix(u, "https://") && !strings.HasPrefix(u, "http://") {
		return errors.New("news.ai_url must start with http:// or https://")
	}
	return nil
}
