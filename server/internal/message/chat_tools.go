package message

import (
	"context"
	"errors"
	"math"
	"path"
	"sort"
	"strings"
	"unicode/utf8"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/apperr"
	"github.com/OzakiJUN/am/server/internal/sticker"
	"github.com/OzakiJUN/am/server/internal/store"
	"google.golang.org/protobuf/proto"
)

func (s *Service) buildForward(ctx context.Context, me *store.User, req *amv1.ForwardRequest) (*amv1.ForwardMsg, map[int64]bool, error) {
	if len(req.GetImportedEntries()) > 0 {
		return s.importForward(ctx, me, req)
	}
	if req.GetSourceServer() != "" {
		return nil, nil, apperr.ErrBadRequest
	}
	if len(req.GetEventIds()) == 0 || len(req.GetEventIds()) > s.limits.MaxForwardMessages {
		return nil, nil, apperr.ErrBadRequest
	}
	source, err := s.st.GetConvForUser(ctx, req.SourceConvId, me.ID)
	if errors.Is(err, store.ErrNotFound) {
		return nil, nil, apperr.ErrNotMember
	}
	if err != nil {
		return nil, nil, err
	}
	name := source.Name
	if source.Kind == int16(amv1.ConvKind_CONV_KIND_DM) {
		peerID, err := s.st.DMPeer(ctx, source.ID, me.ID)
		if err != nil {
			return nil, nil, err
		}
		peer, err := s.st.GetUser(ctx, peerID)
		if err != nil {
			return nil, nil, err
		}
		name = me.DisplayName + " 与 " + peer.DisplayName + " 的私聊"
	}
	var events []*amv1.Event
	seen := map[int64]bool{}
	for _, id := range req.EventIds {
		if seen[id] {
			continue
		}
		seen[id] = true
		ev, err := s.Get(ctx, me, source.ID, id)
		if err != nil {
			return nil, nil, err
		}
		if ev.Redaction != nil {
			return nil, nil, apperr.ErrNotFound
		}
		events = append(events, ev)
	}
	sort.Slice(events, func(i, j int) bool { return events[i].Seq < events[j].Seq })
	struck, err := s.st.StruckTargets(ctx, req.EventIds, KindStrike)
	if err != nil {
		return nil, nil, err
	}
	result := &amv1.ForwardMsg{}
	media := map[int64]bool{}
	for _, ev := range events {
		if f := ev.GetForward(); f != nil {
			for _, entry := range f.Entries {
				result.Entries = append(result.Entries, proto.Clone(entry).(*amv1.ForwardEntry))
			}
			continue
		}
		user, err := s.st.GetUser(ctx, ev.SenderId)
		if err != nil {
			return nil, nil, err
		}
		entry := &amv1.ForwardEntry{SourceConvId: source.ID, SourceName: name, SourceEventId: ev.EventId, SenderId: ev.SenderId, SenderName: user.DisplayName, SentAt: ev.CreatedAt, Struck: struck[ev.EventId]}
		switch b := ev.Body.(type) {
		case *amv1.Event_Text:
			entry.Body = &amv1.ForwardEntry_Text{Text: &amv1.TextMsg{Text: b.Text.Text}}
		case *amv1.Event_Image:
			entry.Body = &amv1.ForwardEntry_Image{Image: proto.Clone(b.Image).(*amv1.ImageMsg)}
		case *amv1.Event_File:
			entry.Body = &amv1.ForwardEntry_File{File: proto.Clone(b.File).(*amv1.FileMsg)}
		default:
			return nil, nil, apperr.ErrBadRequest
		}
		result.Entries = append(result.Entries, entry)
	}
	if len(result.Entries) > s.limits.MaxForwardMessages {
		return nil, nil, apperr.ErrTooLong
	}
	for _, entry := range result.Entries {
		if img := entry.GetImage(); img != nil {
			media[img.MediaId] = true
		}
		if file := entry.GetFile(); file != nil {
			media[file.MediaId] = true
		}
	}
	return result, media, nil
}

func (s *Service) validatePin(ctx context.Context, me *store.User, convID int64, act *amv1.EmojiPinAct) (*amv1.EmojiPinAct, error) {
	if act.GetRemovePinId() != 0 {
		pin, err := s.st.GetMessagePin(ctx, act.RemovePinId)
		if errors.Is(err, store.ErrNotFound) {
			return nil, apperr.ErrNotFound
		}
		if err != nil {
			return nil, err
		}
		if pin.ConvID != convID {
			return nil, apperr.ErrNotFound
		}
		conv, err := s.st.GetConvForUser(ctx, convID, me.ID)
		if err != nil {
			return nil, err
		}
		if pin.UserID != me.ID && !me.IsSiteAdmin && conv.Self.Role < int16(amv1.MemberRole_MEMBER_ROLE_ADMIN) {
			return nil, apperr.ErrNoPermission
		}
		return &amv1.EmojiPinAct{RemovePinId: pin.ID}, nil
	}
	if act.OnBubble && act.GetTargetEventId() == 0 {
		return nil, apperr.ErrBadRequest
	}
	if act.GetTargetEventId() != 0 {
		ev, err := s.Get(ctx, me, convID, act.GetTargetEventId())
		if err != nil {
			return nil, err
		}
		if ev.Redaction != nil {
			return nil, apperr.ErrNotFound
		}
	}
	emoji := strings.TrimSpace(act.Emoji)
	if emoji == "" || utf8.RuneCountInString(emoji) > 16 || math.IsNaN(act.X) || math.IsInf(act.X, 0) || act.X < 0 || act.X > 1 || math.IsNaN(act.Y) || math.IsInf(act.Y, 0) || math.Abs(act.Y) > 4000 || (act.OnBubble && (act.Y < 0 || act.Y > 1)) {
		return nil, apperr.ErrBadRequest
	}
	return &amv1.EmojiPinAct{TargetEventId: act.TargetEventId, Emoji: emoji, X: act.X, Y: act.Y, OnBubble: act.OnBubble}, nil
}
func (s *Service) storePin(ctx context.Context, q *store.Queries, me *store.User, row *store.Event, act *amv1.EmojiPinAct) error {
	if act.RemovePinId != 0 {
		return q.RemoveMessagePin(ctx, act.RemovePinId, row.EventID)
	}
	err := q.AddMessagePin(ctx, store.MessagePin{ID: row.EventID, ConvID: row.ConvID, TargetID: act.TargetEventId, UserID: me.ID, Emoji: act.Emoji, X: act.X, Y: act.Y, Revision: row.EventID, OnBubble: act.OnBubble}, s.limits.MaxPinsPerMessage)
	if errors.Is(err, store.ErrPinLimit) {
		return apperr.ErrTooLong
	}
	return err
}
func (s *Service) ListPins(ctx context.Context, me *store.User, convID int64) (*amv1.ListEmojiPinsResponse, error) {
	if _, err := s.st.GetConvForUser(ctx, convID, me.ID); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, apperr.ErrNotMember
		}
		return nil, err
	}
	pins, err := s.st.ListMessagePins(ctx, convID)
	if err != nil {
		return nil, err
	}
	out := &amv1.ListEmojiPinsResponse{}
	for _, p := range pins {
		out.Pins = append(out.Pins, &amv1.EmojiPin{Id: p.ID, ConvId: p.ConvID, TargetEventId: p.TargetID, UserId: p.UserID, Emoji: p.Emoji, X: p.X, Y: p.Y, Revision: p.Revision, Removed: p.Removed, OnBubble: p.OnBubble})
	}
	return out, nil
}

// ExportForward creates a read-only snapshot. Imported payloads cannot be
// used here to turn foreign metadata into native, server-verified authors.
func (s *Service) ExportForward(ctx context.Context, me *store.User, convID int64, req *amv1.ForwardRequest) (*amv1.ForwardMsg, error) {
	if len(req.GetImportedEntries()) != 0 || req.GetSourceServer() != "" {
		return nil, apperr.ErrBadRequest
	}
	snapshot, _, err := s.buildForward(ctx, me, &amv1.ForwardRequest{SourceConvId: convID, EventIds: req.GetEventIds()})
	return snapshot, err
}

func (s *Service) importForward(ctx context.Context, me *store.User, req *amv1.ForwardRequest) (*amv1.ForwardMsg, map[int64]bool, error) {
	if req.GetSourceConvId() != 0 || len(req.GetEventIds()) != 0 || len(req.GetImportedEntries()) > s.limits.MaxForwardMessages {
		return nil, nil, apperr.ErrBadRequest
	}
	server := strings.TrimSpace(req.GetSourceServer())
	if server == "" || utf8.RuneCountInString(server) > 255 || strings.ContainsAny(server, "\r\n\t") {
		return nil, nil, apperr.ErrBadRequest
	}
	result := &amv1.ForwardMsg{}
	mediaIDs := map[int64]bool{}
	for _, original := range req.ImportedEntries {
		if original == nil {
			return nil, nil, apperr.ErrBadRequest
		}
		entry := proto.Clone(original).(*amv1.ForwardEntry)
		entry.Imported = true
		entry.SourceServer = strings.TrimSpace(entry.SourceServer)
		if entry.SourceServer == "" {
			entry.SourceServer = server
		}
		if entry.SourceConvId <= 0 || entry.SourceEventId <= 0 || entry.SenderId <= 0 || entry.SentAt <= 0 || strings.TrimSpace(entry.SenderName) == "" || strings.TrimSpace(entry.SourceName) == "" || utf8.RuneCountInString(entry.SenderName) > 64 || utf8.RuneCountInString(entry.SourceName) > 256 || utf8.RuneCountInString(entry.SourceServer) > 255 || strings.ContainsAny(entry.SourceServer, "\r\n\t") {
			return nil, nil, apperr.ErrBadRequest
		}
		switch body := entry.Body.(type) {
		case *amv1.ForwardEntry_Text:
			if utf8.RuneCountInString(body.Text.GetText()) > s.limits.MaxTextLength {
				return nil, nil, apperr.ErrTooLong
			}
			if strings.TrimSpace(body.Text.GetText()) == "" {
				return nil, nil, apperr.ErrEmptyMessage
			}
			entry.Body = &amv1.ForwardEntry_Text{Text: &amv1.TextMsg{Text: body.Text.Text}}
		case *amv1.ForwardEntry_Image:
			m, err := s.media.OwnUpload(ctx, me.ID, body.Image.GetMediaId(), true)
			if err != nil {
				return nil, nil, err
			}
			entry.Body = &amv1.ForwardEntry_Image{Image: &amv1.ImageMsg{MediaId: m.ID, Width: int32(m.Width), Height: int32(m.Height), StickerTags: sticker.CleanTags(body.Image.GetStickerTags()), Nsfw: body.Image.GetNsfw()}}
			mediaIDs[m.ID] = true
		case *amv1.ForwardEntry_File:
			m, err := s.media.OwnUpload(ctx, me.ID, body.File.GetMediaId(), false)
			if err != nil {
				return nil, nil, err
			}
			name := path.Base(strings.ReplaceAll(strings.TrimSpace(body.File.GetName()), "\\", "/"))
			if name == "." || name == "/" || name == "" {
				name = m.Name
			}
			if utf8.RuneCountInString(name) > 255 {
				return nil, nil, apperr.ErrTooLong
			}
			entry.Body = &amv1.ForwardEntry_File{File: &amv1.FileMsg{MediaId: m.ID, Name: name, Size: m.Size}}
			mediaIDs[m.ID] = true
		default:
			return nil, nil, apperr.ErrBadRequest
		}
		result.Entries = append(result.Entries, entry)
	}
	return result, mediaIDs, nil
}

// JSON escapes can use six bytes per rune. The remaining per-entry budget
// covers provenance, media tags and field names without changing global limits.
func (s *Service) ForwardImportBytes() int64 {
	return int64(s.limits.MaxForwardMessages)*(int64(s.limits.MaxTextLength)*6+8192) + 8192
}
