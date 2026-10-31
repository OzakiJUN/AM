package conv

import (
	"context"
	"errors"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/apperr"
	"github.com/OzakiJUN/am/server/internal/store"
	"github.com/OzakiJUN/am/server/internal/view"
)

// ListChannels returns every public channel for "browse channels".
func (s *Service) ListChannels(ctx context.Context, me *store.User) (*amv1.ListChannelsResponse, error) {
	rows, err := s.st.ListPublicChannels(ctx, me.ID)
	if err != nil {
		return nil, err
	}
	out := &amv1.ListChannelsResponse{}
	for _, c := range rows {
		avatar := c.Avatar
		if c.AvatarMedia != 0 {
			avatar = view.MediaURL(c.AvatarMedia)
		}
		out.Channels = append(out.Channels, &amv1.ChannelInfo{
			Id: c.ID, Name: c.Name, Avatar: avatar, Notice: c.Notice, MemberCount: int32(c.MemberCount), Joined: c.Joined,
		})
	}
	return out, nil
}

// JoinChannel puts me into a public channel (no-op if already in).
func (s *Service) JoinChannel(ctx context.Context, me *store.User, convID int64) (*amv1.Conversation, error) {
	var row *store.Event
	err := s.st.InTx(ctx, func(q *store.Queries) error {
		c, err := q.GetConvForUpdate(ctx, convID)
		if errors.Is(err, store.ErrNotFound) {
			return apperr.ErrNotFound
		}
		if err != nil {
			return err
		}
		if c.Kind != int16(amv1.ConvKind_CONV_KIND_GROUP) || !c.Public || c.Dissolved {
			return apperr.ErrNotPublic
		}
		if _, err := q.GetMember(ctx, convID, me.ID); err == nil {
			return nil // already in
		} else if !errors.Is(err, store.ErrNotFound) {
			return err
		}
		if err := q.AddMember(ctx, &store.Member{ConvID: convID, UserID: me.ID, Role: roleMember, JoinedAt: s.now().UnixMilli()}); err != nil {
			return err
		}
		_ = q.DeleteJoinRequest(ctx, convID, me.ID)
		row, err = s.msg.AppendSystem(ctx, q, convID, me.ID, sysMember(amv1.SysMember_ACTION_JOIN, me.ID, me.ID))
		return err
	})
	if err != nil {
		return nil, err
	}
	if row != nil {
		s.pushConv(ctx, convID, []int64{me.ID})
		s.msg.FanOut(ctx, row, nil, 0)
	}
	return s.ConvView(ctx, convID, me.ID)
}

// LeaveAll takes a user who left the server out of every channel. A channel
// they own passes to the next member (highest role, then longest there); a
// channel with nobody else in it is dissolved. Failures are logged and the
// rest still runs: the account is already marked as left.
func (s *Service) LeaveAll(ctx context.Context, u *store.User) {
	convs, err := s.st.ListConvsForUser(ctx, u.ID)
	if err != nil {
		s.log.Warn("leave: list conversations", "user", u.ID, "err", err)
		return
	}
	for _, c := range convs {
		if c.Kind != int16(amv1.ConvKind_CONV_KIND_GROUP) || c.Dissolved {
			continue
		}
		if c.Self.Role == roleOwner {
			next, err := s.st.NextOwner(ctx, c.ID, u.ID)
			if errors.Is(err, store.ErrNotFound) {
				if err := s.Dissolve(ctx, u, c.ID); err != nil {
					s.log.Warn("leave: dissolve", "user", u.ID, "conv", c.ID, "err", err)
				}
				continue
			}
			if err == nil {
				err = s.Transfer(ctx, u, c.ID, next)
			}
			if err != nil {
				s.log.Warn("leave: transfer", "user", u.ID, "conv", c.ID, "err", err)
				continue
			}
		}
		if err := s.RemoveMember(ctx, u, c.ID, u.ID); err != nil {
			s.log.Warn("leave: remove", "user", u.ID, "conv", c.ID, "err", err)
		}
	}
}

// Welcome runs after an account is created: it joins every public channel.
// The very first admin, on a server without public channels, creates the
// default channel instead (config server.default_channel).
func (s *Service) Welcome(ctx context.Context, u *store.User) {
	ids, err := s.st.PublicChannelIDs(ctx)
	if err != nil {
		s.log.Warn("welcome: list public channels", "user", u.ID, "err", err)
		return
	}
	if len(ids) == 0 && u.IsSiteAdmin && s.defaultChannel != "" {
		if _, err := s.createGroup(ctx, u, s.defaultChannel, nil, true); err != nil {
			s.log.Warn("welcome: create default channel", "name", s.defaultChannel, "err", err)
		}
		return
	}
	for _, id := range ids {
		if _, err := s.JoinChannel(ctx, u, id); err != nil {
			s.log.Warn("welcome: join public channel", "user", u.ID, "conv", id, "err", err)
		}
	}
}
