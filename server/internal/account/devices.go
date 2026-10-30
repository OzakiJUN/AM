package account

import (
	"context"
	"crypto/rand"
	"encoding/base32"
	"errors"
	"strings"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/internal/connectcode"
	"github.com/OzakiJUN/am/server/internal/apperr"
	"github.com/OzakiJUN/am/server/internal/store"
)

// Several devices of one person (docs/design.md §7, 多设备): pairing a new
// device with a one-time ticket, logging out, and the encrypted state my
// devices share (the list of my servers).

// maxOpaque is the largest pairing bundle / device state kept.
const maxOpaque = 32 << 10

// Logout ends the session making the request.
func (s *Service) Logout(ctx context.Context, userID, sessionID int64) error {
	return s.RevokeSession(ctx, userID, sessionID)
}

// MaxDevices is limits.max_devices (0 = no limit).
func (s *Service) MaxDevices() int { return s.maxDevices }

// CreatePairTicket makes a one-time ticket that logs in one more device of
// u. Refused when u is already on the most devices allowed: a code that
// could not be used anyway is not handed out.
func (s *Service) CreatePairTicket(ctx context.Context, u *store.User, bundle []byte) (*amv1.PairTicket, error) {
	if len(bundle) > maxOpaque {
		return nil, apperr.ErrTooLargeData
	}
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return nil, err
	}
	// Same alphabet as join codes: the client packs it into the pairing code.
	ticket := base32.NewEncoding(connectcode.Alphabet).WithPadding(base32.NoPadding).EncodeToString(raw)
	now := s.now()
	t := &store.PairTicket{UserID: u.ID, Bundle: bundle, CreatedAt: now.UnixMilli(), ExpiresAt: now.Add(s.pairTTL).UnixMilli()}
	err := s.st.InTx(ctx, func(q *store.Queries) error {
		if err := s.checkDevices(ctx, q, u); err != nil {
			return err
		}
		return q.ReplacePairTicket(ctx, hashToken(ticket), t)
	})
	if err != nil {
		return nil, err
	}
	return &amv1.PairTicket{Ticket: ticket, ExpiresAt: t.ExpiresAt}, nil
}

// RedeemPairTicket uses up a ticket and logs the new device in.
func (s *Service) RedeemPairTicket(ctx context.Context, req *amv1.RedeemPairTicketRequest, cl Client) (token string, u *store.User, bundle []byte, err error) {
	ticket := strings.ToUpper(strings.TrimSpace(req.GetTicket()))
	if ticket == "" {
		return "", nil, nil, apperr.ErrInvalidPairCode
	}
	err = s.st.InTx(ctx, func(q *store.Queries) error {
		t, err := q.TakePairTicket(ctx, hashToken(ticket), s.now().UnixMilli())
		if errors.Is(err, store.ErrNotFound) {
			return apperr.ErrInvalidPairCode
		}
		if err != nil {
			return err
		}
		if u, err = q.GetUser(ctx, t.UserID); err != nil {
			return err
		}
		switch {
		case u.Banned:
			return apperr.ErrBanned
		case u.LeftAt != 0:
			return apperr.ErrLeftServer
		}
		bundle = t.Bundle
		token, err = s.createSession(ctx, q, u, req.GetDeviceName(), "pair", cl.IP)
		return err
	})
	if err != nil {
		return "", nil, nil, err
	}
	_ = s.st.MarkDay(ctx, u.ID, DayKey(s.now()))
	return token, u, bundle, nil
}

// ClientState returns the encrypted state my devices share.
func (s *Service) ClientState(ctx context.Context, userID int64) (*amv1.ClientState, error) {
	data, at, err := s.st.GetClientState(ctx, userID)
	if err != nil {
		return nil, err
	}
	return &amv1.ClientState{Data: data, UpdatedAt: at}, nil
}

// PutClientState saves it, unless another device saved since the version
// this one was merged from.
func (s *Service) PutClientState(ctx context.Context, userID int64, req *amv1.PutClientStateRequest) (*amv1.ClientState, error) {
	if len(req.GetData()) > maxOpaque {
		return nil, apperr.ErrTooLargeData
	}
	out := &amv1.ClientState{Data: req.GetData()}
	err := s.st.InTx(ctx, func(q *store.Queries) error {
		_, at, err := q.GetClientState(ctx, userID)
		if err != nil {
			return err
		}
		if at != req.GetBaseUpdatedAt() {
			return apperr.ErrStateConflict
		}
		// Strictly increasing, so two saves in the same millisecond still differ.
		out.UpdatedAt = max(s.now().UnixMilli(), at+1)
		return q.PutClientState(ctx, userID, req.GetData(), out.UpdatedAt)
	})
	if err != nil {
		return nil, err
	}
	s.push.ToUsers([]int64{userID}, &amv1.ServerFrame{Msg: &amv1.ServerFrame_ClientState{
		ClientState: &amv1.ClientStatePush{UpdatedAt: out.UpdatedAt},
	}}, 0)
	return out, nil
}
