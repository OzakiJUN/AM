package store

import "context"

type Media struct {
	ID         int64
	UploaderID int64
	SHA256     string
	PHash      int64 // 0 = none
	Mime       string
	Size       int64
	Width      int
	Height     int
	Name       string
	IsImage    bool
	HasThumb   bool
	CreatedAt  int64
}

const mediaCols = `id, uploader_id, sha256, COALESCE(phash, 0), mime, size, width, height, name, is_image, has_thumb, created_at`

func scanMedia(row scanner) (*Media, error) {
	m := &Media{}
	err := row.Scan(&m.ID, &m.UploaderID, &m.SHA256, &m.PHash, &m.Mime, &m.Size, &m.Width, &m.Height,
		&m.Name, &m.IsImage, &m.HasThumb, &m.CreatedAt)
	if err != nil {
		return nil, notFound(err)
	}
	return m, nil
}

func (q *Queries) CreateMedia(ctx context.Context, m *Media) error {
	_, err := q.exec(ctx, `INSERT INTO media (id, uploader_id, sha256, phash, mime, size, width, height, name,
		is_image, has_thumb, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
		m.ID, m.UploaderID, m.SHA256, nullInt(m.PHash), m.Mime, m.Size, m.Width, m.Height, m.Name,
		m.IsImage, m.HasThumb, m.CreatedAt)
	return err
}

func (q *Queries) GetMedia(ctx context.Context, id int64) (*Media, error) {
	return scanMedia(q.queryRow(ctx, `SELECT `+mediaCols+` FROM media WHERE id=?`, id))
}

// CanAccessMedia reports whether a user may download a media item: they
// uploaded it, it is someone's avatar or on a profile page, it is the avatar
// of a group they are in, or it is in a visible message of a conversation
// they are in.
func (q *Queries) CanAccessMedia(ctx context.Context, mediaID, userID int64) (bool, error) {
	var n int
	err := q.queryRow(ctx, `SELECT
		(SELECT count(*) FROM media WHERE id=? AND uploader_id=?) +
		(SELECT count(*) FROM users WHERE avatar_media_id=?) +
		(SELECT count(*) FROM profile_media WHERE media_id=?) +
		(SELECT count(*) FROM conversations c JOIN conv_members m ON m.conv_id=c.id AND m.user_id=?
			WHERE c.avatar_media_id=?) +
		(SELECT count(*) FROM events e JOIN conv_members m ON m.conv_id=e.conv_id AND m.user_id=?
			WHERE e.media_id=? AND e.redacted_by IS NULL)`,
		mediaID, userID, mediaID, mediaID, userID, mediaID, userID, mediaID).Scan(&n)
	return n > 0, err
}

// UnreferencedMedia returns media rows older than `before` that no message,
// evidence or avatar refers to (safe to delete).
func (q *Queries) UnreferencedMedia(ctx context.Context, before int64, limit int) ([]*Media, error) {
	rows, err := q.query(ctx, `SELECT `+mediaCols+` FROM media md WHERE md.created_at < ?
		AND NOT EXISTS (SELECT 1 FROM events e WHERE e.media_id = md.id)
		AND NOT EXISTS (SELECT 1 FROM evidence ev WHERE ev.media_id = md.id)
		AND NOT EXISTS (SELECT 1 FROM users u WHERE u.avatar_media_id = md.id)
		AND NOT EXISTS (SELECT 1 FROM profile_media pm WHERE pm.media_id = md.id)
		AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.avatar_media_id = md.id)
		LIMIT ?`, before, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Media
	for rows.Next() {
		m, err := scanMedia(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func (q *Queries) DeleteMedia(ctx context.Context, id int64) error {
	_, err := q.exec(ctx, `DELETE FROM media WHERE id=?`, id)
	return err
}

// CountMediaBySHA counts rows still using a blob.
func (q *Queries) CountMediaBySHA(ctx context.Context, sha string) (int, error) {
	var n int
	err := q.queryRow(ctx, `SELECT count(*) FROM media WHERE sha256=?`, sha).Scan(&n)
	return n, err
}

// ---- blocklist ----

type BlockedHash struct {
	ID     int64
	PHash  int64
	Reason string
}

func (q *Queries) AddBlockedHash(ctx context.Context, id, phash int64, reason string, by, now int64) error {
	_, err := q.exec(ctx, `INSERT INTO media_blocklist (id, phash, reason, created_by, created_at) VALUES (?,?,?,?,?)`,
		id, phash, reason, nullInt(by), now)
	return err
}

func (q *Queries) ListBlockedHashes(ctx context.Context) ([]BlockedHash, error) {
	rows, err := q.query(ctx, `SELECT id, phash, reason FROM media_blocklist`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []BlockedHash
	for rows.Next() {
		var b BlockedHash
		if err := rows.Scan(&b.ID, &b.PHash, &b.Reason); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}
