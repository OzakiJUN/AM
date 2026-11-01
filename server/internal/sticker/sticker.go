// Package sticker keeps each person's sticker collection (docs/design.md
// §11): their own uploaded images with tags they typed. Tags also travel
// with a sticker when it is sent (ImageMsg.sticker_tags) so AIs read the
// tags instead of the picture. The shared library with automatic
// recognition comes later and will build on the same rows.
package sticker

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/apperr"
	"github.com/OzakiJUN/am/server/internal/idgen"
	"github.com/OzakiJUN/am/server/internal/media"
	"github.com/OzakiJUN/am/server/internal/store"
)

const (
	MaxTags   = 10
	MaxTagLen = 20
)

type Service struct {
	st    *store.Store
	ids   *idgen.Generator
	media *media.Service
	max   int
}

func New(st *store.Store, ids *idgen.Generator, md *media.Service, max int) *Service {
	return &Service{st: st, ids: ids, media: md, max: max}
}

// CleanTags trims tags, drops empty and repeated ones and keeps at most
// MaxTags of at most MaxTagLen characters.
func CleanTags(in []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, t := range in {
		t = strings.Join(strings.Fields(t), " ")
		if t == "" || seen[strings.ToLower(t)] {
			continue
		}
		if utf8.RuneCountInString(t) > MaxTagLen {
			t = string([]rune(t)[:MaxTagLen])
		}
		seen[strings.ToLower(t)] = true
		out = append(out, t)
		if len(out) == MaxTags {
			break
		}
	}
	return out
}

func view(s *store.Sticker) *amv1.Sticker {
	return &amv1.Sticker{Id: s.ID, MediaId: s.MediaID, Tags: s.Tags, CreatedAt: s.CreatedAt}
}

func (s *Service) List(ctx context.Context, me *store.User) (*amv1.ListStickersResponse, error) {
	list, err := s.st.ListStickers(ctx, me.ID)
	if err != nil {
		return nil, err
	}
	out := &amv1.ListStickersResponse{}
	for _, x := range list {
		out.Stickers = append(out.Stickers, view(x))
	}
	return out, nil
}

// Add puts one of my uploaded images into my collection (the same image
// twice returns the sticker already there, with the new tags added).
func (s *Service) Add(ctx context.Context, me *store.User, mediaID int64, tags []string) (*amv1.Sticker, error) {
	if _, err := s.media.OwnUpload(ctx, me.ID, mediaID, true); err != nil {
		return nil, err
	}
	tags = CleanTags(tags)
	var out *store.Sticker
	err := s.st.InTx(ctx, func(q *store.Queries) error {
		cur, err := q.StickerByMedia(ctx, me.ID, mediaID)
		if err == nil {
			cur.Tags = CleanTags(append(cur.Tags, tags...))
			out = cur
			return q.SetStickerTags(ctx, cur.ID, cur.Tags)
		}
		if !errors.Is(err, store.ErrNotFound) {
			return err
		}
		n, err := q.CountStickers(ctx, me.ID)
		if err != nil {
			return err
		}
		if n >= s.max {
			return apperr.ErrStickerLimit
		}
		out = &store.Sticker{ID: s.ids.Next(), OwnerID: me.ID, MediaID: mediaID, Tags: tags, CreatedAt: time.Now().UnixMilli()}
		return q.InsertSticker(ctx, out)
	})
	if err != nil {
		return nil, err
	}
	return view(out), nil
}

func (s *Service) mine(ctx context.Context, me *store.User, id int64) (*store.Sticker, error) {
	x, err := s.st.GetSticker(ctx, id)
	if errors.Is(err, store.ErrNotFound) || (err == nil && x.OwnerID != me.ID) {
		return nil, apperr.ErrNotFound
	}
	return x, err
}

// SetTags replaces a sticker's tags.
func (s *Service) SetTags(ctx context.Context, me *store.User, id int64, tags []string) (*amv1.Sticker, error) {
	x, err := s.mine(ctx, me, id)
	if err != nil {
		return nil, err
	}
	x.Tags = CleanTags(tags)
	if err := s.st.SetStickerTags(ctx, id, x.Tags); err != nil {
		return nil, err
	}
	return view(x), nil
}

// Delete takes a sticker out of my collection (messages that used it stay).
func (s *Service) Delete(ctx context.Context, me *store.User, id int64) error {
	if _, err := s.mine(ctx, me, id); err != nil {
		return err
	}
	return s.st.DeleteSticker(ctx, id)
}
