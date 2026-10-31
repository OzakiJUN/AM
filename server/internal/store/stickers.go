package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
)

// Sticker is one image in a person's sticker collection.
type Sticker struct {
	ID        int64
	OwnerID   int64
	MediaID   int64
	Tags      []string
	CreatedAt int64
}

const stickerCols = `id, owner_id, media_id, tags, created_at`

func scanSticker(r interface{ Scan(...any) error }) (*Sticker, error) {
	var s Sticker
	var tags string
	if err := r.Scan(&s.ID, &s.OwnerID, &s.MediaID, &tags, &s.CreatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	_ = json.Unmarshal([]byte(tags), &s.Tags)
	return &s, nil
}

func tagsJSON(tags []string) string {
	if tags == nil {
		tags = []string{}
	}
	b, _ := json.Marshal(tags)
	return string(b)
}

// ListStickers returns a person's stickers, newest first.
func (q *Queries) ListStickers(ctx context.Context, ownerID int64) ([]*Sticker, error) {
	rows, err := q.query(ctx, `SELECT `+stickerCols+` FROM stickers WHERE owner_id=? ORDER BY created_at DESC, id DESC`, ownerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Sticker
	for rows.Next() {
		s, err := scanSticker(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// CountStickers returns how many stickers a person has.
func (q *Queries) CountStickers(ctx context.Context, ownerID int64) (int, error) {
	var n int
	err := q.queryRow(ctx, `SELECT count(*) FROM stickers WHERE owner_id=?`, ownerID).Scan(&n)
	return n, err
}

// GetSticker returns one sticker by id.
func (q *Queries) GetSticker(ctx context.Context, id int64) (*Sticker, error) {
	return scanSticker(q.queryRow(ctx, `SELECT `+stickerCols+` FROM stickers WHERE id=?`, id))
}

// StickerByMedia returns a person's sticker for an image (ErrNotFound if none).
func (q *Queries) StickerByMedia(ctx context.Context, ownerID, mediaID int64) (*Sticker, error) {
	return scanSticker(q.queryRow(ctx, `SELECT `+stickerCols+` FROM stickers WHERE owner_id=? AND media_id=?`, ownerID, mediaID))
}

// InsertSticker adds a sticker.
func (q *Queries) InsertSticker(ctx context.Context, s *Sticker) error {
	_, err := q.exec(ctx, `INSERT INTO stickers (`+stickerCols+`) VALUES (?,?,?,?,?)`, s.ID, s.OwnerID, s.MediaID, tagsJSON(s.Tags), s.CreatedAt)
	return err
}

// SetStickerTags replaces a sticker's tags.
func (q *Queries) SetStickerTags(ctx context.Context, id int64, tags []string) error {
	_, err := q.exec(ctx, `UPDATE stickers SET tags=? WHERE id=?`, tagsJSON(tags), id)
	return err
}

// DeleteSticker removes a sticker (the image stays while anything else uses it).
func (q *Queries) DeleteSticker(ctx context.Context, id int64) error {
	_, err := q.exec(ctx, `DELETE FROM stickers WHERE id=?`, id)
	return err
}
