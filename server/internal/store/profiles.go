package store

import "context"

// ---- profile layouts (widgets) ----

// Profile owner kinds.
const (
	ProfileUser   int16 = 1
	ProfileServer int16 = 2
)

// LatestLayout returns the current (newest) layout of a profile.
func (q *Queries) LatestLayout(ctx context.Context, kind int16, owner int64) (version int64, data []byte, err error) {
	err = q.queryRow(ctx, `SELECT version, layout FROM profile_layouts WHERE owner_kind=? AND owner_id=?
		ORDER BY version DESC LIMIT 1`, kind, owner).Scan(&version, &data)
	return version, data, notFound(err)
}

// AddLayout stores a new version. A version that already exists (someone
// saved at the same moment) fails with a unique violation.
func (q *Queries) AddLayout(ctx context.Context, kind int16, owner, version int64, data []byte, by, at int64) error {
	_, err := q.exec(ctx, `INSERT INTO profile_layouts (owner_kind, owner_id, version, layout, saved_by, saved_at)
		VALUES (?,?,?,?,?,?)`, kind, owner, version, data, by, at)
	return err
}

// SetProfileMedia replaces the media list of a profile's current layout.
func (q *Queries) SetProfileMedia(ctx context.Context, kind int16, owner int64, ids []int64) error {
	if _, err := q.exec(ctx, `DELETE FROM profile_media WHERE owner_kind=? AND owner_id=?`, kind, owner); err != nil {
		return err
	}
	for _, id := range ids {
		if _, err := q.exec(ctx, `INSERT INTO profile_media (owner_kind, owner_id, media_id) VALUES (?,?,?)
			ON CONFLICT DO NOTHING`, kind, owner, id); err != nil {
			return err
		}
	}
	return nil
}

// PurgeOldLayouts deletes layout versions saved before `before`, except
// each profile's newest one. Returns rows removed.
func (q *Queries) PurgeOldLayouts(ctx context.Context, before int64) (int64, error) {
	res, err := q.exec(ctx, `DELETE FROM profile_layouts WHERE saved_at < ? AND version < (
		SELECT max(p.version) FROM profile_layouts p WHERE p.owner_kind = profile_layouts.owner_kind
		AND p.owner_id = profile_layouts.owner_id)`, before)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// ---- activity statistics ----

// MarkDay records that the user was connected on `day` (yyyymmdd).
func (q *Queries) MarkDay(ctx context.Context, userID int64, day int) error {
	_, err := q.exec(ctx, `INSERT INTO user_days (user_id, day) VALUES (?,?) ON CONFLICT DO NOTHING`, userID, day)
	return err
}

// RecentDays returns the user's most recent connected days, newest first.
func (q *Queries) RecentDays(ctx context.Context, userID int64, limit int) ([]int, error) {
	rows, err := q.query(ctx, `SELECT day FROM user_days WHERE user_id=? ORDER BY day DESC LIMIT ?`, userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []int
	for rows.Next() {
		var d int
		if err := rows.Scan(&d); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// CountMessages counts events of the given kinds, by one sender (0 = everyone).
func (q *Queries) CountMessages(ctx context.Context, senderID int64, kinds []int16) (int64, error) {
	ids := make([]int64, len(kinds))
	for i, k := range kinds {
		ids[i] = int64(k)
	}
	list, args := inList(ids)
	where := `body_kind IN ` + list
	if senderID != 0 {
		where += ` AND sender_id = ?`
		args = append(args, senderID)
	}
	var n int64
	err := q.queryRow(ctx, `SELECT count(*) FROM events WHERE `+where, args...).Scan(&n)
	return n, err
}

// CountChannels counts conversations of kind groupKind that are not dissolved.
func (q *Queries) CountChannels(ctx context.Context, groupKind int16) (int64, error) {
	var n int64
	err := q.queryRow(ctx, `SELECT count(*) FROM conversations WHERE kind=? AND NOT dissolved`, groupKind).Scan(&n)
	return n, err
}

// FirstAccountAt is when the first account was created (the server's start), 0 if none.
func (q *Queries) FirstAccountAt(ctx context.Context) (int64, error) {
	var n int64
	err := q.queryRow(ctx, `SELECT COALESCE(min(created_at), 0) FROM users`).Scan(&n)
	return n, err
}

// ---- guestbook ----

type GuestbookEntry struct {
	ID        int64
	OwnerKind int16
	OwnerID   int64
	WidgetID  string
	AuthorID  int64
	Text      string
	CreatedAt int64
	HiddenBy  int64
	DeletedBy int64
}

const guestbookCols = `id, owner_kind, owner_id, widget_id, author_id, text, created_at, COALESCE(hidden_by, 0), COALESCE(deleted_by, 0)`

func scanGuestbook(row scanner) (*GuestbookEntry, error) {
	e := &GuestbookEntry{}
	err := row.Scan(&e.ID, &e.OwnerKind, &e.OwnerID, &e.WidgetID, &e.AuthorID, &e.Text, &e.CreatedAt, &e.HiddenBy, &e.DeletedBy)
	return e, notFound(err)
}

func (q *Queries) AddGuestbook(ctx context.Context, e *GuestbookEntry) error {
	_, err := q.exec(ctx, `INSERT INTO guestbook (id, owner_kind, owner_id, widget_id, author_id, text, created_at)
		VALUES (?,?,?,?,?,?,?)`, e.ID, e.OwnerKind, e.OwnerID, e.WidgetID, e.AuthorID, e.Text, e.CreatedAt)
	return err
}

func (q *Queries) GetGuestbook(ctx context.Context, id int64) (*GuestbookEntry, error) {
	return scanGuestbook(q.queryRow(ctx, `SELECT `+guestbookCols+` FROM guestbook WHERE id=?`, id))
}

// ListGuestbook pages backwards (id < before; 0 = from the newest). Deleted
// entries are never listed; hidden ones only with withHidden.
func (q *Queries) ListGuestbook(ctx context.Context, kind int16, owner int64, widget string, before int64, limit int, withHidden bool) ([]*GuestbookEntry, error) {
	where := `owner_kind=? AND owner_id=? AND widget_id=? AND deleted_by IS NULL`
	args := []any{kind, owner, widget}
	if before > 0 {
		where += ` AND id < ?`
		args = append(args, before)
	}
	if !withHidden {
		where += ` AND hidden_by IS NULL`
	}
	rows, err := q.query(ctx, `SELECT `+guestbookCols+` FROM guestbook WHERE `+where+` ORDER BY id DESC LIMIT ?`,
		append(args, limit)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*GuestbookEntry
	for rows.Next() {
		e, err := scanGuestbook(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// SetGuestbookHidden hides (by != 0) or shows again (by = 0) an entry.
func (q *Queries) SetGuestbookHidden(ctx context.Context, id, by, at int64) error {
	return affected(q.exec(ctx, `UPDATE guestbook SET hidden_by=?, hidden_at=? WHERE id=? AND deleted_by IS NULL`,
		nullInt(by), nullInt(at), id))
}

// DeleteGuestbook takes an entry down for everyone; the text stays (evidence)
// until purge_after.
func (q *Queries) DeleteGuestbook(ctx context.Context, id, by int64, reason string, at, purgeAfter int64) error {
	return affected(q.exec(ctx, `UPDATE guestbook SET deleted_by=?, delete_reason=?, deleted_at=?, purge_after=?
		WHERE id=? AND deleted_by IS NULL`, by, reason, at, purgeAfter, id))
}

// CountGuestbookSince counts entries a user wrote since `since` (rate limit).
func (q *Queries) CountGuestbookSince(ctx context.Context, authorID, since int64) (int, error) {
	var n int
	err := q.queryRow(ctx, `SELECT count(*) FROM guestbook WHERE author_id=? AND created_at >= ?`, authorID, since).Scan(&n)
	return n, err
}

// PurgeGuestbook removes deleted entries whose evidence period is over.
func (q *Queries) PurgeGuestbook(ctx context.Context, now int64) (int64, error) {
	res, err := q.exec(ctx, `DELETE FROM guestbook WHERE purge_after IS NOT NULL AND purge_after < ?`, now)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
