// Package logx is the server's logging output: one slog logger writing to
// the console (when there is one), a size-limited log file, and an
// in-memory ring that the admin panel shows.
package logx

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// Sink receives formatted log lines. It lives for the whole process; the
// file and level can be changed when the server restarts with a new config.
type Sink struct {
	mu      sync.Mutex
	console io.Writer // nil when there is no console (Windows GUI build)
	file    *rotatingFile
	ring    *Ring
	level   slog.LevelVar
}

// NewSink creates a sink. console may be nil.
func NewSink(console io.Writer, ringSize int) *Sink {
	return &Sink{console: console, ring: NewRing(ringSize)}
}

// Ring returns the in-memory buffer of recent lines.
func (s *Sink) Ring() *Ring { return s.ring }

// Logger returns a logger writing to this sink.
func (s *Sink) Logger() *slog.Logger {
	return slog.New(slog.NewTextHandler(s, &slog.HandlerOptions{Level: &s.level}))
}

// Configure sets the level ("debug", "info", "warn", "error") and the log
// file (path "" = no file). maxBytes is the size at which the file rotates.
func (s *Sink) Configure(level, path string, maxBytes int64) error {
	var l slog.Level
	if err := l.UnmarshalText([]byte(level)); err != nil {
		l = slog.LevelInfo
	}
	s.level.Set(l)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.file != nil && (s.file.path != path || path == "") {
		s.file.close()
		s.file = nil
	}
	if path == "" {
		return nil
	}
	if s.file == nil {
		f, err := openRotating(path, maxBytes)
		if err != nil {
			return err
		}
		s.file = f
	}
	s.file.max = maxBytes
	return nil
}

// Write implements io.Writer. Errors of single outputs are ignored so a
// broken console never stops file logging.
func (s *Sink) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.console != nil {
		_, _ = s.console.Write(p)
	}
	if s.file != nil {
		s.file.write(p)
	}
	s.ring.add(p)
	return len(p), nil
}

// Close closes the log file.
func (s *Sink) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.file != nil {
		s.file.close()
		s.file = nil
	}
}

// ---- ring ----

// Line is one log line with an increasing sequence number.
type Line struct {
	Seq  uint64 `json:"seq"`
	Text string `json:"text"`
}

// Ring keeps the most recent lines.
type Ring struct {
	mu    sync.Mutex
	lines []Line
	size  int
	next  uint64
}

func NewRing(size int) *Ring { return &Ring{size: size, next: 1} }

func (r *Ring) add(p []byte) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, l := range strings.Split(strings.TrimRight(string(p), "\n"), "\n") {
		r.lines = append(r.lines, Line{Seq: r.next, Text: strings.TrimRight(l, "\r")})
		r.next++
	}
	if over := len(r.lines) - r.size; over > 0 {
		r.lines = append(r.lines[:0], r.lines[over:]...)
	}
}

// Since returns lines with Seq > after (at most the ring's size).
func (r *Ring) Since(after uint64) []Line {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := []Line{}
	for _, l := range r.lines {
		if l.Seq > after {
			out = append(out, l)
		}
	}
	return out
}

// ---- rotating file ----

type rotatingFile struct {
	path string
	max  int64
	f    *os.File
	size int64
}

func openRotating(path string, max int64) (*rotatingFile, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return nil, err
	}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	return &rotatingFile{path: path, max: max, f: f, size: st.Size()}, nil
}

func (r *rotatingFile) write(p []byte) {
	if r.f == nil {
		return
	}
	if r.max > 0 && r.size+int64(len(p)) > r.max && r.size > 0 {
		r.rotate()
		if r.f == nil {
			return
		}
	}
	n, _ := r.f.Write(p)
	r.size += int64(n)
}

// rotate renames the file to <path>.1 (replacing the previous one) and
// starts a new file.
func (r *rotatingFile) rotate() {
	r.f.Close()
	r.f = nil
	_ = os.Remove(r.path + ".1")
	_ = os.Rename(r.path, r.path+".1")
	f, err := os.OpenFile(r.path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return
	}
	r.f, r.size = f, 0
}

func (r *rotatingFile) close() {
	if r.f != nil {
		r.f.Close()
		r.f = nil
	}
}
