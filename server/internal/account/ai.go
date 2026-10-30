package account

import (
	"context"
	"crypto/rand"
	"errors"
	"strings"
	"unicode/utf8"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/apperr"
	"github.com/OzakiJUN/am/server/internal/store"
)

// AI accounts (docs/design.md §9, §10): ai-type accounts owned by a person.
// The model runs on one device of the owner (with the owner's key), which
// logs in as the AI (RunAI). Their settings (persona, model, ...) are JSON
// only the owner reads and writes.

const maxAISettings = 64 << 10

// AIInfo is one of my AI accounts with its settings.
type AIInfo struct {
	User      *store.User
	Settings  string
	UpdatedAt int64
}

// ownedAI returns an AI account of owner (user_not_found otherwise).
func (s *Service) ownedAI(ctx context.Context, owner *store.User, id int64) (*store.User, error) {
	u, err := s.st.GetUser(ctx, id)
	if errors.Is(err, store.ErrNotFound) {
		return nil, apperr.ErrUserNotFound
	}
	if err != nil {
		return nil, err
	}
	if u.OwnerID == 0 || u.OwnerID != owner.ID || u.LeftAt != 0 {
		return nil, apperr.ErrUserNotFound
	}
	return u, nil
}

func (s *Service) ListAI(ctx context.Context, owner *store.User) ([]AIInfo, error) {
	list, err := s.st.ListOwnedAI(ctx, owner.ID)
	if err != nil {
		return nil, err
	}
	out := make([]AIInfo, 0, len(list))
	for _, u := range list {
		data, at, err := s.st.GetAISettings(ctx, u.ID)
		if err != nil {
			return nil, err
		}
		out = append(out, AIInfo{User: u, Settings: data, UpdatedAt: at})
	}
	return out, nil
}

// CreateAI makes a new AI account for owner (a person, not another AI).
func (s *Service) CreateAI(ctx context.Context, owner *store.User, displayName string) (*AIInfo, error) {
	if owner.AccountType != int16(amv1.AccountType_ACCOUNT_TYPE_HUMAN) {
		return nil, apperr.ErrNoPermission
	}
	name := strings.TrimSpace(displayName)
	if n := utf8.RuneCountInString(name); n < 1 || n > 32 {
		return nil, apperr.ErrInvalidName
	}
	have, err := s.st.ListOwnedAI(ctx, owner.ID)
	if err != nil {
		return nil, err
	}
	if s.maxAI >= 0 && len(have) >= s.maxAI {
		return nil, apperr.ErrAILimit
	}
	u := &store.User{
		ID: s.ids.Next(), DisplayName: name, OwnerID: owner.ID,
		AccountType: int16(amv1.AccountType_ACCOUNT_TYPE_AI), CreatedAt: s.now().UnixMilli(),
	}
	for try := 0; ; try++ {
		u.Username = "ai_" + randomLower(10)
		err = s.st.CreateUser(ctx, u)
		if err == nil || !store.IsUniqueViolation(err) || try == 4 {
			break
		}
	}
	if err != nil {
		return nil, err
	}
	return &AIInfo{User: u}, nil
}

// UpdateAIProfile changes an AI's name, avatar (uploaded by the owner) or signature.
func (s *Service) UpdateAIProfile(ctx context.Context, owner *store.User, id int64, req *amv1.UpdateProfileRequest) (*store.User, error) {
	ai, err := s.ownedAI(ctx, owner, id)
	if err != nil {
		return nil, err
	}
	return s.updateProfile(ctx, ai, owner.ID, req)
}

// PutAISettings saves an AI's settings unless they were saved elsewhere
// since base (state_conflict).
func (s *Service) PutAISettings(ctx context.Context, owner *store.User, id int64, req *amv1.PutAISettingsRequest) (*AIInfo, error) {
	ai, err := s.ownedAI(ctx, owner, id)
	if err != nil {
		return nil, err
	}
	if len(req.GetSettings()) > maxAISettings {
		return nil, apperr.ErrTooLargeData
	}
	out := &AIInfo{User: ai, Settings: req.GetSettings()}
	err = s.st.InTx(ctx, func(q *store.Queries) error {
		_, at, err := q.GetAISettings(ctx, ai.ID)
		if err != nil {
			return err
		}
		if at != req.GetBaseUpdatedAt() {
			return apperr.ErrStateConflict
		}
		out.UpdatedAt = max(s.now().UnixMilli(), at+1)
		return q.PutAISettings(ctx, ai.ID, req.GetSettings(), out.UpdatedAt)
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// RunAI logs the calling device in as the AI: it becomes the one device
// that runs it, and the AI's other sessions end (so it never answers twice).
func (s *Service) RunAI(ctx context.Context, owner *store.User, id int64, device string, cl Client) (string, *store.User, error) {
	ai, err := s.ownedAI(ctx, owner, id)
	if err != nil {
		return "", nil, err
	}
	var token string
	var closed []int64
	err = s.st.InTx(ctx, func(q *store.Queries) error {
		var err error
		if closed, err = q.DeleteUserSessions(ctx, ai.ID); err != nil {
			return err
		}
		token, err = s.createSession(ctx, q, ai, device, "run", cl.IP)
		return err
	})
	if err != nil {
		return "", nil, err
	}
	for _, sid := range closed {
		s.push.CloseSession(sid)
	}
	return token, ai, nil
}

// DeleteAI takes an AI off the server for good (like leaving: out of every
// channel, logged out, hidden; its messages stay).
func (s *Service) DeleteAI(ctx context.Context, owner *store.User, id int64) error {
	ai, err := s.ownedAI(ctx, owner, id)
	if err != nil {
		return err
	}
	return s.Leave(ctx, ai)
}

func randomLower(n int) string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, n)
	_, _ = rand.Read(b)
	for i := range b {
		b[i] = alphabet[int(b[i])%len(alphabet)]
	}
	return string(b)
}
