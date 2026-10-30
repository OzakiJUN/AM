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
	"github.com/OzakiJUN/am/internal/connectcode"
	"github.com/OzakiJUN/am/server/internal/apperr"
	"github.com/OzakiJUN/am/server/internal/config"
	"github.com/OzakiJUN/am/server/internal/idgen"
	"github.com/OzakiJUN/am/server/internal/media"
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
	media   *media.Service
	now     func() time.Time
	meta    serverMeta
	// Called after an account is created or comes back after leaving
	// (outside the transaction).
	onRegistered func(ctx context.Context, u *store.User)
	// Called after an account left the server (outside the transaction).
	onLeft func(ctx context.Context, u *store.User)
	// Most devices a human account may be logged in on (0 = no limit), and
	// how long a pairing ticket works.
	maxDevices int
	pairTTL    time.Duration
	maxAI      int
	// Random id of this server process (ServerInfo.instance_id).
	instance string
}

// OnRegistered sets a hook that runs after each new account is created
// (conv uses it to put new accounts into the public channels).
func (s *Service) OnRegistered(fn func(ctx context.Context, u *store.User)) { s.onRegistered = fn }

// OnLeft sets a hook that runs after an account left the server (conv uses
// it to take the account out of every channel).
func (s *Service) OnLeft(fn func(ctx context.Context, u *store.User)) { s.onLeft = fn }

func New(st *store.Store, ids *idgen.Generator, invites config.Invites, p push.Pusher, md *media.Service) *Service {
	return &Service{st: st, ids: ids, invites: invites, push: p, media: md, now: time.Now, pairTTL: 5 * time.Minute, instance: randomLower(16)}
}

// SetAILimit sets limits.max_ai_per_user.
func (s *Service) SetAILimit(n int) { s.maxAI = n }

// SetDeviceLimits sets limits.max_devices and limits.pair_code_minutes.
func (s *Service) SetDeviceLimits(maxDevices int, pairTTL time.Duration) {
	s.maxDevices, s.pairTTL = maxDevices, pairTTL
}

// Client describes where a request came from, for login records.
type Client struct {
	IP string
}

// Register creates a human account using an invite code and logs it in.
// Accounts created with the bootstrap code (or an admin-panel code marked
// "makes admin") become site admins.
func (s *Service) Register(ctx context.Context, req *amv1.RegisterRequest, cl Client) (token string, u *store.User, err error) {
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
		u.IsSiteAdmin = inv.MakesAdmin
		if err := q.CreateUser(ctx, u); err != nil {
			if store.IsUniqueViolation(err) {
				return apperr.ErrUsernameTaken
			}
			return err
		}
		if err := q.MarkInviteUsed(ctx, code, u.ID, now); err != nil {
			return err
		}
		// Every new account gets its invite codes right away.
		_, err = s.topUpInvites(ctx, q, u.ID, 0)
		return err
	})
	if err != nil {
		return "", nil, err
	}
	if s.onRegistered != nil {
		s.onRegistered(ctx, u)
	}
	token, err = s.newSession(ctx, u, req.GetDeviceName(), "register", cl.IP)
	if err != nil {
		return "", nil, err
	}
	return token, u, nil
}

func (s *Service) Login(ctx context.Context, req *amv1.LoginRequest, cl Client) (string, *store.User, error) {
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
	kind := "login"
	if u.LeftAt != 0 {
		if err := s.rejoin(ctx, u, req.GetInviteCode()); err != nil {
			return "", nil, err
		}
		kind = "rejoin"
	}
	token, err := s.newSession(ctx, u, req.GetDeviceName(), kind, cl.IP)
	if err != nil {
		return "", nil, err
	}
	return token, u, nil
}

// rejoin brings back an account that left the server; it costs an unused
// invite code, like registering.
func (s *Service) rejoin(ctx context.Context, u *store.User, code string) error {
	code = strings.ToUpper(strings.TrimSpace(code))
	if code == "" {
		return apperr.ErrLeftServer
	}
	err := s.st.InTx(ctx, func(q *store.Queries) error {
		if _, err := q.LockUnusedInvite(ctx, code); errors.Is(err, store.ErrNotFound) {
			return apperr.ErrInvalidInvite
		} else if err != nil {
			return err
		}
		if err := q.MarkInviteUsed(ctx, code, u.ID, s.now().UnixMilli()); err != nil {
			return err
		}
		return q.SetLeft(ctx, u.ID, 0)
	})
	if err != nil {
		return err
	}
	u.LeftAt = 0
	if s.onRegistered != nil {
		s.onRegistered(ctx, u) // back into the public channels
	}
	return nil
}

// Leave takes the user off the server: logged out everywhere, out of every
// channel (owned channels pass to the next member, or are dissolved when
// nobody is left), hidden from the member list. The account and its
// messages stay; coming back needs a new invite code (see Login).
func (s *Service) Leave(ctx context.Context, u *store.User) error {
	var closed []int64
	err := s.st.InTx(ctx, func(q *store.Queries) error {
		if err := q.SetLeft(ctx, u.ID, s.now().UnixMilli()); err != nil {
			return err
		}
		if err := q.DeleteUserPairTickets(ctx, u.ID); err != nil {
			return err
		}
		if err := q.DeleteClientState(ctx, u.ID); err != nil {
			return err
		}
		var err error
		closed, err = q.DeleteUserSessions(ctx, u.ID)
		return err
	})
	if err != nil {
		return err
	}
	if s.onLeft != nil {
		s.onLeft(ctx, u)
	}
	for _, id := range closed {
		s.push.CloseSession(id)
	}
	return nil
}

// dummyHash is a valid hash of a random password, used for timing equalisation.
var dummyHash, _ = HashPassword("not-a-real-password-just-timing")

// newSession creates a device session and writes a login record.
func (s *Service) newSession(ctx context.Context, u *store.User, device, kind, ip string) (token string, err error) {
	err = s.st.InTx(ctx, func(q *store.Queries) error {
		token, err = s.createSession(ctx, q, u, device, kind, ip)
		return err
	})
	if err != nil {
		return "", err
	}
	_ = s.st.MarkDay(ctx, u.ID, DayKey(s.now()))
	return token, nil
}

// createSession is newSession inside a transaction. A human account already
// on limits.max_devices devices gets too_many_devices.
func (s *Service) createSession(ctx context.Context, q *store.Queries, u *store.User, device, kind, ip string) (string, error) {
	if err := s.checkDevices(ctx, q, u); err != nil {
		return "", err
	}
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
	sess := &store.Session{ID: s.ids.Next(), UserID: u.ID, DeviceName: device, CreatedAt: now, LastSeen: now}
	if err := q.CreateSession(ctx, sess, hashToken(token)); err != nil {
		return "", err
	}
	err := q.AddLoginRecord(ctx, &store.LoginRecord{
		ID: s.ids.Next(), UserID: u.ID, SessionID: sess.ID, Kind: kind, IP: ip, DeviceName: device, CreatedAt: now,
	})
	return token, err
}

// checkDevices refuses one more device when the account is full. Bot / AI
// accounts are not limited.
func (s *Service) checkDevices(ctx context.Context, q *store.Queries, u *store.User) error {
	if s.maxDevices <= 0 || u.AccountType != int16(amv1.AccountType_ACCOUNT_TYPE_HUMAN) {
		return nil
	}
	n, err := q.CountSessions(ctx, u.ID)
	if err != nil {
		return err
	}
	if n >= s.maxDevices {
		return apperr.ErrTooManyDevices
	}
	return nil
}

// ListLoginRecords returns the user's recent logins (newest first).
func (s *Service) ListLoginRecords(ctx context.Context, userID int64) (*amv1.ListLoginRecordsResponse, error) {
	list, err := s.st.ListLoginRecords(ctx, userID, 50)
	if err != nil {
		return nil, err
	}
	out := &amv1.ListLoginRecordsResponse{}
	for _, r := range list {
		out.Records = append(out.Records, &amv1.LoginRecord{Kind: r.Kind, Ip: r.IP, DeviceName: r.DeviceName, CreatedAt: r.CreatedAt})
	}
	return out, nil
}

// maxBio is the longest profile signature, in characters.
const maxBio = 100

// UpdateProfile changes display name, avatar (an uploaded image, GIF allowed)
// and/or signature.
func (s *Service) UpdateProfile(ctx context.Context, u *store.User, req *amv1.UpdateProfileRequest) (*store.User, error) {
	return s.updateProfile(ctx, u, u.ID, req)
}

// updateProfile changes u's profile; a new avatar must be an image uploaded
// by `uploader` (u itself, or the owner of an AI account).
func (s *Service) updateProfile(ctx context.Context, u *store.User, uploader int64, req *amv1.UpdateProfileRequest) (*store.User, error) {
	display := ""
	if req.DisplayName != nil {
		display = strings.TrimSpace(req.GetDisplayName())
		if n := utf8.RuneCountInString(display); n < 1 || n > 32 {
			return nil, apperr.ErrInvalidName
		}
	}
	var bio *string
	if req.Bio != nil {
		b := strings.TrimSpace(req.GetBio())
		if utf8.RuneCountInString(b) > maxBio {
			return nil, apperr.ErrBioTooLong
		}
		bio = &b
	}
	avatar := int64(-1) // keep
	if req.AvatarMediaId != nil {
		avatar = req.GetAvatarMediaId()
		if avatar != 0 {
			if _, err := s.media.OwnUpload(ctx, uploader, avatar, true); err != nil {
				return nil, err
			}
		}
	}
	if err := s.st.UpdateProfile(ctx, u.ID, display, avatar, ""); err != nil {
		return nil, err
	}
	if bio != nil {
		if err := s.st.SetBio(ctx, u.ID, *bio); err != nil {
			return nil, err
		}
	}
	return s.st.GetUser(ctx, u.ID)
}

// DayKey is a date as yyyymmdd in the server's local time zone.
func DayKey(t time.Time) int {
	y, m, d := t.Local().Date()
	return y*10000 + int(m)*100 + d
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
	if u.LeftAt != 0 {
		return nil, nil, apperr.ErrUnauthorized
	}
	// An AI / bot stops when its owner is banned or left.
	if u.OwnerID != 0 {
		owner, err := s.st.GetUser(ctx, u.OwnerID)
		if err != nil || owner.Gone() {
			return nil, nil, apperr.ErrUnauthorized
		}
	}
	now := s.now()
	if now.Sub(time.UnixMilli(sess.LastSeen)) > touchInterval {
		_ = s.st.TouchSession(ctx, sess.ID, now.UnixMilli())
		_ = s.st.MarkDay(ctx, u.ID, DayKey(now)) // "days in a row" statistic
	}
	return sess, u, nil
}

func (s *Service) ListSessions(ctx context.Context, userID, currentID int64) (*amv1.ListSessionsResponse, error) {
	list, err := s.st.ListSessions(ctx, userID)
	if err != nil {
		return nil, err
	}
	out := &amv1.ListSessionsResponse{MaxDevices: int32(s.maxDevices)}
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

// topUpInvites creates codes until the user has created invites.per_user in
// total (have = how many they already created). Returns how many it made.
func (s *Service) topUpInvites(ctx context.Context, q *store.Queries, userID int64, have int) (int, error) {
	made := 0
	for ; have+made < s.invites.PerUser; made++ {
		if err := q.CreateInvite(ctx, &store.Invite{Code: newInviteCode(), CreatedBy: userID, CreatedAt: s.now().UnixMilli()}); err != nil {
			return made, err
		}
	}
	return made, nil
}

// ListInvites returns the user's codes with join codes filled in. Accounts
// made before automatic invites (or after per_user was raised) are topped up.
func (s *Service) ListInvites(ctx context.Context, u *store.User) (*amv1.ListInvitesResponse, error) {
	var list []*store.Invite
	err := s.st.InTx(ctx, func(q *store.Queries) error {
		n, err := q.CountInvitesBy(ctx, u.ID)
		if err != nil {
			return err
		}
		if _, err := s.topUpInvites(ctx, q, u.ID, n); err != nil {
			return err
		}
		list, err = q.ListInvitesBy(ctx, u.ID)
		return err
	})
	if err != nil {
		return nil, err
	}
	out := &amv1.ListInvitesResponse{Remaining: int32(s.remainingInvites(u, len(list)))}
	for _, inv := range list {
		pi := &amv1.Invite{Code: inv.Code, CreatedAt: inv.CreatedAt, UsedBy: inv.UsedBy, UsedByName: inv.UsedByName}
		if inv.UsedBy == 0 {
			pi.JoinCode, pi.JoinUrl = s.JoinCode(inv.Code)
		}
		out.Invites = append(out.Invites, pi)
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
		return q.CreateInvite(ctx, &store.Invite{Code: code, CreatedBy: u.ID, CreatedAt: s.now().UnixMilli()})
	})
	if err != nil {
		return nil, err
	}
	inv := &amv1.Invite{Code: code, CreatedAt: s.now().UnixMilli()}
	inv.JoinCode, inv.JoinUrl = s.JoinCode(code)
	return inv, nil
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
	return code, s.st.CreateInvite(ctx, &store.Invite{Code: code, MakesAdmin: true, Note: "bootstrap", CreatedAt: s.now().UnixMilli()})
}

// Invite codes: 10 characters from an alphabet without look-alike letters
// (the same alphabet join codes use, so they can be packed into them).
const inviteAlphabet = connectcode.Alphabet

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
