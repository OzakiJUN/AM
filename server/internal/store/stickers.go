package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
)

// Sticker is one image in a person's sticker collection. A shared one
// (LibraryID != 0) points at a sticker_library row and uses its picture;
// its tags live in sticker_library_tags (Tags is empty). A private one, or
// a shared one not linked yet (LibraryID 0, Private false), keeps its own
// picture and tags.
type Sticker struct {
	ID        int64
	OwnerID   int64
	MediaID   int64
	Tags      []string
	CreatedAt int64
	LibraryID int64
	Private   bool
	SHA256    string // of the picture (filled when read)
}

const stickerCols = `s.id, s.owner_id, s.media_id, s.tags, s.created_at, COALESCE(s.library_id, 0), s.is_private, COALESCE(m.sha256, '')`
const stickerFrom = ` FROM stickers s LEFT JOIN media m ON m.id = s.media_id `

func scanSticker(r interface{ Scan(...any) error }) (*Sticker, error) {
	var s Sticker
	var tags string
	if err := r.Scan(&s.ID, &s.OwnerID, &s.MediaID, &tags, &s.CreatedAt, &s.LibraryID, &s.Private, &s.SHA256); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	_ = json.Unmarshal([]byte(tags), &s.Tags)
	return &s, nil
}

func (q *Queries) stickers(ctx context.Context, where string, args ...any) ([]*Sticker, error) {
	rows, err := q.query(ctx, `SELECT `+stickerCols+stickerFrom+where, args...)
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

func tagsJSON(tags []string) string {
	if tags == nil {
		tags = []string{}
	}
	b, _ := json.Marshal(tags)
	return string(b)
}

// ListStickers returns a person's stickers, newest first.
func (q *Queries) ListStickers(ctx context.Context, ownerID int64) ([]*Sticker, error) {
	return q.stickers(ctx, `WHERE s.owner_id=? ORDER BY s.created_at DESC, s.id DESC`, ownerID)
}

// CountStickers returns how many stickers a person has.
func (q *Queries) CountStickers(ctx context.Context, ownerID int64) (int, error) {
	var n int
	err := q.queryRow(ctx, `SELECT count(*) FROM stickers WHERE owner_id=?`, ownerID).Scan(&n)
	return n, err
}

// GetSticker returns one sticker by id.
func (q *Queries) GetSticker(ctx context.Context, id int64) (*Sticker, error) {
	return scanSticker(q.queryRow(ctx, `SELECT `+stickerCols+stickerFrom+`WHERE s.id=?`, id))
}

// StickerByMedia returns a person's sticker for an image (ErrNotFound if none).
func (q *Queries) StickerByMedia(ctx context.Context, ownerID, mediaID int64) (*Sticker, error) {
	return scanSticker(q.queryRow(ctx, `SELECT `+stickerCols+stickerFrom+`WHERE s.owner_id=? AND s.media_id=?`, ownerID, mediaID))
}

// StickerByLibrary returns a person's sticker for a library picture (ErrNotFound if none).
func (q *Queries) StickerByLibrary(ctx context.Context, ownerID, libraryID int64) (*Sticker, error) {
	return scanSticker(q.queryRow(ctx, `SELECT `+stickerCols+stickerFrom+`WHERE s.owner_id=? AND s.library_id=?`, ownerID, libraryID))
}

// InsertSticker adds a sticker.
func (q *Queries) InsertSticker(ctx context.Context, s *Sticker) error {
	_, err := q.exec(ctx, `INSERT INTO stickers (id, owner_id, media_id, tags, created_at, library_id, is_private) VALUES (?,?,?,?,?,?,?)`,
		s.ID, s.OwnerID, s.MediaID, tagsJSON(s.Tags), s.CreatedAt, nullInt(s.LibraryID), s.Private)
	return err
}

// SetStickerTags replaces a sticker's own tags.
func (q *Queries) SetStickerTags(ctx context.Context, id int64, tags []string) error {
	_, err := q.exec(ctx, `UPDATE stickers SET tags=? WHERE id=?`, tagsJSON(tags), id)
	return err
}

// SetStickerLink points a sticker at a library picture (libraryID 0 = none)
// and sets its picture and private flag.
func (q *Queries) SetStickerLink(ctx context.Context, id, libraryID, mediaID int64, private bool) error {
	_, err := q.exec(ctx, `UPDATE stickers SET library_id=?, media_id=?, is_private=? WHERE id=?`, nullInt(libraryID), mediaID, private, id)
	return err
}

// DeleteSticker removes a sticker (the image stays while anything else uses it).
func (q *Queries) DeleteSticker(ctx context.Context, id int64) error {
	_, err := q.exec(ctx, `DELETE FROM stickers WHERE id=?`, id)
	return err
}

// StickersToLink returns shared stickers that are not linked to the library
// yet, oldest first (so the earliest copy of a picture becomes the library's).
func (q *Queries) StickersToLink(ctx context.Context) ([]*Sticker, error) {
	return q.stickers(ctx, `WHERE s.library_id IS NULL AND s.is_private=? ORDER BY s.created_at, s.id`, false)
}

// MyLibraryStickers returns my sticker id per library picture (only the given ones).
func (q *Queries) MyLibraryStickers(ctx context.Context, ownerID int64, libraryIDs []int64) (map[int64]int64, error) {
	out := map[int64]int64{}
	if len(libraryIDs) == 0 {
		return out, nil
	}
	list, args := inList(libraryIDs)
	rows, err := q.query(ctx, `SELECT library_id, id FROM stickers WHERE owner_id=? AND library_id IN `+list, append([]any{ownerID}, args...)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var lib, id int64
		if err := rows.Scan(&lib, &id); err != nil {
			return nil, err
		}
		out[lib] = id
	}
	return out, rows.Err()
}

// StickerMediaUsable reports whether a user may send a picture as a sticker
// although they did not upload it: it is in their collection, or in the
// shared library (not hidden, not deleted).
func (q *Queries) StickerMediaUsable(ctx context.Context, userID, mediaID int64) (bool, error) {
	var n int
	err := q.queryRow(ctx, `SELECT
		(SELECT count(*) FROM stickers WHERE owner_id=? AND media_id=?) +
		(SELECT count(*) FROM sticker_library WHERE media_id=? AND hidden_at IS NULL AND deleted_at IS NULL)`,
		userID, mediaID, mediaID).Scan(&n)
	return n > 0, err
}

// ---- the shared library ----

// LibraryItem is one picture in the shared sticker library.
type LibraryItem struct {
	ID           int64
	MediaID      int64
	UploaderID   int64
	Fingerprint  string
	Animated     bool
	Ratio        int
	Collectors   int
	CreatedAt    int64
	HiddenBy     int64
	HiddenAt     int64
	DeletedBy    int64
	DeleteReason string
	DeletedAt    int64
	PurgeAfter   int64
	// Filled when read.
	Width, Height int
	UploaderName  string
}

const libCols = `l.id, l.media_id, l.uploader_id, l.fingerprint, l.animated, l.ratio, l.collectors, l.created_at,
	COALESCE(l.hidden_by, 0), COALESCE(l.hidden_at, 0), COALESCE(l.deleted_by, 0), l.delete_reason,
	COALESCE(l.deleted_at, 0), COALESCE(l.purge_after, 0), COALESCE(m.width, 0), COALESCE(m.height, 0),
	COALESCE(u.display_name, '')`
const libFrom = ` FROM sticker_library l LEFT JOIN media m ON m.id = l.media_id LEFT JOIN users u ON u.id = l.uploader_id `

func scanLib(r scanner) (*LibraryItem, error) {
	l := &LibraryItem{}
	err := r.Scan(&l.ID, &l.MediaID, &l.UploaderID, &l.Fingerprint, &l.Animated, &l.Ratio, &l.Collectors, &l.CreatedAt,
		&l.HiddenBy, &l.HiddenAt, &l.DeletedBy, &l.DeleteReason, &l.DeletedAt, &l.PurgeAfter, &l.Width, &l.Height, &l.UploaderName)
	if err != nil {
		return nil, notFound(err)
	}
	return l, nil
}

func (q *Queries) libItems(ctx context.Context, where string, args ...any) ([]*LibraryItem, error) {
	rows, err := q.query(ctx, `SELECT `+libCols+libFrom+where, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*LibraryItem
	for rows.Next() {
		l, err := scanLib(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// GetLibraryItem returns one library picture (also hidden / deleted ones).
func (q *Queries) GetLibraryItem(ctx context.Context, id int64) (*LibraryItem, error) {
	return scanLib(q.queryRow(ctx, `SELECT `+libCols+libFrom+`WHERE l.id=?`, id))
}

// LibraryItems returns the given library pictures by id.
func (q *Queries) LibraryItems(ctx context.Context, ids []int64) (map[int64]*LibraryItem, error) {
	out := map[int64]*LibraryItem{}
	if len(ids) == 0 {
		return out, nil
	}
	list, args := inList(ids)
	items, err := q.libItems(ctx, `WHERE l.id IN `+list, args...)
	for _, l := range items {
		out[l.ID] = l
	}
	return out, err
}

// LibraryByFile returns the library picture a file (SHA-256) belongs to
// (not deleted ones).
func (q *Queries) LibraryByFile(ctx context.Context, sha string) (*LibraryItem, error) {
	return scanLib(q.queryRow(ctx, `SELECT `+libCols+libFrom+`JOIN sticker_library_files f ON f.library_id = l.id
		WHERE f.sha256=? AND l.deleted_at IS NULL`, sha))
}

// LibraryByFiles maps files (SHA-256) to listed library pictures (not hidden, not deleted).
func (q *Queries) LibraryByFiles(ctx context.Context, shas []string) (map[string]int64, error) {
	out := map[string]int64{}
	if len(shas) == 0 {
		return out, nil
	}
	ph := make([]string, len(shas))
	args := make([]any, len(shas))
	for i, s := range shas {
		ph[i], args[i] = "?", s
	}
	rows, err := q.query(ctx, `SELECT f.sha256, l.id FROM sticker_library_files f JOIN sticker_library l ON l.id = f.library_id
		WHERE l.hidden_at IS NULL AND l.deleted_at IS NULL AND f.sha256 IN (`+strings.Join(ph, ",")+`)`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var sha string
		var id int64
		if err := rows.Scan(&sha, &id); err != nil {
			return nil, err
		}
		out[sha] = id
	}
	return out, rows.Err()
}

// LibraryPrint is what near-duplicate matching needs to know about a picture.
type LibraryPrint struct {
	ID          int64
	Fingerprint string
	Animated    bool
	Ratio       int
}

// LibraryPrints returns the fingerprints of all library pictures that are
// not deleted and have one.
func (q *Queries) LibraryPrints(ctx context.Context) ([]LibraryPrint, error) {
	rows, err := q.query(ctx, `SELECT id, fingerprint, animated, ratio FROM sticker_library WHERE deleted_at IS NULL AND fingerprint <> ''`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []LibraryPrint
	for rows.Next() {
		var p LibraryPrint
		if err := rows.Scan(&p.ID, &p.Fingerprint, &p.Animated, &p.Ratio); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// InsertLibraryItem adds a picture to the library.
func (q *Queries) InsertLibraryItem(ctx context.Context, l *LibraryItem) error {
	_, err := q.exec(ctx, `INSERT INTO sticker_library (id, media_id, uploader_id, fingerprint, animated, ratio, collectors, created_at)
		VALUES (?,?,?,?,?,?,?,?)`, l.ID, l.MediaID, l.UploaderID, l.Fingerprint, l.Animated, l.Ratio, l.Collectors, l.CreatedAt)
	return err
}

// AddLibraryFile remembers that a file (SHA-256) is a copy of a library picture.
func (q *Queries) AddLibraryFile(ctx context.Context, sha string, libraryID int64) error {
	_, err := q.exec(ctx, `INSERT INTO sticker_library_files (sha256, library_id) VALUES (?,?) ON CONFLICT (sha256) DO NOTHING`, sha, libraryID)
	return err
}

// AddCollectors changes a library picture's collector count and returns the new count.
func (q *Queries) AddCollectors(ctx context.Context, id int64, delta int) (int, error) {
	if _, err := q.exec(ctx, `UPDATE sticker_library SET collectors = collectors + ? WHERE id=?`, delta, id); err != nil {
		return 0, err
	}
	var n int
	err := q.queryRow(ctx, `SELECT collectors FROM sticker_library WHERE id=?`, id).Scan(&n)
	return n, notFound(err)
}

// RemoveLibraryItem takes a picture out of the library for good (nobody has
// it any more; not an admin delete).
func (q *Queries) RemoveLibraryItem(ctx context.Context, id int64) error {
	for _, stmt := range []string{
		`DELETE FROM sticker_library_tags WHERE library_id=?`,
		`DELETE FROM sticker_library_files WHERE library_id=?`,
		`DELETE FROM sticker_library WHERE id=?`,
	} {
		if _, err := q.exec(ctx, stmt, id); err != nil {
			return err
		}
	}
	return nil
}

// LibraryQuery selects library pictures.
type LibraryQuery struct {
	// Each word must be part of one of the picture's tags (lower case).
	Words []string
	// Newest first instead of most collected first.
	Newest bool
	// "" / "visible" = listed ones, "hidden", "deleted", "all".
	Status        string
	Limit, Offset int
}

func (lq LibraryQuery) where() (string, []any) {
	var cond []string
	var args []any
	switch lq.Status {
	case "hidden":
		cond = append(cond, `l.hidden_at IS NOT NULL AND l.deleted_at IS NULL`)
	case "deleted":
		cond = append(cond, `l.deleted_at IS NOT NULL`)
	case "all":
	default:
		cond = append(cond, `l.hidden_at IS NULL AND l.deleted_at IS NULL`)
	}
	for _, w := range lq.Words {
		cond = append(cond, `EXISTS (SELECT 1 FROM sticker_library_tags t WHERE t.library_id = l.id AND t.tag_key LIKE ? ESCAPE '\')`)
		args = append(args, "%"+escapeLike(w)+"%")
	}
	if len(cond) == 0 {
		return "", nil
	}
	return "WHERE " + strings.Join(cond, " AND ") + " ", args
}

// ListLibrary returns one page of library pictures.
func (q *Queries) ListLibrary(ctx context.Context, lq LibraryQuery) ([]*LibraryItem, error) {
	where, args := lq.where()
	order := `ORDER BY l.collectors DESC, l.id DESC`
	if lq.Newest {
		order = `ORDER BY l.created_at DESC, l.id DESC`
	}
	return q.libItems(ctx, where+order+` LIMIT ? OFFSET ?`, append(args, lq.Limit, lq.Offset)...)
}

// CountLibrary counts the pictures a query selects (Limit / Offset ignored).
func (q *Queries) CountLibrary(ctx context.Context, lq LibraryQuery) (int64, error) {
	where, args := lq.where()
	var n int64
	err := q.queryRow(ctx, `SELECT count(*) FROM sticker_library l `+where, args...).Scan(&n)
	return n, err
}

// LibraryTag is one person's tag on a library picture.
type LibraryTag struct {
	LibraryID int64
	Key       string
	Tag       string
	AddedBy   int64
	AddedAt   int64
}

// LibraryTags returns the tags of the given library pictures, oldest first.
func (q *Queries) LibraryTags(ctx context.Context, ids []int64) (map[int64][]LibraryTag, error) {
	out := map[int64][]LibraryTag{}
	if len(ids) == 0 {
		return out, nil
	}
	list, args := inList(ids)
	rows, err := q.query(ctx, `SELECT library_id, tag_key, tag, added_by, added_at FROM sticker_library_tags
		WHERE library_id IN `+list+` ORDER BY added_at, tag_key`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var t LibraryTag
		if err := rows.Scan(&t.LibraryID, &t.Key, &t.Tag, &t.AddedBy, &t.AddedAt); err != nil {
			return nil, err
		}
		out[t.LibraryID] = append(out[t.LibraryID], t)
	}
	return out, rows.Err()
}

// AddLibraryTag records that someone added a tag (no-op if they already did).
func (q *Queries) AddLibraryTag(ctx context.Context, t LibraryTag) error {
	_, err := q.exec(ctx, `INSERT INTO sticker_library_tags (library_id, tag_key, tag, added_by, added_at) VALUES (?,?,?,?,?)
		ON CONFLICT (library_id, tag_key, added_by) DO NOTHING`, t.LibraryID, t.Key, t.Tag, t.AddedBy, t.AddedAt)
	return err
}

// RemoveLibraryTag takes off one person's tag (by = 0: everyone's). Returns
// how many rows went.
func (q *Queries) RemoveLibraryTag(ctx context.Context, libraryID int64, key string, by int64) (int64, error) {
	var res sql.Result
	var err error
	if by == 0 {
		res, err = q.exec(ctx, `DELETE FROM sticker_library_tags WHERE library_id=? AND tag_key=?`, libraryID, key)
	} else {
		res, err = q.exec(ctx, `DELETE FROM sticker_library_tags WHERE library_id=? AND tag_key=? AND added_by=?`, libraryID, key, by)
	}
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// SetLibraryHidden hides a picture from the library listing (by, at) or
// shows it again (at = 0).
func (q *Queries) SetLibraryHidden(ctx context.Context, id, by, at int64) error {
	res, err := q.exec(ctx, `UPDATE sticker_library SET hidden_by=?, hidden_at=? WHERE id=? AND deleted_at IS NULL`, nullInt(by), nullInt(at), id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// DeleteLibraryItem is an admin delete: the picture leaves every collection
// and the listing, the row (and so the picture) is kept as evidence until
// purgeAfter.
func (q *Queries) DeleteLibraryItem(ctx context.Context, id, by int64, reason string, at, purgeAfter int64) error {
	var mediaID int64
	if err := q.queryRow(ctx, `SELECT media_id FROM sticker_library WHERE id=? AND deleted_at IS NULL`, id).Scan(&mediaID); err != nil {
		return notFound(err)
	}
	if _, err := q.exec(ctx, `UPDATE sticker_library SET deleted_by=?, delete_reason=?, deleted_at=?, purge_after=?, collectors=0 WHERE id=?`,
		by, reason, at, purgeAfter, id); err != nil {
		return err
	}
	if _, err := q.exec(ctx, `DELETE FROM sticker_library_files WHERE library_id=?`, id); err != nil {
		return err
	}
	// Also private copies of the same picture.
	_, err := q.exec(ctx, `DELETE FROM stickers WHERE library_id=? OR media_id=?`, id, mediaID)
	return err
}

// PurgeStickerLibrary removes admin-deleted pictures whose evidence time is over.
func (q *Queries) PurgeStickerLibrary(ctx context.Context, now int64) (int64, error) {
	if _, err := q.exec(ctx, `DELETE FROM sticker_library_tags WHERE library_id IN
		(SELECT id FROM sticker_library WHERE purge_after IS NOT NULL AND purge_after < ?)`, now); err != nil {
		return 0, err
	}
	res, err := q.exec(ctx, `DELETE FROM sticker_library WHERE purge_after IS NOT NULL AND purge_after < ?`, now)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
