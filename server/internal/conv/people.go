package conv

import (
	"context"
	"errors"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/apperr"
	"github.com/OzakiJUN/am/server/internal/store"
)

const (
	defaultUserPage = 50
	maxUserPage     = 200
)

// ListUsers pages through everyone on the server (the "members" list used to
// start a DM). query matches username or display name.
func (s *Service) ListUsers(ctx context.Context, query string, after int64, limit int) (*amv1.ListUsersResponse, error) {
	if limit <= 0 {
		limit = defaultUserPage
	}
	limit = min(limit, maxUserPage)
	rows, err := s.st.ListUsers(ctx, query, after, limit+1)
	if err != nil {
		return nil, err
	}
	out := &amv1.ListUsersResponse{}
	if len(rows) > limit {
		rows = rows[:limit]
		out.NextAfter = rows[limit-1].ID
	}
	ids := make([]int64, len(rows))
	for i, u := range rows {
		ids[i] = u.ID
	}
	users, err := s.usersView(ctx, ids)
	if err != nil {
		return nil, err
	}
	for _, id := range ids {
		if u := users[id]; u != nil {
			out.Users = append(out.Users, u)
		}
	}
	return out, nil
}

// Block stops direct messages between me and target (both ways).
func (s *Service) Block(ctx context.Context, me *store.User, target int64) error {
	if target == me.ID {
		return apperr.ErrSelf
	}
	if _, err := s.st.GetUser(ctx, target); errors.Is(err, store.ErrNotFound) {
		return apperr.ErrUserNotFound
	} else if err != nil {
		return err
	}
	return s.st.AddBlock(ctx, me.ID, target, s.now().UnixMilli())
}

func (s *Service) Unblock(ctx context.Context, me *store.User, target int64) error {
	return s.st.RemoveBlock(ctx, me.ID, target)
}

// ListBlocks returns the people me has blocked, newest first.
func (s *Service) ListBlocks(ctx context.Context, me *store.User) (*amv1.ListBlocksResponse, error) {
	ids, err := s.st.BlockedIDs(ctx, me.ID)
	if err != nil {
		return nil, err
	}
	users, err := s.usersView(ctx, ids)
	if err != nil {
		return nil, err
	}
	out := &amv1.ListBlocksResponse{}
	for _, id := range ids {
		if u := users[id]; u != nil {
			out.Users = append(out.Users, u)
		}
	}
	return out, nil
}
