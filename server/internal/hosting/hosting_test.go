package hosting

import (
	"io"
	"log/slog"
	"path/filepath"
	"testing"

	"github.com/OzakiJUN/am/server/internal/account"
	"github.com/OzakiJUN/am/server/internal/config"
)

// The hosting folder is made absolute: the client starts in the AI's folder,
// where a relative "data/hosting/.../host.json" would not be found.
func TestAbsoluteDir(t *testing.T) {
	t.Chdir(t.TempDir())
	s, err := New(Config{Dir: filepath.Join("data", "hosting")}, nil, nil, account.New(nil, nil, config.Invites{}, nil, nil),
		slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if !filepath.IsAbs(s.WorkDir(1)) || !filepath.IsAbs(s.aiDir(1)) {
		t.Fatalf("relative: %s", s.WorkDir(1))
	}
}

func TestSealOpen(t *testing.T) {
	t.Chdir(t.TempDir())
	s, err := New(Config{Dir: "h"}, nil, nil, account.New(nil, nil, config.Invites{}, nil, nil), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	sealed, err := s.seal([]byte(`[{"key":"sk-1"}]`))
	if err != nil {
		t.Fatal(err)
	}
	if b, err := s.open(sealed); err != nil || string(b) != `[{"key":"sk-1"}]` {
		t.Fatalf("open: %s %v", b, err)
	}
	// The same key file next time (restart): still readable.
	s2, _ := New(Config{Dir: "h"}, nil, nil, account.New(nil, nil, config.Invites{}, nil, nil), slog.New(slog.NewTextHandler(io.Discard, nil)))
	defer s2.Close()
	if _, err := s2.open(sealed); err != nil {
		t.Fatal("key not kept across restarts")
	}
	if _, err := s.open(sealed[:10]); err == nil {
		t.Fatal("cut secrets opened")
	}
}
