// Package remote relays "someone else's AI operating my computer" (docs/
// design.md §9): an AI asks a person's devices to run one computer tool and
// gets the answer back. The server keeps nothing; it checks that an AI asks
// a person (not blocked either way), that a person answers an AI, sizes and
// a rate limit. Whether anything runs is decided on the person's device.
// It also relays an owner's requests to the client running their AI
// (Control / ControlResult), so the owner can set it up from anywhere.
package remote

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"sync"
	"time"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/apperr"
	"github.com/OzakiJUN/am/server/internal/push"
	"github.com/OzakiJUN/am/server/internal/store"
	"github.com/OzakiJUN/am/server/internal/view"
)

const (
	maxID     = 64
	maxTool   = 64
	maxArgs   = 16 << 10
	maxText   = 64 << 10
	maxImages = 2
	maxResult = 900 << 10
	perMinute = 30
	// An owner's requests to their AI (a B站 QR login polls every 2 s).
	controlPerMinute = 90
	human     = int16(amv1.AccountType_ACCOUNT_TYPE_HUMAN)
)

var errTooBig = apperr.New(http.StatusRequestEntityTooLarge, "too_long", "too large")

type Service struct {
	st   *store.Store
	push push.Pusher
	mu   sync.Mutex
	seen map[int64][]time.Time
}

func New(st *store.Store, p push.Pusher) *Service {
	return &Service{st: st, push: p, seen: map[int64][]time.Time{}}
}

func (s *Service) allow(id int64, limit int) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	list := slices.DeleteFunc(s.seen[id], func(t time.Time) bool { return now.Sub(t) > time.Minute })
	if len(list) >= limit {
		s.seen[id] = list
		return false
	}
	s.seen[id] = append(list, now)
	return true
}

func (s *Service) blocked(ctx context.Context, a, b int64) (bool, error) {
	for _, p := range [][2]int64{{a, b}, {b, a}} {
		ids, err := s.st.BlockedIDs(ctx, p[0])
		if err != nil {
			return false, err
		}
		if slices.Contains(ids, p[1]) {
			return true, nil
		}
	}
	return false, nil
}

// Request passes an AI's tool request on to the person's devices.
func (s *Service) Request(ctx context.Context, ai *store.User, r *amv1.RemoteToolRequest) error {
	if ai.AccountType == human {
		return apperr.ErrNoPermission
	}
	if r.GetRequestId() == "" || len(r.GetRequestId()) > maxID || r.GetTool() == "" || len(r.GetTool()) > maxTool {
		return apperr.ErrBadRequest
	}
	if len(r.GetArgsJson()) > maxArgs {
		return errTooBig
	}
	to, err := s.st.GetUser(ctx, r.GetToUserId())
	if errors.Is(err, store.ErrNotFound) || (err == nil && (to.Gone() || to.AccountType != human)) {
		return apperr.ErrUserNotFound
	}
	if err != nil {
		return err
	}
	// Blocking the AI or its owner stops it.
	for _, id := range []int64{ai.ID, ai.OwnerID} {
		if id == 0 {
			continue
		}
		if b, err := s.blocked(ctx, id, to.ID); err != nil {
			return err
		} else if b {
			return apperr.ErrBlocked
		}
	}
	if !s.allow(ai.ID, perMinute) {
		return apperr.ErrRateLimited
	}
	owners := map[int64]*store.User{}
	if o, err := s.st.GetUser(ctx, ai.OwnerID); err == nil {
		owners[o.ID] = o
	}
	s.push.ToUsers([]int64{to.ID}, &amv1.ServerFrame{Msg: &amv1.ServerFrame_RemoteTool{RemoteTool: &amv1.RemoteToolPush{
		RequestId: r.GetRequestId(), FromAi: view.User(ai, owners), Tool: r.GetTool(), ArgsJson: r.GetArgsJson(),
	}}}, 0)
	return nil
}

// Result passes a person's answer back to the AI that asked.
func (s *Service) Result(ctx context.Context, me *store.User, r *amv1.RemoteToolResult) error {
	if me.AccountType != human {
		return apperr.ErrNoPermission
	}
	if r.GetRequestId() == "" || len(r.GetRequestId()) > maxID {
		return apperr.ErrBadRequest
	}
	size := len(r.GetText())
	for _, im := range r.GetImages() {
		size += len(im)
	}
	if len(r.GetText()) > maxText || len(r.GetImages()) > maxImages || size > maxResult {
		return errTooBig
	}
	ai, err := s.st.GetUser(ctx, r.GetToAiId())
	if errors.Is(err, store.ErrNotFound) || (err == nil && (ai.Gone() || ai.AccountType == human)) {
		return apperr.ErrUserNotFound
	}
	if err != nil {
		return err
	}
	s.push.ToUsers([]int64{ai.ID}, &amv1.ServerFrame{Msg: &amv1.ServerFrame_RemoteToolResult{RemoteToolResult: &amv1.RemoteToolResultPush{
		RequestId: r.GetRequestId(), FromUserId: me.ID, Ok: r.GetOk(), Text: r.GetText(), Images: r.GetImages(),
	}}}, 0)
	return nil
}

// Control passes an owner's request on to the client that runs their AI
// (their other device, or the server's host client): the Bilibili login of
// its browser, for one. Only the AI's owner may ask.
func (s *Service) Control(ctx context.Context, me *store.User, r *amv1.AIControlRequest) error {
	if me.AccountType != human {
		return apperr.ErrNoPermission
	}
	if r.GetRequestId() == "" || len(r.GetRequestId()) > maxID || r.GetAction() == "" || len(r.GetAction()) > maxTool {
		return apperr.ErrBadRequest
	}
	if len(r.GetArgsJson()) > maxArgs {
		return errTooBig
	}
	ai, err := s.st.GetUser(ctx, r.GetAiId())
	if errors.Is(err, store.ErrNotFound) || (err == nil && (ai.Gone() || ai.AccountType == human)) {
		return apperr.ErrUserNotFound
	}
	if err != nil {
		return err
	}
	if ai.OwnerID != me.ID {
		return apperr.ErrNoPermission
	}
	if !s.allow(me.ID, controlPerMinute) {
		return apperr.ErrRateLimited
	}
	s.push.ToUsers([]int64{ai.ID}, &amv1.ServerFrame{Msg: &amv1.ServerFrame_AiControl{AiControl: &amv1.AIControlPush{
		RequestId: r.GetRequestId(), FromUserId: me.ID, Action: r.GetAction(), ArgsJson: r.GetArgsJson(),
	}}}, 0)
	return nil
}

// ControlResult passes the AI's client's answer back to its owner.
func (s *Service) ControlResult(ctx context.Context, me *store.User, r *amv1.AIControlResult) error {
	if me.AccountType == human || me.OwnerID == 0 {
		return apperr.ErrNoPermission
	}
	if r.GetRequestId() == "" || len(r.GetRequestId()) > maxID {
		return apperr.ErrBadRequest
	}
	if len(r.GetText()) > maxText {
		return errTooBig
	}
	s.push.ToUsers([]int64{me.OwnerID}, &amv1.ServerFrame{Msg: &amv1.ServerFrame_AiControlResult{AiControlResult: &amv1.AIControlResultPush{
		RequestId: r.GetRequestId(), AiId: me.ID, Ok: r.GetOk(), Text: r.GetText(),
	}}}, 0)
	return nil
}
