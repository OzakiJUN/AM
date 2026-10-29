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
	"strings"

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
	MaxTextLength          int `toml:"max_text_length"`
	SyncPageSize           int `toml:"sync_page_size"`
	SyncMaxPageSize        int `toml:"sync_max_page_size"`
	LoginAttemptsPerMinute int `toml:"login_attempts_per_minute"`
	MaxGroupMembers        int `toml:"max_group_members"`
	MaxUploadMB            int `toml:"max_upload_mb"`
}

type Retention struct {
	EvidenceDays    int `toml:"evidence_days"`
	LoginRecordDays int `toml:"login_record_days"`
}

type Media struct {
	BlockDistance int `toml:"block_distance"`
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
	if c.Limits.MaxTextLength < 1 {
		return errors.New("limits.max_text_length must be >= 1")
	}
	if c.Limits.LoginAttemptsPerMinute < 0 {
		return errors.New("limits.login_attempts_per_minute must be >= 0")
	}
	if c.Retention.EvidenceDays < 1 || c.Retention.LoginRecordDays < 1 {
		return errors.New("retention days must be >= 1")
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
