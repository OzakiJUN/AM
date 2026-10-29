// Package message handles sending events, striking, admin deletion,
// syncing and read positions. Other modules append system events through
// AppendSystem / FanOut so every event goes through one place.
package message

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"google.golang.org/protobuf/proto"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/apperr"
	"github.com/OzakiJUN/am/server/internal/config"
	"github.com/OzakiJUN/am/server/internal/idgen"
	"github.com/OzakiJUN/am/server/internal/media"
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

var (
	ErrAlreadyDeleted = apperr.New(http.StatusConflict, "already_deleted", "message is already deleted")
	ErrReasonRequired = apperr.New(http.StatusBadRequest, "reason_required", "a reason is required")
)

type Service struct {
	st        *store.Store
	ids       *idgen.Generator
	push      push.Pusher
	media     *media.Service
	limits    config.Limits
	retention config.Retention
	now       func() time.Time
}

func New(st *store.Store, ids *idgen.Generator, p push.Pusher, ms *media.Service, limits config.Limits, retention config.Retention) *Service {
	return &Service{st: st, ids: ids, push: p, media: ms, limits: limits, retention: retention, now: time.Now}
}

// Send validates and appends a user event, then pushes it to all members.
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
		return ToProto(old, me.ID)
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
	var target, mediaID int64
	switch b := req.GetBody().(type) {
	case *amv1.SendRequest_Text:
		text := strings.TrimRight(b.Text.GetText(), " \t\r\n")
		if strings.TrimSpace(text) == "" {
			return nil, apperr.ErrEmptyMessage
		}
		if utf8.RuneCountInString(text) > s.limits.MaxTextLength {
			return nil, apperr.ErrTooLong
		}
		body.Body = &amv1.Event_Text{Text: &amv1.TextMsg{Text: text, ReplyTo: b.Text.GetReplyTo(), Mentions: b.Text.GetMentions()}}
		kind = KindText
	case *amv1.SendRequest_Image:
		m, err := s.media.OwnUpload(ctx, me.ID, b.Image.GetMediaId(), true)
		if err != nil {
			return nil, err
		}
		body.Body = &amv1.Event_Image{Image: &amv1.ImageMsg{MediaId: m.ID, Width: int32(m.Width), Height: int32(m.Height)}}
		kind, mediaID = KindImage, m.ID
	case *amv1.SendRequest_File:
		m, err := s.media.OwnUpload(ctx, me.ID, b.File.GetMediaId(), false)
		if err != nil {
			return nil, err
		}
		name := strings.TrimSpace(b.File.GetName())
		if name == "" {
			name = m.Name
		}
		body.Body = &amv1.Event_File{File: &amv1.FileMsg{MediaId: m.ID, Name: name, Size: m.Size}}
		kind, mediaID = KindFile, m.ID
	case *amv1.SendRequest_Strike:
		target = b.Strike.GetTargetEventId()
		if err := s.checkStrike(ctx, me.ID, conv.ID, target); err != nil {
			return nil, err
		}
		body.Body = &amv1.Event_Strike{Strike: &amv1.StrikeAct{TargetEventId: target}}
		kind = KindStrike
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
		MediaID:       mediaID,
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
			return ToProto(old, me.ID)
		}
	}
	if err != nil {
		return nil, err
	}

	s.FanOut(ctx, row, nil, connID)
	return ToProto(row, me.ID)
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
	if !isMessage(ev.BodyKind) {
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

func isMessage(kind int16) bool {
	return kind == KindText || kind == KindImage || kind == KindFile
}

// AppendSystem appends a server-generated event inside the caller's
// transaction. operatorID is recorded as the sender. Call FanOut with the
// returned row after the transaction commits.
func (s *Service) AppendSystem(ctx context.Context, q *store.Queries, convID, operatorID int64, body *amv1.Event) (*store.Event, error) {
	var kind int16
	switch body.GetBody().(type) {
	case *amv1.Event_SysMember:
		kind = KindSysMember
	case *amv1.Event_SysConv:
		kind = KindSysConv
	case *amv1.Event_AdminDelete:
		kind = KindAdminDelete
	default:
		return nil, fmt.Errorf("AppendSystem: unsupported body %T", body.GetBody())
	}
	payload, err := proto.Marshal(&amv1.Event{Body: body.Body})
	if err != nil {
		return nil, err
	}
	row := &store.Event{
		EventID:   s.ids.Next(),
		ConvID:    convID,
		SenderID:  operatorID,
		BodyKind:  kind,
		Payload:   payload,
		CreatedAt: s.now().UnixMilli(),
	}
	if ad := body.GetAdminDelete(); ad != nil {
		row.TargetEventID = ad.GetTargetEventId()
	}
	return row, q.AppendEvent(ctx, row)
}

// FanOut pushes a stored event to every current member plus `extra` users
// (e.g. someone who was just removed and should still see why). The
// sender's own devices get client_msg_id; everyone else does not.
func (s *Service) FanOut(ctx context.Context, row *store.Event, extra []int64, exceptConn uint64) {
	members, err := s.st.MemberIDs(ctx, []int64{row.ConvID})
	if err != nil {
		return
	}
	seen := map[int64]bool{}
	var others []int64
	senderIsRecipient := false
	for _, uid := range append(members[row.ConvID], extra...) {
		if seen[uid] {
			continue
		}
		seen[uid] = true
		if uid == row.SenderID {
			senderIsRecipient = true
			continue
		}
		others = append(others, uid)
	}
	if senderIsRecipient {
		if ev, err := ToProto(row, row.SenderID); err == nil {
			s.push.ToUsers([]int64{row.SenderID}, eventFrame(ev), exceptConn)
		}
	}
	if len(others) > 0 {
		if ev, err := ToProto(row, 0); err == nil {
			s.push.ToUsers(others, eventFrame(ev), exceptConn)
		}
	}
}

func eventFrame(ev *amv1.Event) *amv1.ServerFrame {
	return &amv1.ServerFrame{Msg: &amv1.ServerFrame_Event{Event: &amv1.EventPush{Event: ev}}}
}

// AdminDelete removes a message for everyone. Allowed for site admins, and
// for group owners / admins on messages of members ranked below them.
// The content moves to the evidence store; an admin_delete event records it.
func (s *Service) AdminDelete(ctx context.Context, me *store.User, eventID int64, req *amv1.AdminDeleteRequest) error {
	reason := strings.TrimSpace(req.GetReason())
	if reason == "" {
		return ErrReasonRequired
	}
	if utf8.RuneCountInString(reason) > 200 {
		return apperr.ErrTooLong
	}
	ev, err := s.st.GetEvent(ctx, eventID)
	if errors.Is(err, store.ErrNotFound) {
		return apperr.ErrNotFound
	}
	if err != nil {
		return err
	}
	if !isMessage(ev.BodyKind) {
		return apperr.ErrNotFound
	}
	if ev.RedactedBy != 0 {
		return ErrAlreadyDeleted
	}
	if !me.IsSiteAdmin {
		if err := s.checkGroupModerator(ctx, me.ID, ev); err != nil {
			return err
		}
	}

	now := s.now()
	purgeAfter := now.Add(time.Duration(s.retention.EvidenceDays) * 24 * time.Hour).UnixMilli()
	var row *store.Event
	err = s.st.InTx(ctx, func(q *store.Queries) error {
		if err := q.RedactEvent(ctx, ev, me.ID, reason, now.UnixMilli(), purgeAfter); err != nil {
			if errors.Is(err, store.ErrNotFound) {
				return ErrAlreadyDeleted
			}
			return err
		}
		if req.GetBlockMedia() && ev.MediaID != 0 {
			if err := s.media.Block(ctx, q, ev.MediaID, reason, me.ID); err != nil {
				return err
			}
		}
		var err error
		row, err = s.AppendSystem(ctx, q, ev.ConvID, me.ID, &amv1.Event{Body: &amv1.Event_AdminDelete{
			AdminDelete: &amv1.AdminDeleteAct{TargetEventId: ev.EventID, Reason: reason},
		}})
		if err != nil {
			return err
		}
		return q.AddAudit(ctx, &store.AuditEntry{
			ID: s.ids.Next(), ActorID: me.ID, Action: "admin_delete", ConvID: ev.ConvID, TargetID: ev.EventID,
			Detail:    fmt.Sprintf("sender=%d block_media=%t reason=%s", ev.SenderID, req.GetBlockMedia(), reason),
			CreatedAt: now.UnixMilli(),
		})
	})
	if err != nil {
		return err
	}
	s.FanOut(ctx, row, nil, 0)
	return nil
}

func (s *Service) checkGroupModerator(ctx context.Context, actor int64, ev *store.Event) error {
	conv, err := s.st.GetConvForUser(ctx, ev.ConvID, actor)
	if errors.Is(err, store.ErrNotFound) {
		return apperr.ErrNoPermission
	}
	if err != nil {
		return err
	}
	if conv.Kind != int16(amv1.ConvKind_CONV_KIND_GROUP) || conv.Self.Role < int16(amv1.MemberRole_MEMBER_ROLE_ADMIN) {
		return apperr.ErrNoPermission
	}
	senderRole := int16(amv1.MemberRole_MEMBER_ROLE_MEMBER) // also for people who already left
	if m, err := s.st.GetMember(ctx, ev.ConvID, ev.SenderID); err == nil {
		senderRole = m.Role
	} else if !errors.Is(err, store.ErrNotFound) {
		return err
	}
	if conv.Self.Role <= senderRole {
		return apperr.ErrNoPermission
	}
	return nil
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
			ev, err := ToProto(r, me.ID)
			if err != nil {
				return nil, err
			}
			out.Events = append(out.Events, ev)
		}
	}
	return out, nil
}

func (s *Service) MarkRead(ctx context.Context, me *store.User, req *amv1.MarkReadRequest) error {
	conv, err := s.st.GetConvForUser(ctx, req.GetConvId(), me.ID)
	if errors.Is(err, store.ErrNotFound) {
		return apperr.ErrNotMember
	}
	if err != nil {
		return err
	}
	seq := req.GetSeq()
	if seq > conv.LastSeq {
		seq = conv.LastSeq
	}
	return s.st.SetReadSeq(ctx, conv.ID, me.ID, seq)
}

// ToProto rebuilds a protocol Event from a row. client_msg_id is only
// included when the viewer is the sender. Deleted events carry no body.
func ToProto(r *store.Event, viewer int64) (*amv1.Event, error) {
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
