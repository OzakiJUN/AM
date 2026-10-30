// Package conv handles conversations (DMs and channels), members, the
// people directory and blocks. There are no friends: everyone on a server
// can message everyone else (Discord-style).
//
//	conv.go      service, conversation views, DMs
//	people.go    people directory, blocks
//	channels.go  public channels: browse, join, new accounts
//	groups.go    channel (group) creation and management
package conv

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/apperr"
	"github.com/OzakiJUN/am/server/internal/config"
	"github.com/OzakiJUN/am/server/internal/idgen"
	"github.com/OzakiJUN/am/server/internal/media"
	"github.com/OzakiJUN/am/server/internal/message"
	"github.com/OzakiJUN/am/server/internal/push"
	"github.com/OzakiJUN/am/server/internal/store"
	"github.com/OzakiJUN/am/server/internal/view"
)

type Service struct {
	st     *store.Store
	ids    *idgen.Generator
	push   push.Pusher
	msg    *message.Service
	media  *media.Service
	limits config.Limits
	// Name of the public channel created for the first admin ("" = none).
	defaultChannel string
	log            *slog.Logger
	now            func() time.Time
}

func New(st *store.Store, ids *idgen.Generator, p push.Pusher, ms *message.Service, md *media.Service,
	limits config.Limits, defaultChannel string, log *slog.Logger) *Service {
	return &Service{st: st, ids: ids, push: p, msg: ms, media: md, limits: limits,
		defaultChannel: defaultChannel, log: log, now: time.Now}
}

// usersView loads users and their bot owners and converts them to protocol users.
func (s *Service) usersView(ctx context.Context, ids []int64) (map[int64]*amv1.User, error) {
	users, err := s.st.GetUsers(ctx, ids)
	if err != nil {
		return nil, err
	}
	var ownerIDs []int64
	for _, u := range users {
		if u.OwnerID != 0 {
			ownerIDs = append(ownerIDs, u.OwnerID)
		}
	}
	owners, err := s.st.GetUsers(ctx, ownerIDs)
	if err != nil {
		return nil, err
	}
	out := make(map[int64]*amv1.User, len(users))
	for id, u := range users {
		out[id] = view.User(u, owners)
	}
	return out, nil
}

// UserView returns one user as a protocol message.
func (s *Service) UserView(ctx context.Context, u *store.User) (*amv1.User, error) {
	m, err := s.usersView(ctx, []int64{u.ID})
	if err != nil {
		return nil, err
	}
	return m[u.ID], nil
}

// UserViewByID loads and converts one user.
func (s *Service) UserViewByID(ctx context.Context, id int64) (*amv1.User, error) {
	m, err := s.usersView(ctx, []int64{id})
	if err != nil {
		return nil, err
	}
	if m[id] == nil {
		return nil, apperr.ErrUserNotFound
	}
	return m[id], nil
}

// ---- conversation views ----

// ConvView returns one conversation as seen by viewer (who must be a member).
func (s *Service) ConvView(ctx context.Context, convID, viewer int64) (*amv1.Conversation, error) {
	c, err := s.st.GetConvForUser(ctx, convID, viewer)
	if errors.Is(err, store.ErrNotFound) {
		return nil, apperr.ErrNotMember
	}
	if err != nil {
		return nil, err
	}
	list, err := s.withMembers(ctx, []*store.ConvWithSelf{c})
	if err != nil {
		return nil, err
	}
	return list[0], nil
}

// ListConversations returns every conversation the user is in.
func (s *Service) ListConversations(ctx context.Context, userID int64) ([]*amv1.Conversation, error) {
	rows, err := s.st.ListConvsForUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	return s.withMembers(ctx, rows)
}

func (s *Service) withMembers(ctx context.Context, rows []*store.ConvWithSelf) ([]*amv1.Conversation, error) {
	convIDs := make([]int64, len(rows))
	for i, c := range rows {
		convIDs[i] = c.ID
	}
	roles, err := s.st.MemberRoles(ctx, convIDs)
	if err != nil {
		return nil, err
	}
	var allIDs []int64
	for _, list := range roles {
		for _, m := range list {
			allIDs = append(allIDs, m.UserID)
		}
	}
	users, err := s.usersView(ctx, allIDs)
	if err != nil {
		return nil, err
	}
	out := make([]*amv1.Conversation, len(rows))
	for i, c := range rows {
		var members []*amv1.User
		var memberRoles []amv1.MemberRole
		for _, m := range roles[c.ID] {
			if u := users[m.UserID]; u != nil {
				members = append(members, u)
				memberRoles = append(memberRoles, amv1.MemberRole(m.Role))
			}
		}
		out[i] = view.Conversation(c, members, memberRoles)
	}
	return out, nil
}

// pushConv sends each user their own view of a conversation.
func (s *Service) pushConv(ctx context.Context, convID int64, userIDs []int64) {
	for _, uid := range userIDs {
		if c, err := s.ConvView(ctx, convID, uid); err == nil {
			s.push.ToUsers([]int64{uid}, &amv1.ServerFrame{Msg: &amv1.ServerFrame_Conv{Conv: &amv1.ConvPush{Conversation: c}}}, 0)
		}
	}
}

// ---- DMs ----

// OpenDM returns the DM with anyone on the server, creating it on first use.
func (s *Service) OpenDM(ctx context.Context, me *store.User, peerID int64) (*amv1.Conversation, error) {
	if peerID == me.ID {
		return nil, apperr.ErrSelf
	}
	peer, err := s.st.GetUser(ctx, peerID)
	if errors.Is(err, store.ErrNotFound) || (err == nil && peer.Gone()) {
		return nil, apperr.ErrUserNotFound
	}
	if err != nil {
		return nil, err
	}
	blocked, err := s.st.BlockedEither(ctx, me.ID, peerID)
	if err != nil {
		return nil, err
	}
	if blocked {
		return nil, apperr.ErrBlocked
	}
	a, b := me.ID, peerID
	if a > b {
		a, b = b, a
	}
	key := fmt.Sprintf("%d:%d", a, b)

	created := false
	convID, err := s.st.GetConvIDByDMKey(ctx, key)
	if errors.Is(err, store.ErrNotFound) {
		now := s.now().UnixMilli()
		newID := s.ids.Next()
		err = s.st.InTx(ctx, func(q *store.Queries) error {
			c := &store.Conversation{ID: newID, Kind: int16(amv1.ConvKind_CONV_KIND_DM), CreatedAt: now}
			if err := q.CreateConversation(ctx, c, key); err != nil {
				return err
			}
			for _, uid := range []int64{a, b} {
				if err := q.AddMember(ctx, &store.Member{ConvID: newID, UserID: uid,
					Role: int16(amv1.MemberRole_MEMBER_ROLE_MEMBER), JoinedAt: now}); err != nil {
					return err
				}
			}
			return nil
		})
		switch {
		case err == nil:
			convID, created = newID, true
		case store.IsUniqueViolation(err):
			// The other side opened it at the same moment.
			convID, err = s.st.GetConvIDByDMKey(ctx, key)
		}
	}
	if err != nil {
		return nil, err
	}
	conv, err := s.ConvView(ctx, convID, me.ID)
	if err != nil {
		return nil, err
	}
	if created {
		s.pushConv(ctx, convID, []int64{me.ID, peerID})
	}
	return conv, nil
}
