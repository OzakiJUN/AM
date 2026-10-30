package account

import (
	"context"
	"crypto/rand"
	"errors"
	"strings"
	"unicode/utf8"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/apperr"
	"github.com/OzakiJUN/am/server/internal/store"
)

// Site administration. Used by the server admin panel (actorID 0) and later
// by site admins from the client. Invite codes are not made here: every
// account gets its own automatically (see topUpInvites).

// PanelActor is the audit-log actor id for actions done in the admin panel.
const PanelActor int64 = 0

// DeleteInvite removes an unused invite code (anyone's).
func (s *Service) DeleteInvite(ctx context.Context, actorID int64, code string) error {
	return s.st.InTx(ctx, func(q *store.Queries) error {
		err := q.DeleteUnusedInvite(ctx, strings.ToUpper(strings.TrimSpace(code)))
		if errors.Is(err, store.ErrNotFound) {
			return apperr.ErrNotFound
		}
		if err != nil {
			return err
		}
		return s.audit(ctx, q, actorID, "invite_delete", 0, "code="+code)
	})
}

// SetBanned bans or unbans an account. Banning logs it out on every device
// and closes its live connections at once.
func (s *Service) SetBanned(ctx context.Context, actorID, userID int64, banned bool, reason string) error {
	reason = strings.TrimSpace(reason)
	if banned && reason == "" {
		return apperr.ErrReasonRequired
	}
	if utf8.RuneCountInString(reason) > 200 {
		return apperr.ErrBadRequest
	}
	var closed []int64
	err := s.st.InTx(ctx, func(q *store.Queries) error {
		err := q.SetBanned(ctx, userID, banned, reason, s.now().UnixMilli())
		if errors.Is(err, store.ErrNotFound) {
			return apperr.ErrUserNotFound
		}
		if err != nil {
			return err
		}
		action := "unban"
		if banned {
			action = "ban"
			if closed, err = q.DeleteUserSessions(ctx, userID); err != nil {
				return err
			}
		}
		return s.audit(ctx, q, actorID, action, userID, reason)
	})
	if err != nil {
		return err
	}
	for _, id := range closed {
		s.push.CloseSession(id)
	}
	return nil
}

// SetSiteAdmin grants or removes site admin rights.
func (s *Service) SetSiteAdmin(ctx context.Context, actorID, userID int64, admin bool) error {
	return s.st.InTx(ctx, func(q *store.Queries) error {
		err := q.SetSiteAdmin(ctx, userID, admin)
		if errors.Is(err, store.ErrNotFound) {
			return apperr.ErrUserNotFound
		}
		if err != nil {
			return err
		}
		action := "site_admin_remove"
		if admin {
			action = "site_admin_grant"
		}
		return s.audit(ctx, q, actorID, action, userID, "")
	})
}

// ResetPassword sets a random temporary password, logs the account out
// everywhere and returns the new password to show to the admin once.
func (s *Service) ResetPassword(ctx context.Context, actorID, userID int64) (string, error) {
	u, err := s.st.GetUser(ctx, userID)
	if errors.Is(err, store.ErrNotFound) {
		return "", apperr.ErrUserNotFound
	}
	if err != nil {
		return "", err
	}
	if u.PasswordHash == "" {
		return "", apperr.ErrNoPassword
	}
	pw := newTempPassword()
	hash, err := HashPassword(pw)
	if err != nil {
		return "", err
	}
	var closed []int64
	err = s.st.InTx(ctx, func(q *store.Queries) error {
		if err := q.SetPasswordHash(ctx, userID, hash); err != nil {
			return err
		}
		if closed, err = q.DeleteUserSessions(ctx, userID); err != nil {
			return err
		}
		return s.audit(ctx, q, actorID, "password_reset", userID, "")
	})
	if err != nil {
		return "", err
	}
	for _, id := range closed {
		s.push.CloseSession(id)
	}
	return pw, nil
}

// ChannelHistory returns one page of a channel's events for the server
// admin panel: newest first, seq < before (0 = from the latest). Channels
// only; direct messages read as not found. Opening a channel (the first
// page) is written to the audit log, so reading is never silent.
func (s *Service) ChannelHistory(ctx context.Context, actorID, convID, before int64, limit int) (*store.Conversation, []*store.Event, error) {
	c, err := s.st.GetConv(ctx, convID)
	if errors.Is(err, store.ErrNotFound) || (err == nil && c.Kind != int16(amv1.ConvKind_CONV_KIND_GROUP)) {
		return nil, nil, apperr.ErrNotFound
	}
	if err != nil {
		return nil, nil, err
	}
	if before <= 0 {
		before = c.LastSeq + 1
		if err := s.st.AddAudit(ctx, &store.AuditEntry{ID: s.ids.Next(), ActorID: actorID, Action: "channel_view",
			ConvID: convID, CreatedAt: s.now().UnixMilli()}); err != nil {
			return nil, nil, err
		}
	}
	events, err := s.st.ListEventsBefore(ctx, convID, before, limit)
	if err != nil {
		return nil, nil, err
	}
	return c, events, nil
}

func (s *Service) audit(ctx context.Context, q *store.Queries, actorID int64, action string, targetID int64, detail string) error {
	return q.AddAudit(ctx, &store.AuditEntry{
		ID: s.ids.Next(), ActorID: actorID, Action: action, TargetID: targetID, Detail: detail,
		CreatedAt: s.now().UnixMilli(),
	})
}

// Temporary passwords: 12 characters without look-alikes, easy to read out.
const tempPasswordAlphabet = "abcdefghjkmnpqrstuvwxyz23456789"

func newTempPassword() string {
	// Rejection sampling keeps every character equally likely.
	limit := byte(256 - 256%len(tempPasswordAlphabet))
	out := make([]byte, 0, 12)
	buf := make([]byte, 32)
	for len(out) < 12 {
		if _, err := rand.Read(buf); err != nil {
			panic(err)
		}
		for _, c := range buf {
			if c < limit && len(out) < 12 {
				out = append(out, tempPasswordAlphabet[int(c)%len(tempPasswordAlphabet)])
			}
		}
	}
	return string(out)
}
