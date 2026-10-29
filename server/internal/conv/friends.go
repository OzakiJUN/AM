package conv

import (
	"context"
	"errors"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/apperr"
	"github.com/OzakiJUN/am/server/internal/store"
)

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
	if err := s.st.InsertFriendRequest(ctx, me.ID, target.ID, s.now().UnixMilli()); err != nil {
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
	users, err := s.usersView(ctx, ids)
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
