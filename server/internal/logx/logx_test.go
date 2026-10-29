package logx

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSinkRingAndRotation(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "logs", "am.log")
	s := NewSink(nil, 3)
	if err := s.Configure("info", path, 200); err != nil {
		t.Fatal(err)
	}
	log := s.Logger()
	log.Debug("hidden")
	for i := 0; i < 5; i++ {
		log.Info("hello", "i", i)
	}
	lines := s.Ring().Since(0)
	if len(lines) != 3 || !strings.Contains(lines[2].Text, "i=4") || lines[2].Seq != 5 {
		t.Fatalf("%+v", lines)
	}
	if got := s.Ring().Since(4); len(got) != 1 {
		t.Fatalf("%+v", got)
	}
	s.Close()
	cur, _ := os.ReadFile(path)
	old, _ := os.ReadFile(path + ".1")
	if len(old) == 0 || len(cur) == 0 || len(cur) > 200 {
		t.Fatalf("rotation: cur=%d old=%d", len(cur), len(old))
	}
	if strings.Contains(string(cur)+string(old), "hidden") {
		t.Fatal("debug line written at info level")
	}
}
