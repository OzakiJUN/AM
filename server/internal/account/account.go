// Package account handles registration, login, sessions and invite codes.
package account

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/apperr"
	"github.com/OzakiJUN/am/server/internal/config"
	"github.com/OzakiJUN/am/server/internal/idgen"
	"github.com/OzakiJUN/am/server/internal/push"
	"github.com/OzakiJUN/am/server/internal/store"
)

var usernameRe = regexp.MustCompile(`^[A-Za-z0-9_]{3,20}$`)

// Only refresh last_seen if it is older than this, to avoid a DB write on
// every request.
const touchInterval = time.Minute

type Service struct {
	st      *store.Store
	ids     *idgen.Generator
	invites config.Invites
	push    push.Pusher
	now     func() time.Time
}

func New(st *store.Store, ids *idgen.Generator, invites config.Invites, p push.Pusher) *Service {
	return &Service{st: st, ids: ids, invites: invites, push: p, now: time.Now}
}

// Register creates a human account using an invite code and logs it in.
// The account created with the bootstrap code becomes the site admin.
func (s *Service) Register(ctx context.Context, req *amv1.RegisterRequest) (token string, u *store.User, err error) {
	username := strings.TrimSpace(req.GetUsername())
	display := strings.TrimSpace(req.GetDisplayName())
	if display == "" {
		display = username
	}
	switch {
	case !usernameRe.MatchString(username):
		return "", nil, apperr.ErrInvalidUsername
	case utf8.RuneCountInString(req.GetPassword()) < 8:
		return "", nil, apperr.ErrWeakPassword
	case utf8.RuneCountInString(display) > 32:
		return "", nil, apperr.ErrInvalidName
	}
	hash, err := HashPassword(req.GetPassword())
	if err != nil {
		return "", nil, err
	}
	now := s.now().UnixMilli()
	u = &store.User{
		ID:           s.ids.Next(),
		Username:     username,
		DisplayName:  display,
		PasswordHash: hash,
		AccountType:  int16(amv1.AccountType_ACCOUNT_TYPE_HUMAN),
		CreatedAt:    now,
	}
	err = s.st.InTx(ctx, func(q *store.Queries) error {
		code := strings.ToUpper(strings.TrimSpace(req.GetInviteCode()))
		inv, err := q.LockUnusedInvite(ctx, code)
		if errors.Is(err, store.ErrNotFound) {
			return apperr.ErrInvalidInvite
		}
		if err != nil {
			return err
		}
		u.IsSiteAdmin = inv.CreatedBy == 0
		if err := q.CreateUser(ctx, u); err != nil {
			if store.IsUniqueViolation(err) {
				return apperr.ErrUsernameTaken
			}
			return err
		}
		return q.MarkInviteUsed(ctx, code, u.ID, now)
	})
	if err != nil {
		return "", nil, err
	}
	token, err = s.newSession(ctx, u.ID, req.GetDeviceName())
	if err != nil {
		return "", nil, err
	}
	return token, u, nil
}

func (s *Service) Login(ctx context.Context, req *amv1.LoginRequest) (string, *store.User, error) {
	u, err := s.st.GetUserByUsername(ctx, strings.TrimSpace(req.GetUsername()))
	if errors.Is(err, store.ErrNotFound) {
		// Still spend the hashing time so response time does not reveal
		// whether the username exists.
		_, _ = CheckPassword(req.GetPassword(), dummyHash)
		return "", nil, apperr.ErrWrongPassword
	}
	if err != nil {
		return "", nil, err
	}
	if u.PasswordHash == "" {
		return "", nil, apperr.ErrWrongPassword
	}
	ok, err := CheckPassword(req.GetPassword(), u.PasswordHash)
	if err != nil {
		return "", nil, err
	}
	if !ok {
		return "", nil, apperr.ErrWrongPassword
	}
	if u.Banned {
		return "", nil, apperr.ErrBanned
	}
	token, err := s.newSession(ctx, u.ID, req.GetDeviceName())
	if err != nil {
		return "", nil, err
	}
	return token, u, nil
}

// dummyHash is a valid hash of a random password, used for timing equalisation.
var dummyHash, _ = HashPassword("not-a-real-password-just-timing")

func (s *Service) newSession(ctx context.Context, userID int64, device string) (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	token := "am_" + base64.RawURLEncoding.EncodeToString(raw)
	now := s.now().UnixMilli()
	device = strings.TrimSpace(device)
	if utf8.RuneCountInString(device) > 64 {
		device = string([]rune(device)[:64])
	}
	sess := &store.Session{ID: s.ids.Next(), UserID: userID, DeviceName: device, CreatedAt: now, LastSeen: now}
	if err := s.st.CreateSession(ctx, sess, hashToken(token)); err != nil {
		return "", err
	}
	return token, nil
}

func hashToken(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}

// Authenticate resolves a session token. Banned users are rejected.
func (s *Service) Authenticate(ctx context.Context, token string) (*store.Session, *store.User, error) {
	if !strings.HasPrefix(token, "am_") {
		return nil, nil, apperr.ErrUnauthorized
	}
	sess, u, err := s.st.GetSessionByTokenHash(ctx, hashToken(token))
	if errors.Is(err, store.ErrNotFound) {
		return nil, nil, apperr.ErrUnauthorized
	}
	if err != nil {
		return nil, nil, err
	}
	if u.Banned {
		return nil, nil, apperr.ErrBanned
	}
	now := s.now()
	if now.Sub(time.UnixMilli(sess.LastSeen)) > touchInterval {
		_ = s.st.TouchSession(ctx, sess.ID, now.UnixMilli())
	}
	return sess, u, nil
}

func (s *Service) ListSessions(ctx context.Context, userID, currentID int64) (*amv1.ListSessionsResponse, error) {
	list, err := s.st.ListSessions(ctx, userID)
	if err != nil {
		return nil, err
	}
	out := &amv1.ListSessionsResponse{}
	for _, se := range list {
		out.Sessions = append(out.Sessions, &amv1.DeviceSession{
			Id: se.ID, DeviceName: se.DeviceName, CreatedAt: se.CreatedAt, LastSeen: se.LastSeen,
			Current: se.ID == currentID,
		})
	}
	return out, nil
}

// RevokeSession logs out one device and disconnects it immediately.
func (s *Service) RevokeSession(ctx context.Context, userID, sessionID int64) error {
	err := s.st.DeleteSession(ctx, userID, sessionID)
	if errors.Is(err, store.ErrNotFound) {
		return apperr.ErrNotFound
	}
	if err != nil {
		return err
	}
	s.push.CloseSession(sessionID)
	return nil
}

// ---- invites ----

func (s *Service) remainingInvites(u *store.User, used int) int {
	if u.IsSiteAdmin && s.invites.AdminUnlimited {
		return -1 // unlimited
	}
	if r := s.invites.PerUser - used; r > 0 {
		return r
	}
	return 0
}

func (s *Service) ListInvites(ctx context.Context, u *store.User) (*amv1.ListInvitesResponse, error) {
	list, err := s.st.ListInvitesBy(ctx, u.ID)
	if err != nil {
		return nil, err
	}
	out := &amv1.ListInvitesResponse{Remaining: int32(s.remainingInvites(u, len(list)))}
	for _, inv := range list {
		out.Invites = append(out.Invites, &amv1.Invite{
			Code: inv.Code, CreatedAt: inv.CreatedAt, UsedBy: inv.UsedBy, UsedByName: inv.UsedByName,
		})
	}
	return out, nil
}

func (s *Service) CreateInvite(ctx context.Context, u *store.User) (*amv1.Invite, error) {
	var code string
	err := s.st.InTx(ctx, func(q *store.Queries) error {
		used, err := q.CountInvitesBy(ctx, u.ID)
		if err != nil {
			return err
		}
		if s.remainingInvites(u, used) == 0 {
			return apperr.ErrInviteLimit
		}
		code = newInviteCode()
		return q.CreateInvite(ctx, code, u.ID, s.now().UnixMilli())
	})
	if err != nil {
		return nil, err
	}
	return &amv1.Invite{Code: code, CreatedAt: s.now().UnixMilli()}, nil
}

// EnsureBootstrapInvite makes sure a fresh server has a way in: when there
// are no users yet, it returns an unused bootstrap code (creating one if
// needed). Returns "" once anyone has registered.
func (s *Service) EnsureBootstrapInvite(ctx context.Context) (string, error) {
	n, err := s.st.CountUsers(ctx)
	if err != nil || n > 0 {
		return "", err
	}
	code, err := s.st.UnusedBootstrapInvite(ctx)
	if err == nil {
		return code, nil
	}
	if !errors.Is(err, store.ErrNotFound) {
		return "", err
	}
	code = newInviteCode()
	return code, s.st.CreateInvite(ctx, code, 0, s.now().UnixMilli())
}

// Invite codes: 10 characters from an alphabet without look-alike letters.
const inviteAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

func newInviteCode() string {
	b := make([]byte, 10)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	for i := range b {
		b[i] = inviteAlphabet[int(b[i])%len(inviteAlphabet)]
	}
	return string(b)
}
