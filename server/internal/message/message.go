// Package message handles sending events, striking, syncing and read positions.
package message

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"google.golang.org/protobuf/proto"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/apperr"
	"github.com/OzakiJUN/am/server/internal/config"
	"github.com/OzakiJUN/am/server/internal/idgen"
	"github.com/OzakiJUN/am/server/internal/push"
	"github.com/OzakiJUN/am/server/internal/store"
)

// Body kinds stored in events.body_kind = proto field number of Event.body.
const (
	KindText        int16 = 10
	KindImage       int16 = 11
	KindFile        int16 = 12
	KindStrike      int16 = 20
	KindAdminDelete int16 = 21
	KindSysMember   int16 = 30
	KindSysConv     int16 = 31
)

const maxClientMsgIDLen = 64

type Service struct {
	st     *store.Store
	ids    *idgen.Generator
	push   push.Pusher
	limits config.Limits
	now    func() time.Time
}

func New(st *store.Store, ids *idgen.Generator, p push.Pusher, limits config.Limits) *Service {
	return &Service{st: st, ids: ids, push: p, limits: limits, now: time.Now}
}

// Send validates and appends an event, then pushes it to all members.
// connID is the sender's connection, which gets the event in the response
// instead of a push.
func (s *Service) Send(ctx context.Context, me *store.User, req *amv1.SendRequest, connID uint64) (*amv1.Event, error) {
	cid := strings.TrimSpace(req.GetClientMsgId())
	if cid == "" {
		return nil, apperr.ErrMissingClientID
	}
	if len(cid) > maxClientMsgIDLen {
		return nil, apperr.ErrBadRequest
	}

	// Resend of something already stored: return the original.
	if old, err := s.st.GetEventByClientMsgID(ctx, me.ID, cid); err == nil {
		return toProto(old, me.ID)
	} else if !errors.Is(err, store.ErrNotFound) {
		return nil, err
	}

	conv, err := s.st.GetConvForUser(ctx, req.GetConvId(), me.ID)
	if errors.Is(err, store.ErrNotFound) {
		return nil, apperr.ErrNotMember
	}
	if err != nil {
		return nil, err
	}
	now := s.now().UnixMilli()
	if conv.Self.MutedUntil > now {
		return nil, apperr.ErrMuted
	}

	body := &amv1.Event{}
	var kind int16
	var target int64
	switch b := req.GetBody().(type) {
	case *amv1.SendRequest_Text:
		text := strings.TrimRight(b.Text.GetText(), " \t\r\n")
		if strings.TrimSpace(text) == "" {
			return nil, apperr.ErrEmptyMessage
		}
		if utf8.RuneCountInString(text) > s.limits.MaxTextLength {
			return nil, apperr.ErrTooLong
		}
		b.Text.Text = text
		body.Body = &amv1.Event_Text{Text: b.Text}
		kind = KindText
	case *amv1.SendRequest_Strike:
		target = b.Strike.GetTargetEventId()
		if err := s.checkStrike(ctx, me.ID, conv.ID, target); err != nil {
			return nil, err
		}
		body.Body = &amv1.Event_Strike{Strike: b.Strike}
		kind = KindStrike
	case *amv1.SendRequest_Image, *amv1.SendRequest_File:
		return nil, apperr.ErrNotImplemented // needs media upload (next stage)
	default:
		return nil, apperr.ErrEmptyMessage
	}

	payload, err := proto.Marshal(body)
	if err != nil {
		return nil, err
	}
	row := &store.Event{
		EventID:       s.ids.Next(),
		ConvID:        conv.ID,
		SenderID:      me.ID,
		ClientMsgID:   cid,
		BodyKind:      kind,
		TargetEventID: target,
		Payload:       payload,
		CreatedAt:     now,
	}
	err = s.st.InTx(ctx, func(q *store.Queries) error {
		if kind == KindStrike {
			// Re-check inside the transaction so two strikes cannot race.
			done, err := q.HasEventTargeting(ctx, target, KindStrike)
			if err != nil {
				return err
			}
			if done {
				return apperr.ErrAlreadyStruck
			}
		}
		return q.AppendEvent(ctx, row)
	})
	if store.IsUniqueViolation(err) {
		// Same client_msg_id raced with itself: return the stored one.
		if old, err2 := s.st.GetEventByClientMsgID(ctx, me.ID, cid); err2 == nil {
			return toProto(old, me.ID)
		}
	}
	if err != nil {
		return nil, err
	}

	s.fanOut(ctx, row, connID)
	return toProto(row, me.ID)
}

func (s *Service) checkStrike(ctx context.Context, me, convID, target int64) error {
	ev, err := s.st.GetEvent(ctx, target)
	if errors.Is(err, store.ErrNotFound) || (err == nil && ev.ConvID != convID) {
		return apperr.ErrNotFound
	}
	if err != nil {
		return err
	}
	if ev.SenderID != me {
		return apperr.ErrCannotStrike
	}
	switch ev.BodyKind {
	case KindText, KindImage, KindFile:
	default:
		return apperr.ErrCannotStrike
	}
	if ev.RedactedBy != 0 {
		return apperr.ErrNotFound
	}
	done, err := s.st.HasEventTargeting(ctx, target, KindStrike)
	if err != nil {
		return err
	}
	if done {
		return apperr.ErrAlreadyStruck
	}
	return nil
}

// fanOut pushes a stored event to every member. The sender's own other
// devices get client_msg_id (so they can match it); everyone else does not.
func (s *Service) fanOut(ctx context.Context, row *store.Event, exceptConn uint64) {
	members, err := s.st.MemberIDs(ctx, []int64{row.ConvID})
	if err != nil {
		return
	}
	others := make([]int64, 0, len(members[row.ConvID]))
	for _, uid := range members[row.ConvID] {
		if uid != row.SenderID {
			others = append(others, uid)
		}
	}
	if ev, err := toProto(row, row.SenderID); err == nil {
		s.push.ToUsers([]int64{row.SenderID}, eventFrame(ev), exceptConn)
	}
	if len(others) > 0 {
		if ev, err := toProto(row, 0); err == nil {
			s.push.ToUsers(others, eventFrame(ev), exceptConn)
		}
	}
}

func eventFrame(ev *amv1.Event) *amv1.ServerFrame {
	return &amv1.ServerFrame{Msg: &amv1.ServerFrame_Event{Event: &amv1.EventPush{Event: ev}}}
}

// Sync returns events after each cursor's seq, for conversations the user is in.
func (s *Service) Sync(ctx context.Context, me *store.User, req *amv1.SyncRequest) (*amv1.SyncResponse, error) {
	limit := int(req.GetLimit())
	if limit <= 0 {
		limit = s.limits.SyncPageSize
	}
	if limit > s.limits.SyncMaxPageSize {
		limit = s.limits.SyncMaxPageSize
	}
	out := &amv1.SyncResponse{}
	seen := make(map[int64]bool)
	for _, cur := range req.GetCursors() {
		if seen[cur.GetConvId()] {
			continue
		}
		seen[cur.GetConvId()] = true
		if _, err := s.st.GetConvForUser(ctx, cur.GetConvId(), me.ID); err != nil {
			if errors.Is(err, store.ErrNotFound) {
				continue // not a member: silently skip
			}
			return nil, err
		}
		rows, err := s.st.ListEvents(ctx, cur.GetConvId(), cur.GetAfterSeq(), limit+1)
		if err != nil {
			return nil, err
		}
		if len(rows) > limit {
			rows = rows[:limit]
			out.HasMore = append(out.HasMore, cur.GetConvId())
		}
		for _, r := range rows {
			ev, err := toProto(r, me.ID)
			if err != nil {
				return nil, err
			}
			out.Events = append(out.Events, ev)
		}
	}
	return out, nil
}

func (s *Service) MarkRead(ctx context.Context, me *store.User, req *amv1.MarkReadRequest) error {
	if _, err := s.st.GetConvForUser(ctx, req.GetConvId(), me.ID); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return apperr.ErrNotMember
		}
		return err
	}
	return s.st.SetReadSeq(ctx, req.GetConvId(), me.ID, req.GetSeq())
}

// toProto rebuilds a protocol Event from a row. client_msg_id is only
// included when the viewer is the sender.
func toProto(r *store.Event, viewer int64) (*amv1.Event, error) {
	ev := &amv1.Event{}
	if r.RedactedBy == 0 {
		if err := proto.Unmarshal(r.Payload, ev); err != nil {
			return nil, err
		}
	} else {
		ev.Redaction = &amv1.Redaction{DeletedBy: r.RedactedBy, Reason: r.RedactReason, DeletedAt: r.RedactedAt}
	}
	ev.EventId = r.EventID
	ev.ConvId = r.ConvID
	ev.Seq = r.Seq
	ev.SenderId = r.SenderID
	ev.CreatedAt = r.CreatedAt
	if viewer == r.SenderID {
		ev.ClientMsgId = r.ClientMsgID
	}
	return ev, nil
}
