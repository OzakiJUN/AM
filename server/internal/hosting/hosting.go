// Package hosting runs AIs on the server (docs/design.md §10 托管): an
// owner asks, a site admin approves, then am-server starts the AM desktop
// client without a window in host mode for that AI (`AM.exe --host
// <file>`), logged in as the AI, with the owner's model keys and its own
// work folder. The owner's computer can be off.
package hosting

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/OzakiJUN/am/server/internal/account"
	"github.com/OzakiJUN/am/server/internal/apperr"
	"github.com/OzakiJUN/am/server/internal/idgen"
	"github.com/OzakiJUN/am/server/internal/store"
)

var (
	ErrHostingOff   = apperr.New(http.StatusForbidden, "hosting_off", "hosting AIs is turned off on this server")
	ErrHostingLimit = apperr.New(http.StatusForbidden, "hosting_limit", "you already have the most hosted AIs allowed")
)

// RunnerID is settings.runner.id of a hosted AI (the host client's device id).
const RunnerID = "server-host"

// RunnerName is what the owner sees as the device that runs it.
const RunnerName = "服务器托管"

const maxSecrets = 64 << 10

// Config is the [hosting] section plus where things go.
type Config struct {
	Enabled    bool
	MaxPerUser int
	ClientPath string
	// Dir: data/hosting.
	Dir   string
	Spawn bool
}

// Service keeps hosting requests and runs the approved ones.
type Service struct {
	cfg  Config
	st   *store.Store
	ids  *idgen.Generator
	acct *account.Service
	log  *slog.Logger
	now  func() time.Time
	key  []byte
	mgr  *manager
}

func New(cfg Config, st *store.Store, ids *idgen.Generator, acct *account.Service, log *slog.Logger) (*Service, error) {
	// Absolute: the client starts in the AI's folder, where a relative
	// "data/hosting/..." (the host file, its folders) would not be found.
	dir, err := filepath.Abs(cfg.Dir)
	if err != nil {
		return nil, err
	}
	cfg.Dir = dir
	s := &Service{cfg: cfg, st: st, ids: ids, acct: acct, log: log, now: time.Now}
	if err := os.MkdirAll(cfg.Dir, 0o700); err != nil {
		return nil, err
	}
	k, err := loadKey(filepath.Join(cfg.Dir, "key"))
	if err != nil {
		return nil, err
	}
	s.key = k
	s.mgr = newManager(s)
	// The owner made one of their devices run it: it's no longer hosted.
	acct.OnAIRun(func(ctx context.Context, aiID int64) {
		if h, err := st.GetHosting(ctx, aiID); err == nil && h != nil {
			_ = st.DeleteHosting(ctx, aiID)
			log.Info("hosting ended: the owner runs the AI again", "ai", aiID)
			s.mgr.Sync()
		}
	})
	return s, nil
}

// Enabled: people may ask for hosting.
func (s *Service) Enabled() bool { return s.cfg.Enabled && s.cfg.MaxPerUser > 0 }

// SetEndpoint tells the host clients how to reach this server (loopback
// address, plain or the certificate pin as hex). Called once TLS is up.
func (s *Service) SetEndpoint(address string, plain bool, pin string) {
	s.mgr.setEndpoint(endpoint{Address: address, Plain: plain, Pin: pin})
}

// Start runs the approved AIs (and keeps them running) until Close.
func (s *Service) Start() { s.mgr.Sync() }

// Close stops every host client.
func (s *Service) Close() { s.mgr.close() }

// ---- keys at rest ----

func loadKey(path string) ([]byte, error) {
	if b, err := os.ReadFile(path); err == nil && len(b) == 32 {
		return b, nil
	}
	k := make([]byte, 32)
	if _, err := rand.Read(k); err != nil {
		return nil, err
	}
	return k, os.WriteFile(path, k, 0o600)
}

func (s *Service) seal(plain []byte) (string, error) {
	block, err := aes.NewCipher(s.key)
	if err != nil {
		return "", err
	}
	g, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, g.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(g.Seal(nonce, nonce, plain, nil)), nil
}

func (s *Service) open(sealed string) ([]byte, error) {
	b, err := base64.StdEncoding.DecodeString(sealed)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(s.key)
	if err != nil {
		return nil, err
	}
	g, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(b) < g.NonceSize() {
		return nil, errors.New("hosting: secrets too short")
	}
	return g.Open(nil, b[:g.NonceSize()], b[g.NonceSize():], nil)
}

// ---- owners ----

// View is an AI's hosting as its owner (and the panel) sees it.
type View struct {
	*store.AIHosting
	// The host client: off | starting | running | error
	State string
	Error string
	Log   []string
}

func (s *Service) view(h *store.AIHosting) *View {
	v := &View{AIHosting: h, State: "off"}
	if h.Status == "approved" {
		v.State, v.Error, v.Log = s.mgr.status(h.AIID)
	}
	return v
}

// Of returns an AI's hosting (nil when it isn't hosted or asked for).
func (s *Service) Of(ctx context.Context, aiID int64) (*View, error) {
	h, err := s.st.GetHosting(ctx, aiID)
	if errors.Is(err, store.ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return s.view(h), nil
}

// Request asks for one of my AIs to be hosted, with my model providers
// (JSON from the client, keys included). Asking again replaces the keys;
// an approved AI stays approved. A site admin's own request is approved.
func (s *Service) Request(ctx context.Context, owner *store.User, aiID int64, providers string) (*View, error) {
	if !s.Enabled() {
		return nil, ErrHostingOff
	}
	if _, err := s.acct.OwnedAI(ctx, owner, aiID); err != nil {
		return nil, err
	}
	if len(providers) > maxSecrets || !json.Valid([]byte(providers)) {
		return nil, apperr.ErrBadRequest
	}
	mine, err := s.st.HostingOfOwner(ctx, owner.ID)
	if err != nil {
		return nil, err
	}
	var cur *store.AIHosting
	others := 0
	for _, h := range mine {
		if h.AIID == aiID {
			cur = h
		} else if h.Status != "rejected" {
			others++
		}
	}
	if others >= s.cfg.MaxPerUser {
		return nil, ErrHostingLimit
	}
	sealed, err := s.seal([]byte(providers))
	if err != nil {
		return nil, err
	}
	now := s.now().UnixMilli()
	h := &store.AIHosting{AIID: aiID, OwnerID: owner.ID, Status: "pending", Secrets: sealed, RequestedAt: now}
	if cur != nil && cur.Status == "approved" {
		h.Status, h.DecidedBy, h.DecidedAt = "approved", cur.DecidedBy, cur.DecidedAt
	} else if owner.IsSiteAdmin {
		h.Status, h.DecidedBy, h.DecidedAt = "approved", owner.ID, now
	}
	err = s.st.InTx(ctx, func(q *store.Queries) error {
		if err := q.PutHosting(ctx, h); err != nil {
			return err
		}
		if h.Status == "approved" && (cur == nil || cur.Status != "approved") {
			return s.audit(ctx, q, owner.ID, "hosting_approve", aiID, "asked by a site admin")
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if h.Status == "approved" {
		if err := s.acct.SetAIRunner(ctx, aiID, RunnerID, RunnerName); err != nil {
			return nil, err
		}
	}
	s.log.Info("hosting requested", "ai", aiID, "owner", owner.ID, "status", h.Status)
	s.mgr.Sync()
	if cur != nil && cur.Status == "approved" {
		s.mgr.restart(aiID) // it was running: start again with the new keys
	}
	return s.view(h), nil
}

// Cancel takes my AI off the server (or withdraws the request).
func (s *Service) Cancel(ctx context.Context, owner *store.User, aiID int64) error {
	if _, err := s.acct.OwnedAI(ctx, owner, aiID); err != nil {
		return err
	}
	return s.end(ctx, aiID)
}

func (s *Service) end(ctx context.Context, aiID int64) error {
	h, err := s.st.GetHosting(ctx, aiID)
	if errors.Is(err, store.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := s.st.DeleteHosting(ctx, aiID); err != nil {
		return err
	}
	s.mgr.Sync()
	if h.Status == "approved" {
		s.mgr.waitStopped(aiID)
		// Nobody runs it now; the owner picks a device (and the host's login ends).
		_ = s.acct.SetAIRunner(ctx, aiID, "", "")
		_ = s.acct.EndAISessions(ctx, aiID)
	}
	return nil
}

// ---- site admins (panel) ----

func (s *Service) audit(ctx context.Context, q *store.Queries, actor int64, action string, aiID int64, detail string) error {
	return q.AddAudit(ctx, &store.AuditEntry{ID: s.ids.Next(), ActorID: actor, Action: action, TargetID: aiID,
		Detail: detail, CreatedAt: s.now().UnixMilli()})
}

// Decide approves or rejects a request; rejecting an approved one stops it.
func (s *Service) Decide(ctx context.Context, actor, aiID int64, approve bool, reason string) error {
	h, err := s.st.GetHosting(ctx, aiID)
	if errors.Is(err, store.ErrNotFound) {
		return apperr.ErrNotFound
	}
	if err != nil {
		return err
	}
	status, action := "rejected", "hosting_reject"
	if approve {
		status, action, reason = "approved", "hosting_approve", ""
	}
	err = s.st.InTx(ctx, func(q *store.Queries) error {
		if err := q.DecideHosting(ctx, aiID, status, actor, reason, s.now().UnixMilli()); err != nil {
			return err
		}
		return s.audit(ctx, q, actor, action, aiID, reason)
	})
	if err != nil {
		return err
	}
	if approve {
		if err := s.acct.SetAIRunner(ctx, aiID, RunnerID, RunnerName); err != nil {
			return err
		}
		s.mgr.Sync()
		return nil
	}
	s.mgr.Sync()
	if h.Status == "approved" {
		s.mgr.waitStopped(aiID)
		_ = s.acct.SetAIRunner(ctx, aiID, "", "")
		_ = s.acct.EndAISessions(ctx, aiID)
	}
	return nil
}

// AdminList lists hosting rows for the panel ("" = every status).
func (s *Service) AdminList(ctx context.Context, status string) ([]*View, error) {
	list, err := s.st.ListHostingAdmin(ctx, status)
	if err != nil {
		return nil, err
	}
	out := make([]*View, len(list))
	for i, h := range list {
		out[i] = s.view(h)
	}
	return out, nil
}

// Pending counts requests waiting for a site admin.
func (s *Service) Pending(ctx context.Context) (int, error) { return s.st.CountPendingHosting(ctx) }

// WorkDir is a hosted AI's own folder for its file tools.
func (s *Service) WorkDir(aiID int64) string {
	return filepath.Join(s.aiDir(aiID), "work")
}

func (s *Service) aiDir(aiID int64) string {
	return filepath.Join(s.cfg.Dir, "ai-"+strconv.FormatInt(aiID, 10))
}

// providers reads a hosted AI's model providers.
func (s *Service) providers(h *store.AIHosting) (json.RawMessage, error) {
	b, err := s.open(h.Secrets)
	if err != nil {
		return nil, fmt.Errorf("hosting: keys can't be read (was data/hosting/key replaced?): %w", err)
	}
	return b, nil
}
