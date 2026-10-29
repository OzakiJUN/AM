package account

import (
	"sync"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/internal/connectcode"
)

// ServerMeta describes this server to clients: name, version and how to
// reach it (for join codes). Set by the supervisor once the certificate is
// loaded; until then join codes are left empty.
type ServerMeta struct {
	Name        string
	Version     string
	DownloadURL string
	// Join is the address part of join codes (Invite empty), nil when the
	// server has no public address configured.
	Join *connectcode.Join
}

type serverMeta struct {
	mu sync.RWMutex
	m  ServerMeta
}

// SetServer updates the server description.
func (s *Service) SetServer(m ServerMeta) {
	s.meta.mu.Lock()
	s.meta.m = m
	s.meta.mu.Unlock()
}

func (s *Service) server() ServerMeta {
	s.meta.mu.RLock()
	defer s.meta.mu.RUnlock()
	return s.meta.m
}

// ServerInfo answers GET /api/v1/server.
func (s *Service) ServerInfo() *amv1.ServerInfo {
	m := s.server()
	return &amv1.ServerInfo{Name: m.Name, Version: m.Version, DownloadUrl: m.DownloadURL}
}

// JoinCode builds the join code (and QR URL) for an invite, or "" when the
// server's public address is unknown. invite "" gives a server code.
func (s *Service) JoinCode(invite string) (code, url string) {
	m := s.server()
	if m.Join == nil {
		return "", ""
	}
	j := *m.Join
	j.Invite = invite
	code, err := j.Encode()
	if err != nil {
		return "", ""
	}
	return code, connectcode.URL(m.DownloadURL, code)
}
