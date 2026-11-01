package sticker

import (
	"context"
	"encoding/hex"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/apperr"
	"github.com/OzakiJUN/am/server/internal/store"
)

const (
	libraryPage = 60
	maxWords    = 5
	maxLookup   = 200
)

// words splits a search into lower-case words (at most maxWords).
func words(q string) []string {
	var out []string
	for _, w := range strings.Fields(strings.ToLower(q)) {
		if utf8.RuneCountInString(w) > MaxTagLen {
			w = string([]rune(w)[:MaxTagLen])
		}
		out = append(out, w)
		if len(out) == maxWords {
			break
		}
	}
	return out
}

func (s *Service) libViews(ctx context.Context, me int64, items []*store.LibraryItem) ([]*amv1.LibrarySticker, error) {
	ids := make([]int64, len(items))
	for i, it := range items {
		ids[i] = it.ID
	}
	tags, err := s.st.LibraryTags(ctx, ids)
	if err != nil {
		return nil, err
	}
	mine, err := s.st.MyLibraryStickers(ctx, me, ids)
	if err != nil {
		return nil, err
	}
	out := make([]*amv1.LibrarySticker, len(items))
	for i, it := range items {
		all, my := mergeTags(tags[it.ID], me)
		out[i] = &amv1.LibrarySticker{Id: it.ID, MediaId: it.MediaID, Tags: all, MyTags: my, UploaderId: it.UploaderID,
			Collectors: int32(it.Collectors), CreatedAt: it.CreatedAt, MyStickerId: mine[it.ID],
			Width: int32(it.Width), Height: int32(it.Height)}
	}
	return out, nil
}

// Library lists the shared library: q = words that must be part of a tag,
// newest = newest first instead of most collected.
func (s *Service) Library(ctx context.Context, me *store.User, q string, newest bool, offset int) (*amv1.ListLibraryResponse, error) {
	if !s.cfg.Library {
		return &amv1.ListLibraryResponse{Disabled: true}, nil
	}
	if offset < 0 {
		offset = 0
	}
	items, err := s.st.ListLibrary(ctx, store.LibraryQuery{Words: words(q), Newest: newest, Limit: libraryPage + 1, Offset: offset})
	if err != nil {
		return nil, err
	}
	out := &amv1.ListLibraryResponse{}
	if len(items) > libraryPage {
		items = items[:libraryPage]
		out.NextOffset = int32(offset + libraryPage)
	}
	if out.Items, err = s.libViews(ctx, me.ID, items); err != nil {
		return nil, err
	}
	return out, nil
}

// visible returns a library picture I may see: listed, or in my collection.
func (s *Service) visible(ctx context.Context, me *store.User, id int64) (*store.LibraryItem, error) {
	if !s.cfg.Library {
		return nil, apperr.ErrLibraryOff
	}
	item, err := s.st.GetLibraryItem(ctx, id)
	if errors.Is(err, store.ErrNotFound) || (err == nil && item.DeletedAt != 0) {
		return nil, apperr.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if item.HiddenAt != 0 && !me.IsSiteAdmin {
		if _, err := s.st.StickerByLibrary(ctx, me.ID, id); err != nil {
			return nil, apperr.ErrNotFound
		}
	}
	return item, nil
}

// Collect puts a library picture into my collection.
func (s *Service) Collect(ctx context.Context, me *store.User, id int64) (*amv1.Sticker, error) {
	item, err := s.visible(ctx, me, id)
	if err != nil {
		return nil, err
	}
	var out *store.Sticker
	err = s.st.InTx(ctx, func(q *store.Queries) error {
		out, err = s.collectIn(ctx, q, me.ID, item, nil)
		return err
	})
	if err != nil {
		return nil, err
	}
	return s.view(ctx, me.ID, out)
}

// EditTags adds tags to a library picture and takes off ones I added (a
// site admin: anyone's).
func (s *Service) EditTags(ctx context.Context, me *store.User, id int64, add, remove []string) (*amv1.LibrarySticker, error) {
	item, err := s.visible(ctx, me, id)
	if err != nil {
		return nil, err
	}
	err = s.st.InTx(ctx, func(q *store.Queries) error {
		for _, t := range remove {
			by := me.ID
			if me.IsSiteAdmin {
				by = 0
			}
			if _, err := q.RemoveLibraryTag(ctx, id, tagKey(t), by); err != nil {
				return err
			}
		}
		full, err := s.addTags(ctx, q, me.ID, id, add)
		if err == nil && full {
			err = apperr.ErrStickerTagsFull
		}
		return err
	})
	if err != nil {
		return nil, err
	}
	v, err := s.libViews(ctx, me.ID, []*store.LibraryItem{item})
	if err != nil {
		return nil, err
	}
	return v[0], nil
}

// Lookup says which files (SHA-256) the library already has.
func (s *Service) Lookup(ctx context.Context, shas []string) (*amv1.LookupStickersResponse, error) {
	if !s.cfg.Library {
		return &amv1.LookupStickersResponse{LibraryIds: map[string]int64{}}, nil
	}
	if len(shas) > maxLookup {
		return nil, apperr.ErrBadRequest
	}
	var clean []string
	for _, h := range shas {
		h = strings.ToLower(strings.TrimSpace(h))
		if b, err := hex.DecodeString(h); err == nil && len(b) == 32 {
			clean = append(clean, h)
		}
	}
	m, err := s.st.LibraryByFiles(ctx, clean)
	if err != nil {
		return nil, err
	}
	return &amv1.LookupStickersResponse{LibraryIds: m}, nil
}

// ---- admin panel (actor 0 = the panel) ----

// AdminItem is a library picture as the admin panel shows it.
type AdminItem struct {
	*store.LibraryItem
	Tags []string
}

// AdminList lists the library for the panel. status: "" / "visible",
// "hidden", "deleted", "all".
func (s *Service) AdminList(ctx context.Context, q, status string, newest bool, limit, offset int) ([]AdminItem, int64, error) {
	lq := store.LibraryQuery{Words: words(q), Newest: newest, Status: status, Limit: limit, Offset: offset}
	total, err := s.st.CountLibrary(ctx, lq)
	if err != nil {
		return nil, 0, err
	}
	items, err := s.st.ListLibrary(ctx, lq)
	if err != nil {
		return nil, 0, err
	}
	ids := make([]int64, len(items))
	for i, it := range items {
		ids[i] = it.ID
	}
	tags, err := s.st.LibraryTags(ctx, ids)
	if err != nil {
		return nil, 0, err
	}
	out := make([]AdminItem, len(items))
	for i, it := range items {
		all, _ := mergeTags(tags[it.ID], -1)
		out[i] = AdminItem{LibraryItem: it, Tags: all}
	}
	return out, total, nil
}

func (s *Service) audit(ctx context.Context, q *store.Queries, actor int64, action string, id int64, detail string) error {
	return q.AddAudit(ctx, &store.AuditEntry{ID: s.ids.Next(), ActorID: actor, Action: action, TargetID: id,
		Detail: detail, CreatedAt: s.now().UnixMilli()})
}

// SetHidden hides a picture from the library listing (people who have it
// keep it) or lists it again.
func (s *Service) SetHidden(ctx context.Context, actor, id int64, hidden bool) error {
	return s.st.InTx(ctx, func(q *store.Queries) error {
		var err error
		if hidden {
			err = q.SetLibraryHidden(ctx, id, actor, s.now().UnixMilli())
		} else {
			err = q.SetLibraryHidden(ctx, id, 0, 0)
		}
		if errors.Is(err, store.ErrNotFound) {
			return apperr.ErrNotFound
		}
		if err != nil {
			return err
		}
		action := "sticker_unhide"
		if hidden {
			action = "sticker_hide"
		}
		return s.audit(ctx, q, actor, action, id, "")
	})
}

// AdminDelete takes a picture out of the library and every collection. The
// picture is kept as evidence for retention.evidence_days, then purged;
// block also adds it to the image blocklist so it can't be uploaded again.
func (s *Service) AdminDelete(ctx context.Context, actor, id int64, reason string, block bool) error {
	reason = strings.TrimSpace(reason)
	if reason == "" {
		return apperr.ErrReasonRequired
	}
	if utf8.RuneCountInString(reason) > 200 {
		return apperr.ErrBadRequest
	}
	now := s.now()
	purge := now.Add(time.Duration(s.cfg.EvidenceDays) * 24 * time.Hour).UnixMilli()
	return s.st.InTx(ctx, func(q *store.Queries) error {
		item, err := q.GetLibraryItem(ctx, id)
		if errors.Is(err, store.ErrNotFound) || (err == nil && item.DeletedAt != 0) {
			return apperr.ErrNotFound
		}
		if err != nil {
			return err
		}
		if err := q.DeleteLibraryItem(ctx, id, actor, reason, now.UnixMilli(), purge); err != nil {
			return err
		}
		if block {
			if err := s.media.Block(ctx, q, item.MediaID, "sticker: "+reason, actor); err != nil {
				return err
			}
		}
		return s.audit(ctx, q, actor, "sticker_delete", id, reason)
	})
}

// AdminRemoveTag takes a tag off a picture (everyone's copy of it).
func (s *Service) AdminRemoveTag(ctx context.Context, actor, id int64, tag string) error {
	return s.st.InTx(ctx, func(q *store.Queries) error {
		n, err := q.RemoveLibraryTag(ctx, id, tagKey(tag), 0)
		if err != nil {
			return err
		}
		if n == 0 {
			return apperr.ErrNotFound
		}
		return s.audit(ctx, q, actor, "sticker_tag_remove", id, tag)
	})
}
