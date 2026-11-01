package account

import (
	"context"
	"crypto/rand"
	"errors"
	"regexp"
	"strings"
	"time"
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
	// People waiting to be let into its shared room.
	ShareRequests int
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

// OwnedAI returns one of owner's bot / AI accounts that is still on the
// server (anything else: user_not_found).
func (s *Service) OwnedAI(ctx context.Context, owner *store.User, id int64) (*store.User, error) {
	return s.ownedAI(ctx, owner, id)
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
		reqs, err := s.st.ShareRequests(ctx, u.ID)
		if err != nil {
			return nil, err
		}
		out = append(out, AIInfo{User: u, Settings: data, UpdatedAt: at, ShareRequests: len(reqs)})
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

// ---- its own portrait pack ----

var moodRe = regexp.MustCompile(`^[a-z_]{1,16}$`)

const maxPortraits = 24

// PortraitPack returns any bot / AI's pack (mood -> media id; empty = default pack).
func (s *Service) PortraitPack(ctx context.Context, id int64) (map[string]int64, error) {
	u, err := s.st.GetUser(ctx, id)
	if errors.Is(err, store.ErrNotFound) || (err == nil && u.OwnerID == 0) {
		return nil, apperr.ErrUserNotFound
	}
	if err != nil {
		return nil, err
	}
	return s.st.PortraitPack(ctx, id)
}

// SetPortraitPack replaces my AI's pack with images I uploaded.
func (s *Service) SetPortraitPack(ctx context.Context, owner *store.User, id int64, pack map[string]int64) error {
	ai, err := s.ownedAI(ctx, owner, id)
	if err != nil {
		return err
	}
	if len(pack) > maxPortraits {
		return apperr.ErrBadRequest
	}
	old, err := s.st.PortraitPack(ctx, id)
	if err != nil {
		return err
	}
	kept := map[int64]bool{}
	for _, m := range old {
		kept[m] = true
	}
	for mood, m := range pack {
		if !moodRe.MatchString(mood) {
			return apperr.ErrBadRequest
		}
		if !kept[m] {
			if _, err := s.media.OwnUpload(ctx, owner.ID, m, true); err != nil {
				return err
			}
		}
	}
	return s.st.InTx(ctx, func(q *store.Queries) error {
		return q.SetPortraitPack(ctx, ai.ID, pack, time.Now().UnixMilli())
	})
}

// ---- asking to talk with someone's AI ----

// RequestShare: me asks the owner of a bot / AI to let me talk with it.
func (s *Service) RequestShare(ctx context.Context, me *store.User, aiID int64, userView func(*store.User) *amv1.User) error {
	ai, err := s.st.GetUser(ctx, aiID)
	if errors.Is(err, store.ErrNotFound) || (err == nil && (ai.OwnerID == 0 || ai.Gone())) {
		return apperr.ErrUserNotFound
	}
	if err != nil {
		return err
	}
	if me.AccountType != int16(amv1.AccountType_ACCOUNT_TYPE_HUMAN) || ai.OwnerID == me.ID {
		return apperr.ErrNoPermission
	}
	if err := s.st.AddShareRequest(ctx, ai.ID, me.ID, time.Now().UnixMilli()); err != nil {
		return err
	}
	s.push.ToUsers([]int64{ai.OwnerID}, &amv1.ServerFrame{Msg: &amv1.ServerFrame_AiShareRequest{AiShareRequest: &amv1.AIShareRequestPush{
		AiId: ai.ID, User: userView(me),
	}}}, 0)
	return nil
}

// ShareRequests lists who asked to talk with my AI (still on the server).
func (s *Service) ShareRequests(ctx context.Context, owner *store.User, aiID int64) ([]*store.User, error) {
	if _, err := s.ownedAI(ctx, owner, aiID); err != nil {
		return nil, err
	}
	ids, err := s.st.ShareRequests(ctx, aiID)
	if err != nil {
		return nil, err
	}
	users, err := s.st.GetUsers(ctx, ids)
	if err != nil {
		return nil, err
	}
	var out []*store.User
	for _, id := range ids {
		if u := users[id]; u != nil && !u.Gone() {
			out = append(out, u)
		}
	}
	return out, nil
}

// TakeShareRequest removes a request to answer it; returns the AI, the asker
// and its shared room id (0 = none yet).
func (s *Service) TakeShareRequest(ctx context.Context, owner *store.User, aiID, userID int64) (ai, asker *store.User, room int64, err error) {
	if ai, err = s.ownedAI(ctx, owner, aiID); err != nil {
		return nil, nil, 0, err
	}
	ok, err := s.st.DeleteShareRequest(ctx, aiID, userID)
	if err != nil {
		return nil, nil, 0, err
	}
	if !ok {
		return nil, nil, 0, apperr.ErrNotFound
	}
	if asker, err = s.st.GetUser(ctx, userID); err != nil {
		return nil, nil, 0, err
	}
	room, err = s.st.AIRoom(ctx, aiID)
	return ai, asker, room, err
}
