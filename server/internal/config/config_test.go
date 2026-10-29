package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestApplyKeepsCommentsAndAddsKeys(t *testing.T) {
	// An older file: no [admin] section, no server.public_address, CRLF.
	old := strings.ReplaceAll(`# my notes
[server]
# where to listen
listen = "0.0.0.0:8443"
data_dir = "data"

[log]
level = "info"
`, "\n", "\r\n")
	out, err := Apply(old, []Change{
		{"server", "listen", "0.0.0.0:9000"},
		{"server", "public_address", `1.2.3.4:7000`},
		{"server", "name", `小克 "AM"`},
		{"admin", "open_browser", false},
		{"log", "max_size_mb", 20},
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"# my notes\r\n", "# where to listen\r\nlisten = \"0.0.0.0:9000\"\r\n",
		"public_address = \"1.2.3.4:7000\"", "[admin]\r\nopen_browser = false", "max_size_mb = 20"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
	if strings.Contains(strings.ReplaceAll(out, "\r\n", ""), "\n") {
		t.Error("mixed line endings")
	}
	cfg, err := Parse(out)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Server.Name != `小克 "AM"` || cfg.Server.Listen != "0.0.0.0:9000" || cfg.Admin.OpenBrowser ||
		cfg.Log.MaxSizeMB != 20 || cfg.Admin.Listen != "127.0.0.1:8444" {
		t.Fatalf("%+v", cfg)
	}
	// The key added to [server] stays inside [server], before [log].
	if strings.Index(out, "public_address") > strings.Index(out, "[log]") {
		t.Error("public_address added in the wrong section")
	}
}

func TestApplyRejectsInvalid(t *testing.T) {
	if _, err := Apply(defaultTOML, []Change{{"server", "public_address", "no-port"}}); err == nil {
		t.Fatal("want error")
	}
	if _, err := Apply(defaultTOML, []Change{{"limits", "max_upload_mb", 0}}); err == nil {
		t.Fatal("want error")
	}
}

func TestWriteFileKeepsBackup(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	cfg, created, err := Load(path)
	if err != nil || !created || cfg.Server.Name == "" {
		t.Fatal(cfg, created, err)
	}
	orig, _ := os.ReadFile(path)
	if err := WriteFile(path, "this is [not toml"); err == nil {
		t.Fatal("invalid text accepted")
	}
	next, err := Apply(string(orig), []Change{{"invites", "per_user", 5}})
	if err != nil {
		t.Fatal(err)
	}
	if err := WriteFile(path, next); err != nil {
		t.Fatal(err)
	}
	bak, _ := os.ReadFile(path + ".bak")
	if string(bak) != string(orig) {
		t.Fatal("backup differs")
	}
	cfg, _, err = Load(path)
	if err != nil || cfg.Invites.PerUser != 5 {
		t.Fatal(cfg, err)
	}
}
