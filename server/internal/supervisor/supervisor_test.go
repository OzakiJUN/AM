package supervisor

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/OzakiJUN/am/server/internal/admin"
	"github.com/OzakiJUN/am/server/internal/config"
	"github.com/OzakiJUN/am/server/internal/logx"
)

func waitState(t *testing.T, s *Supervisor, want admin.State, after time.Time) admin.Snapshot {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		snap := s.Snapshot()
		if snap.State == want && (want != admin.StateRunning || snap.StartedAt.After(after)) {
			return snap
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("state %s not reached; now %s (%s)", want, s.Snapshot().State, s.Snapshot().Error)
	return admin.Snapshot{}
}

func TestRestartAndRecover(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	if _, _, err := config.Load(path); err != nil {
		t.Fatal(err)
	}
	text, _ := os.ReadFile(path)
	good, err := config.Apply(string(text), []config.Change{
		{Section: "server", Key: "listen", Value: "127.0.0.1:0"},
		{Section: "server", Key: "data_dir", Value: filepath.Join(dir, "data")},
		{Section: "admin", Key: "listen", Value: "127.0.0.1:0"},
		{Section: "tls", Key: "mode", Value: "off"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := config.WriteFile(path, good); err != nil {
		t.Fatal(err)
	}
	boot, _, err := LoadBootConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	sink := logx.NewSink(nil, 100)
	defer sink.Close()
	ctx, cancel := context.WithCancel(context.Background())
	s := New(Options{ConfigPath: path, Version: "test", Sink: sink, Quit: cancel})
	done := make(chan error, 1)
	go func() { done <- s.Run(ctx, boot) }()

	first := waitState(t, s, admin.StateRunning, time.Time{})
	if first.App == nil || first.BootstrapInvite == "" {
		t.Fatalf("running snapshot: %+v", first)
	}
	if !strings.Contains(s.AdminURL(), "login?key=") {
		t.Fatal(s.AdminURL())
	}

	// Restart picks up the same config.
	s.Restart()
	second := waitState(t, s, admin.StateRunning, first.StartedAt)
	if second.App == first.App {
		t.Fatal("app not recreated")
	}

	// A broken config file gives the error state; fixing it recovers.
	if err := os.WriteFile(path, []byte("[server\nbroken"), 0o600); err != nil {
		t.Fatal(err)
	}
	s.Restart()
	bad := waitState(t, s, admin.StateError, time.Time{})
	if bad.App != nil || bad.Error == "" {
		t.Fatalf("error snapshot: %+v", bad)
	}
	if err := os.WriteFile(path, []byte(good), 0o600); err != nil {
		t.Fatal(err)
	}
	s.Restart()
	waitState(t, s, admin.StateRunning, second.StartedAt)

	s.Quit()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Run did not return")
	}
}

func TestPanelURL(t *testing.T) {
	if got := PanelURL("0.0.0.0:8444", "k"); got != "http://127.0.0.1:8444/login?key=k" {
		t.Fatal(got)
	}
	if got := PanelURL("[::1]:8444", ""); got != "http://[::1]:8444/" {
		t.Fatal(got)
	}
}

func TestAdminKeyStable(t *testing.T) {
	dir := t.TempDir()
	a, err := AdminKey(dir)
	if err != nil || len(a) < 16 {
		t.Fatal(a, err)
	}
	b, _ := AdminKey(dir)
	if a != b {
		t.Fatal("key changed")
	}
}
