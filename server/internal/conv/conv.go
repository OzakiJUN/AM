// Package conv handles friends, conversations and their members.
package conv

import (
	"context"
	"errors"
	"fmt"
	"time"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/apperr"
	"github.com/OzakiJUN/am/server/internal/idgen"
	"github.com/OzakiJUN/am/server/internal/push"
	"github.com/OzakiJUN/am/server/internal/store"
	"github.com/OzakiJUN/am/server/internal/view"
)

type Service struct {
	st   *store.Store
	ids  *idgen.Generator
	push push.Pusher
	now  func() time.Time
}

func New(st *store.Store, ids *idgen.Generator, p push.Pusher) *Service {
	return &Service{st: st, ids: ids, push: p, now: time.Now}
}

// usersView loads users and their bot owners and converts them to protocol users.
func (s *Service) usersView(ctx context.Context, q *store.Queries, ids []int64) (map[int64]*amv1.User, error) {
	users, err := q.GetUsers(ctx, ids)
	if err != nil {
		return nil, err
	}
	var ownerIDs []int64
	for _, u := range users {
		if u.OwnerID != 0 {
			ownerIDs = append(ownerIDs, u.OwnerID)
		}
	}
	owners, err := q.GetUsers(ctx, ownerIDs)
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
	m, err := s.usersView(ctx, s.st.Queries, []int64{u.ID})
	if err != nil {
		return nil, err
	}
	return m[u.ID], nil
}

// ---- friends ----

func (s *Service) RequestFriend(ctx context.Context, me *store.User, username string) error {
	target, err := s.st.GetUserByUsername(ctx, username)
	if errors.Is(err, store.ErrNotFound) {
		return apperr.ErrUserNotFound
	}
	if err != nil {
		return err
	}
	if target.ID == me.ID {
		return apperr.ErrSelf
	}
	now := s.now().UnixMilli()
	f, err := s.st.GetFriendship(ctx, me.ID, target.ID)
	switch {
	case err == nil && f.State == store.FriendAccepted:
		return apperr.ErrAlreadyFriends
	case err == nil && f.Requester == me.ID:
		return nil // already requested; idempotent
	case err == nil:
		// They already asked me: treat my request as accepting theirs.
		return s.AcceptFriend(ctx, me, target.ID)
	case !errors.Is(err, store.ErrNotFound):
		return err
	}
	if err := s.st.InsertFriendRequest(ctx, me.ID, target.ID, now); err != nil {
		if store.IsUniqueViolation(err) {
			return nil // raced with an identical request
		}
		return err
	}
	meView, err := s.UserView(ctx, me)
	if err != nil {
		return err
	}
	s.push.ToUsers([]int64{target.ID}, &amv1.ServerFrame{Msg: &amv1.ServerFrame_Friend{Friend: &amv1.FriendPush{
		Kind: amv1.FriendPush_KIND_REQUEST_RECEIVED, User: meView,
	}}}, 0)
	return nil
}

func (s *Service) AcceptFriend(ctx context.Context, me *store.User, requesterID int64) error {
	err := s.st.AcceptFriendRequest(ctx, requesterID, me.ID, s.now().UnixMilli())
	if errors.Is(err, store.ErrNotFound) {
		return apperr.ErrNoRequest
	}
	if err != nil {
		return err
	}
	meView, err := s.UserView(ctx, me)
	if err != nil {
		return err
	}
	s.push.ToUsers([]int64{requesterID}, &amv1.ServerFrame{Msg: &amv1.ServerFrame_Friend{Friend: &amv1.FriendPush{
		Kind: amv1.FriendPush_KIND_ACCEPTED, User: meView,
	}}}, 0)
	return nil
}

func (s *Service) ListFriends(ctx context.Context, me *store.User) (*amv1.ListFriendsResponse, error) {
	rows, err := s.st.ListFriendships(ctx, me.ID)
	if err != nil {
		return nil, err
	}
	ids := make([]int64, 0, len(rows))
	for _, f := range rows {
		ids = append(ids, other(f, me.ID))
	}
	users, err := s.usersView(ctx, s.st.Queries, ids)
	if err != nil {
		return nil, err
	}
	out := &amv1.ListFriendsResponse{}
	for _, f := range rows {
		u := users[other(f, me.ID)]
		if u == nil {
			continue
		}
		switch {
		case f.State == store.FriendAccepted:
			out.Friends = append(out.Friends, u)
		case f.Addressee == me.ID:
			out.Incoming = append(out.Incoming, u)
		default:
			out.Outgoing = append(out.Outgoing, u)
		}
	}
	return out, nil
}

func other(f *store.Friendship, me int64) int64 {
	if f.Requester == me {
		return f.Addressee
	}
	return f.Requester
}

// ---- conversations ----

// OpenDM returns the DM with a friend, creating it on first use.
func (s *Service) OpenDM(ctx context.Context, me *store.User, peerID int64) (*amv1.Conversation, error) {
	if peerID == me.ID {
		return nil, apperr.ErrSelf
	}
	ok, err := s.st.AreFriends(ctx, me.ID, peerID)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, apperr.ErrNotFriends
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
		peerView, err := s.ConvView(ctx, convID, peerID)
		if err == nil {
			s.push.ToUsers([]int64{peerID}, &amv1.ServerFrame{Msg: &amv1.ServerFrame_Conv{Conv: &amv1.ConvPush{Conversation: peerView}}}, 0)
		}
		s.push.ToUsers([]int64{me.ID}, &amv1.ServerFrame{Msg: &amv1.ServerFrame_Conv{Conv: &amv1.ConvPush{Conversation: conv}}}, 0)
	}
	return conv, nil
}

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
	memberIDs, err := s.st.MemberIDs(ctx, convIDs)
	if err != nil {
		return nil, err
	}
	var allIDs []int64
	for _, ids := range memberIDs {
		allIDs = append(allIDs, ids...)
	}
	users, err := s.usersView(ctx, s.st.Queries, allIDs)
	if err != nil {
		return nil, err
	}
	out := make([]*amv1.Conversation, len(rows))
	for i, c := range rows {
		var members []*amv1.User
		for _, uid := range memberIDs[c.ID] {
			if u := users[uid]; u != nil {
				members = append(members, u)
			}
		}
		out[i] = view.Conversation(c, members)
	}
	return out, nil
}
