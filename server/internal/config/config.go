// Package config loads config.toml. Every tunable lives here so nobody has
// to edit code to change a setting.
package config

import (
	"crypto/rand"
	_ "embed"
	"encoding/hex"
	"errors"
	"fmt"
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
	Log       Log       `toml:"log"`
}

type Server struct {
	Listen        string `toml:"listen"`
	NodeID        int64  `toml:"node_id"`
	DataDir       string `toml:"data_dir"`
	ProxyProtocol bool   `toml:"proxy_protocol"`
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
	PerUser        int  `toml:"per_user"`
	AdminUnlimited bool `toml:"admin_unlimited"`
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

type Log struct {
	Level string `toml:"level"`
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
	cfg = &Config{}
	// Defaults first, then the file on top.
	if _, err := toml.Decode(strings.Replace(defaultTOML, "__DB_PASSWORD__", "x", 1), cfg); err != nil {
		return nil, false, fmt.Errorf("parse built-in defaults: %w", err)
	}
	if _, err := toml.DecodeFile(path, cfg); err != nil {
		return nil, false, fmt.Errorf("parse %s: %w", path, err)
	}
	if err := cfg.validate(); err != nil {
		return nil, false, fmt.Errorf("%s: %w", path, err)
	}
	return cfg, created, nil
}

func writeDefault(path string) error {
	buf := make([]byte, 12)
	if _, err := rand.Read(buf); err != nil {
		return err
	}
	content := strings.Replace(defaultTOML, "__DB_PASSWORD__", hex.EncodeToString(buf), 1)
	return os.WriteFile(path, []byte(content), 0o600)
}

// SQLitePath is the database file path (inside data_dir unless absolute).
func (c *Config) SQLitePath() string {
	if filepath.IsAbs(c.Database.SQLiteFile) {
		return c.Database.SQLiteFile
	}
	return filepath.Join(c.Server.DataDir, c.Database.SQLiteFile)
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
	if c.Retention.EvidenceDays < 1 || c.Retention.LoginRecordDays < 1 {
		return errors.New("retention days must be >= 1")
	}
	if c.Media.BlockDistance < 0 || c.Media.BlockDistance > 64 {
		return errors.New("media.block_distance must be 0-64")
	}
	if c.Invites.PerUser < 0 {
		return errors.New("invites.per_user must be >= 0")
	}
	if c.Limits.SyncPageSize <= 0 || c.Limits.SyncMaxPageSize < c.Limits.SyncPageSize {
		return errors.New("limits.sync_page_size must be > 0 and <= sync_max_page_size")
	}
	return nil
}
