// Package sticker keeps people's sticker collections and the server's
// shared sticker library (docs/design.md §11).
//
// A sticker is shared unless its owner marks it private: shared ones point
// at one picture in the library (copies that are the same file or look the
// same are merged into the earliest upload, whose uploader is shown) and
// share one set of tags that everyone adds to. Private ones keep their own
// picture and tags. Tags travel with a sent sticker (ImageMsg.sticker_tags)
// so AIs read the tags instead of the picture.
package sticker

import (
	"context"
	"errors"
	"log/slog"
	"time"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/apperr"
	"github.com/OzakiJUN/am/server/internal/idgen"
	"github.com/OzakiJUN/am/server/internal/media"
	"github.com/OzakiJUN/am/server/internal/store"
)

const (
	// MaxTags is how many tags a private sticker (and a sent one) carries.
	MaxTags   = 10
	MaxTagLen = 20
	// MaxSharedTags is how many different tags a library picture may have.
	MaxSharedTags = 20
)

// Config is what the service needs from config.toml.
type Config struct {
	// limits.max_stickers
	Max int
	// stickers.library, stickers.default_public, stickers.dedupe_distance
	Library        bool
	DefaultPublic  bool
	DedupeDistance int
	// retention.evidence_days, for admin deletes.
	EvidenceDays int
}

type Service struct {
	st    *store.Store
	ids   *idgen.Generator
	media *media.Service
	cfg   Config
	now   func() time.Time
}

func New(st *store.Store, ids *idgen.Generator, md *media.Service, cfg Config) *Service {
	return &Service{st: st, ids: ids, media: md, cfg: cfg, now: time.Now}
}

// CleanTags trims tags, drops empty and repeated ones and keeps at most
// MaxTags of at most MaxTagLen characters.
func CleanTags(in []string) []string { return cleanTags(in, MaxTags) }

// ---- reading ----

// views turns stickers into what the client gets (shared ones with the
// library's tags and uploader).
func (s *Service) views(ctx context.Context, me int64, list []*store.Sticker) ([]*amv1.Sticker, error) {
	var libIDs []int64
	for _, x := range list {
		if x.LibraryID != 0 {
			libIDs = append(libIDs, x.LibraryID)
		}
	}
	items, err := s.st.LibraryItems(ctx, libIDs)
	if err != nil {
		return nil, err
	}
	tags, err := s.st.LibraryTags(ctx, libIDs)
	if err != nil {
		return nil, err
	}
	out := make([]*amv1.Sticker, 0, len(list))
	for _, x := range list {
		v := &amv1.Sticker{Id: x.ID, MediaId: x.MediaID, CreatedAt: x.CreatedAt, Private: x.Private, Sha256: x.SHA256}
		if it := items[x.LibraryID]; x.LibraryID != 0 && it != nil {
			v.LibraryId, v.UploaderId = it.ID, it.UploaderID
			v.Tags, v.MyTags = mergeTags(tags[it.ID], me)
		} else {
			v.Tags, v.MyTags = nonNil(x.Tags), nonNil(x.Tags)
		}
		out = append(out, v)
	}
	return out, nil
}

func nonNil(t []string) []string {
	if t == nil {
		return []string{}
	}
	return t
}

func (s *Service) view(ctx context.Context, me int64, x *store.Sticker) (*amv1.Sticker, error) {
	// Re-read: the picture and sha may have changed when it was linked.
	cur, err := s.st.GetSticker(ctx, x.ID)
	if err != nil {
		return nil, err
	}
	v, err := s.views(ctx, me, []*store.Sticker{cur})
	if err != nil {
		return nil, err
	}
	return v[0], nil
}

func (s *Service) List(ctx context.Context, me *store.User) (*amv1.ListStickersResponse, error) {
	list, err := s.st.ListStickers(ctx, me.ID)
	if err != nil {
		return nil, err
	}
	v, err := s.views(ctx, me.ID, list)
	if err != nil {
		return nil, err
	}
	return &amv1.ListStickersResponse{Stickers: v}, nil
}

func (s *Service) mine(ctx context.Context, me *store.User, id int64) (*store.Sticker, error) {
	x, err := s.st.GetSticker(ctx, id)
	if errors.Is(err, store.ErrNotFound) || (err == nil && x.OwnerID != me.ID) {
		return nil, apperr.ErrNotFound
	}
	return x, err
}

// ---- adding ----

// Add puts a picture into my collection: one of my uploads or one I can
// see (sent in a chat I am in). private nil = the server default. The same
// picture twice returns the sticker already there, with the new tags added.
func (s *Service) Add(ctx context.Context, me *store.User, mediaID int64, tags []string, private *bool) (*amv1.Sticker, error) {
	m, err := s.media.VisibleImage(ctx, me.ID, mediaID)
	if err != nil {
		return nil, err
	}
	priv := !s.cfg.DefaultPublic
	if private != nil {
		priv = *private
	}
	var out *store.Sticker
	if priv || !s.cfg.Library {
		out, err = s.addOwn(ctx, me.ID, m, CleanTags(tags), priv)
	} else {
		out, err = s.addShared(ctx, me.ID, m, cleanTags(tags, MaxSharedTags))
	}
	if err != nil {
		return nil, err
	}
	return s.view(ctx, me.ID, out)
}

// addOwn adds a private sticker (or a shared one while the library is off:
// it is linked when the library is turned on).
func (s *Service) addOwn(ctx context.Context, owner int64, m *store.Media, tags []string, private bool) (*store.Sticker, error) {
	var out *store.Sticker
	err := s.st.InTx(ctx, func(q *store.Queries) error {
		cur, err := q.StickerByMedia(ctx, owner, m.ID)
		if err == nil {
			out = cur
			if cur.LibraryID != 0 {
				_, err := s.addTags(ctx, q, owner, cur.LibraryID, tags)
				return err
			}
			cur.Tags = CleanTags(append(cur.Tags, tags...))
			return q.SetStickerTags(ctx, cur.ID, cur.Tags)
		}
		if !errors.Is(err, store.ErrNotFound) {
			return err
		}
		if err := s.checkRoom(ctx, q, owner); err != nil {
			return err
		}
		out = &store.Sticker{ID: s.ids.Next(), OwnerID: owner, MediaID: m.ID, Tags: tags, CreatedAt: s.now().UnixMilli(), Private: private}
		return q.InsertSticker(ctx, out)
	})
	return out, err
}

func (s *Service) checkRoom(ctx context.Context, q *store.Queries, owner int64) error {
	n, err := q.CountStickers(ctx, owner)
	if err != nil {
		return err
	}
	if n >= s.cfg.Max {
		return apperr.ErrStickerLimit
	}
	return nil
}

// fingerprint reads a picture's fingerprint ("" if it can't be read: then
// only identical files match).
func (s *Service) fingerprint(m *store.Media) print {
	p := print{animated: m.Mime == "image/gif", ratio: ratioOf(m.Width, m.Height)}
	if fp, err := s.media.Fingerprint(m); err == nil {
		if pp, ok := parsePrint(fp, p.animated, p.ratio); ok {
			p.h = pp.h
		}
	}
	return p
}

func (p print) hex() string {
	if p.h == [4]uint64{} {
		return ""
	}
	const digits = "0123456789abcdef"
	b := make([]byte, 0, 64)
	for _, x := range p.h {
		for i := 60; i >= 0; i -= 4 {
			b = append(b, digits[(x>>uint(i))&0xf])
		}
	}
	return string(b)
}

// libraryFor finds the library picture for an image (same file, or one
// that looks the same) or adds the image as a new one. Call inside InTx.
func (s *Service) libraryFor(ctx context.Context, q *store.Queries, m *store.Media, p print) (*store.LibraryItem, error) {
	item, err := q.LibraryByFile(ctx, m.SHA256)
	if err == nil {
		return item, nil
	}
	if !errors.Is(err, store.ErrNotFound) {
		return nil, err
	}
	if p.comparable() {
		prints, err := q.LibraryPrints(ctx)
		if err != nil {
			return nil, err
		}
		if id := closest(p, prints, s.cfg.DedupeDistance); id != 0 {
			if item, err = q.GetLibraryItem(ctx, id); err != nil {
				return nil, err
			}
			return item, q.AddLibraryFile(ctx, m.SHA256, item.ID)
		}
	}
	item = &store.LibraryItem{ID: s.ids.Next(), MediaID: m.ID, UploaderID: m.UploaderID, Fingerprint: p.hex(),
		Animated: p.animated, Ratio: p.ratio, CreatedAt: s.now().UnixMilli()}
	if err := q.InsertLibraryItem(ctx, item); err != nil {
		return nil, err
	}
	return item, q.AddLibraryFile(ctx, m.SHA256, item.ID)
}

func (s *Service) addShared(ctx context.Context, owner int64, m *store.Media, tags []string) (*store.Sticker, error) {
	p := s.fingerprint(m) // reads the file: outside the transaction
	var out *store.Sticker
	err := s.st.InTx(ctx, func(q *store.Queries) error {
		item, err := s.libraryFor(ctx, q, m, p)
		if err != nil {
			return err
		}
		out, err = s.collectIn(ctx, q, owner, item, tags)
		return err
	})
	return out, err
}

// collectIn puts a library picture into someone's collection (or returns
// the sticker they already have for it) and adds their tags.
func (s *Service) collectIn(ctx context.Context, q *store.Queries, owner int64, item *store.LibraryItem, tags []string) (*store.Sticker, error) {
	cur, err := q.StickerByLibrary(ctx, owner, item.ID)
	if errors.Is(err, store.ErrNotFound) {
		// A private (or not yet linked) sticker with the same picture.
		cur, err = q.StickerByMedia(ctx, owner, item.MediaID)
		if err == nil && cur.LibraryID == 0 {
			cur.Tags = append(cur.Tags, tags...)
			return s.link(ctx, q, cur, item)
		}
	}
	if err == nil {
		_, err = s.addTags(ctx, q, owner, cur.LibraryID, tags)
		return cur, err
	}
	if !errors.Is(err, store.ErrNotFound) {
		return nil, err
	}
	if err := s.checkRoom(ctx, q, owner); err != nil {
		return nil, err
	}
	cur = &store.Sticker{ID: s.ids.Next(), OwnerID: owner, MediaID: item.MediaID, LibraryID: item.ID, CreatedAt: s.now().UnixMilli()}
	if err := q.InsertSticker(ctx, cur); err != nil {
		return nil, err
	}
	if _, err := q.AddCollectors(ctx, item.ID, 1); err != nil {
		return nil, err
	}
	_, err = s.addTags(ctx, q, owner, item.ID, tags)
	return cur, err
}

// link turns a private / not yet linked sticker into a shared one pointing
// at item; its own tags become the owner's tags on the picture. If the
// owner already has a sticker for item, x is merged into that one.
func (s *Service) link(ctx context.Context, q *store.Queries, x *store.Sticker, item *store.LibraryItem) (*store.Sticker, error) {
	other, err := q.StickerByLibrary(ctx, x.OwnerID, item.ID)
	if errors.Is(err, store.ErrNotFound) && x.MediaID != item.MediaID {
		other, err = q.StickerByMedia(ctx, x.OwnerID, item.MediaID)
	}
	if err == nil && other.ID != x.ID {
		if err := q.DeleteSticker(ctx, x.ID); err != nil {
			return nil, err
		}
		if other.LibraryID == 0 {
			other.Tags = append(other.Tags, x.Tags...)
			return s.link(ctx, q, other, item)
		}
		_, err = s.addTags(ctx, q, x.OwnerID, item.ID, x.Tags)
		return other, err
	}
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return nil, err
	}
	if err := q.SetStickerLink(ctx, x.ID, item.ID, item.MediaID, false); err != nil {
		return nil, err
	}
	if err := q.SetStickerTags(ctx, x.ID, nil); err != nil {
		return nil, err
	}
	if _, err := q.AddCollectors(ctx, item.ID, 1); err != nil {
		return nil, err
	}
	if _, err := s.addTags(ctx, q, x.OwnerID, item.ID, cleanTags(x.Tags, MaxSharedTags)); err != nil {
		return nil, err
	}
	x.LibraryID, x.MediaID, x.Private, x.Tags = item.ID, item.MediaID, false, nil
	return x, nil
}

// addTags adds tags as `by`'s on a library picture. Tags that would go over
// MaxSharedTags are left out (full = true).
func (s *Service) addTags(ctx context.Context, q *store.Queries, by, libraryID int64, tags []string) (full bool, err error) {
	if len(tags) == 0 || libraryID == 0 {
		return false, nil
	}
	cur, err := q.LibraryTags(ctx, []int64{libraryID})
	if err != nil {
		return false, err
	}
	keys := map[string]bool{}
	for _, t := range cur[libraryID] {
		keys[t.Key] = true
	}
	now := s.now().UnixMilli()
	for _, t := range cleanTags(tags, MaxSharedTags) {
		k := tagKey(t)
		if !keys[k] && len(keys) >= MaxSharedTags {
			full = true
			continue
		}
		keys[k] = true
		if err := q.AddLibraryTag(ctx, store.LibraryTag{LibraryID: libraryID, Key: k, Tag: t, AddedBy: by, AddedAt: now}); err != nil {
			return full, err
		}
	}
	return full, nil
}

// ---- changing ----

// SetTags replaces a sticker's tags. For a shared one only my own tags
// change: tags other people added stay.
func (s *Service) SetTags(ctx context.Context, me *store.User, id int64, tags []string) (*amv1.Sticker, error) {
	x, err := s.mine(ctx, me, id)
	if err != nil {
		return nil, err
	}
	if x.LibraryID == 0 {
		if err := s.st.SetStickerTags(ctx, id, CleanTags(tags)); err != nil {
			return nil, err
		}
		return s.view(ctx, me.ID, x)
	}
	want := map[string]bool{}
	for _, t := range cleanTags(tags, MaxSharedTags) {
		want[tagKey(t)] = true
	}
	err = s.st.InTx(ctx, func(q *store.Queries) error {
		cur, err := q.LibraryTags(ctx, []int64{x.LibraryID})
		if err != nil {
			return err
		}
		have := map[string]bool{}
		for _, t := range cur[x.LibraryID] {
			have[t.Key] = true
			if t.AddedBy == me.ID && !want[t.Key] {
				if _, err := q.RemoveLibraryTag(ctx, x.LibraryID, t.Key, me.ID); err != nil {
					return err
				}
			}
		}
		var add []string
		for _, t := range cleanTags(tags, MaxSharedTags) {
			if !have[tagKey(t)] {
				add = append(add, t)
			}
		}
		_, err = s.addTags(ctx, q, me.ID, x.LibraryID, add)
		return err
	})
	if err != nil {
		return nil, err
	}
	return s.view(ctx, me.ID, x)
}

// SetPrivate makes a sticker private (only mine, with the tags it has now;
// the library picture goes if nobody else has it) or shared.
func (s *Service) SetPrivate(ctx context.Context, me *store.User, id int64, private bool) (*amv1.Sticker, error) {
	x, err := s.mine(ctx, me, id)
	if err != nil {
		return nil, err
	}
	switch {
	case private && x.Private:
	case private:
		err = s.st.InTx(ctx, func(q *store.Queries) error {
			if x.LibraryID != 0 {
				cur, err := q.LibraryTags(ctx, []int64{x.LibraryID})
				if err != nil {
					return err
				}
				all, _ := mergeTags(cur[x.LibraryID], me.ID)
				if err := q.SetStickerTags(ctx, x.ID, CleanTags(all)); err != nil {
					return err
				}
				if err := s.leave(ctx, q, x.LibraryID); err != nil {
					return err
				}
			}
			return q.SetStickerLink(ctx, x.ID, 0, x.MediaID, true)
		})
	case x.LibraryID != 0:
	case !s.cfg.Library:
		// Shared, linked when the library is turned on.
		err = s.st.SetStickerLink(ctx, x.ID, 0, x.MediaID, false)
	default:
		var m *store.Media
		if m, err = s.st.GetMedia(ctx, x.MediaID); err != nil {
			return nil, err
		}
		p := s.fingerprint(m)
		err = s.st.InTx(ctx, func(q *store.Queries) error {
			item, err := s.libraryFor(ctx, q, m, p)
			if err != nil {
				return err
			}
			x, err = s.link(ctx, q, x, item)
			return err
		})
	}
	if err != nil {
		return nil, err
	}
	return s.view(ctx, me.ID, x)
}

// leave takes one collector off a library picture; the picture goes when
// nobody has it any more.
func (s *Service) leave(ctx context.Context, q *store.Queries, libraryID int64) error {
	n, err := q.AddCollectors(ctx, libraryID, -1)
	if errors.Is(err, store.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if n <= 0 {
		item, err := q.GetLibraryItem(ctx, libraryID)
		if err != nil {
			return err
		}
		if item.DeletedAt == 0 {
			return q.RemoveLibraryItem(ctx, libraryID)
		}
	}
	return nil
}

// Delete takes a sticker out of my collection (messages that used it stay).
func (s *Service) Delete(ctx context.Context, me *store.User, id int64) error {
	x, err := s.mine(ctx, me, id)
	if err != nil {
		return err
	}
	return s.st.InTx(ctx, func(q *store.Queries) error {
		if err := q.DeleteSticker(ctx, id); err != nil {
			return err
		}
		if x.LibraryID != 0 {
			return s.leave(ctx, q, x.LibraryID)
		}
		return nil
	})
}

// LinkWaiting puts shared stickers that are not in the library yet (made
// before it existed or while it was off) into it, oldest first so the
// earliest copy of each picture becomes the library's. Run at start.
func (s *Service) LinkWaiting(ctx context.Context, log *slog.Logger) {
	if !s.cfg.Library {
		return
	}
	list, err := s.st.StickersToLink(ctx)
	if err != nil {
		log.Error("sticker library: list stickers to link", "err", err)
		return
	}
	n := 0
	for _, x := range list {
		m, err := s.st.GetMedia(ctx, x.MediaID)
		if err != nil {
			log.Warn("sticker library: picture missing, sticker kept private", "sticker", x.ID, "err", err)
			_ = s.st.SetStickerLink(ctx, x.ID, 0, x.MediaID, true)
			continue
		}
		p := s.fingerprint(m)
		err = s.st.InTx(ctx, func(q *store.Queries) error {
			cur, err := q.GetSticker(ctx, x.ID) // may have been merged away
			if errors.Is(err, store.ErrNotFound) || (err == nil && cur.LibraryID != 0) {
				return nil
			}
			if err != nil {
				return err
			}
			item, err := s.libraryFor(ctx, q, m, p)
			if err != nil {
				return err
			}
			_, err = s.link(ctx, q, cur, item)
			return err
		})
		if err != nil {
			log.Error("sticker library: link sticker", "sticker", x.ID, "err", err)
			continue
		}
		n++
	}
	if n > 0 {
		log.Info("sticker library: shared existing stickers", "stickers", n)
	}
}
