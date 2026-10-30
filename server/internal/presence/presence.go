// Package presence tracks who is online and what they say they are doing,
// and tells everyone on the server when that changes.
//
// Invisible users are reported offline to everyone except themselves and
// the bot / ai accounts they own: their AI knows they are around (and may
// give it away), which is intended.
package presence

import (
	"context"
	"strings"
	"sync"
	"unicode/utf8"

	"google.golang.org/protobuf/proto"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/apperr"
	"github.com/OzakiJUN/am/server/internal/push"
	"github.com/OzakiJUN/am/server/internal/store"
)

// maxActivityText is the longest activity detail, in characters.
const maxActivityText = 32

// state of one online user.
type state struct {
	conns     int
	ownerID   int64
	invisible bool
	activity  *amv1.Activity // nil = none
}

type Service struct {
	st   *store.Store
	push push.Pusher

	// mu also orders pushes: every presence push is sent while holding it,
	// and connections become visible to pushes (attach) under it too, so a
	// client never misses a change between its snapshot and its first push.
	mu     sync.Mutex
	online map[int64]*state
}

func New(st *store.Store, p push.Pusher) *Service {
	return &Service{st: st, push: p, online: make(map[int64]*state)}
}

func activityOf(kind int16, text string) *amv1.Activity {
	if kind == 0 {
		return nil
	}
	return &amv1.Activity{Kind: amv1.ActivityKind(kind), Text: text}
}

// Connect registers a new connection of u. attach runs under the presence
// lock with everyone online as u sees them; it must make the connection
// visible to pushes.
func (s *Service) Connect(u *store.User, attach func(snapshot []*amv1.Presence)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.online[u.ID]
	if st == nil {
		st = &state{ownerID: u.OwnerID, invisible: u.Invisible, activity: activityOf(u.ActivityKind, u.ActivityText)}
		s.online[u.ID] = st
	}
	st.conns++
	if st.conns == 1 {
		s.broadcast(u.ID, nil, st)
	}
	var snap []*amv1.Presence
	for id, o := range s.online {
		if p := s.view(id, o, u.ID, u.OwnerID); p.Online {
			snap = append(snap, p)
		}
	}
	attach(snap)
}

// Disconnect unregisters a connection of userID. detach runs under the
// presence lock and must stop pushes to the connection.
func (s *Service) Disconnect(userID int64, detach func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	detach()
	st := s.online[userID]
	if st == nil {
		return
	}
	if st.conns > 1 {
		st.conns--
		return
	}
	old := *st
	delete(s.online, userID)
	s.broadcast(userID, &old, nil)
}

// Set saves u's invisible flag and activity and tells everyone who sees a
// difference. Returns the presence as u sees it.
func (s *Service) Set(ctx context.Context, u *store.User, req *amv1.SetPresenceRequest) (*amv1.Presence, error) {
	kind := req.GetActivity().GetKind()
	text := strings.TrimSpace(req.GetActivity().GetText())
	if _, known := amv1.ActivityKind_name[int32(kind)]; !known || utf8.RuneCountInString(text) > maxActivityText ||
		(kind == amv1.ActivityKind_ACTIVITY_KIND_CUSTOM && text == "") {
		return nil, apperr.ErrInvalidActivity
	}
	if kind == amv1.ActivityKind_ACTIVITY_KIND_UNSPECIFIED {
		text = ""
	}
	if err := s.st.SetPresence(ctx, u.ID, req.GetInvisible(), int16(kind), text); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	act := activityOf(int16(kind), text)
	st := s.online[u.ID]
	if st == nil {
		return &amv1.Presence{UserId: u.ID, Invisible: req.GetInvisible(), Activity: act}, nil
	}
	old := *st
	st.invisible, st.activity = req.GetInvisible(), act
	s.broadcast(u.ID, &old, st)
	return s.view(u.ID, st, u.ID, 0), nil
}

// view is user id's presence (st nil = offline) as viewer sees it.
func (s *Service) view(id int64, st *state, viewer, viewerOwner int64) *amv1.Presence {
	p := &amv1.Presence{UserId: id}
	if st == nil || st.conns == 0 {
		return p
	}
	own := viewer == id || viewerOwner == id
	if st.invisible && !own {
		return p
	}
	p.Online, p.Activity = true, st.activity
	if own {
		p.Invisible = st.invisible
	}
	return p
}

// broadcast pushes id's change from old to cur (nil = offline) to every
// online user whose view of it changed. Must hold mu.
func (s *Service) broadcast(id int64, old, cur *state) {
	// Two kinds of viewers: id itself and its own bots / AIs see through
	// invisibility; everyone else does not.
	var own, others []int64
	for v, st := range s.online {
		if v == id || st.ownerID == id {
			own = append(own, v)
		} else {
			others = append(others, v)
		}
	}
	send := func(viewers []int64, viewer, viewerOwner int64) {
		if len(viewers) == 0 {
			return
		}
		was, now := s.view(id, old, viewer, viewerOwner), s.view(id, cur, viewer, viewerOwner)
		if proto.Equal(was, now) {
			return
		}
		s.push.ToUsers(viewers, &amv1.ServerFrame{Msg: &amv1.ServerFrame_Presence{Presence: &amv1.PresencePush{Presence: now}}}, 0)
	}
	send(own, id, 0)
	send(others, 0, 0)
}
