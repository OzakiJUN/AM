package store

import "context"

// Read-only views for the server admin panel's "channel history" page.
// Only channels (groups): the panel never shows direct messages.

// PanelChannel is a channel row for the admin panel.
type PanelChannel struct {
	ID            int64
	Name          string
	AvatarMediaID int64
	Public        bool
	Dissolved     bool
	OwnerID       int64
	OwnerName     string
	Members       int
	LastSeq       int64
	CreatedAt     int64
}

// ListChannelsAdmin lists conversations of kind groupKind, most recently
// active first. search matches the name (case-insensitive substring).
func (q *Queries) ListChannelsAdmin(ctx context.Context, groupKind int16, search string, limit, offset int) ([]*PanelChannel, int64, error) {
	where := ` WHERE c.kind = ?`
	args := []any{groupKind}
	if search != "" {
		where += ` AND lower(c.name) LIKE ? ESCAPE '\'`
		args = append(args, "%"+escapeLike(toLower(search))+"%")
	}
	var total int64
	if err := q.queryRow(ctx, `SELECT count(*) FROM conversations c`+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := q.query(ctx, `SELECT c.id, c.name, COALESCE(c.avatar_media_id, 0), c.is_public, c.dissolved,
		COALESCE(c.owner_id, 0), COALESCE(u.display_name, ''),
		(SELECT count(*) FROM conv_members m WHERE m.conv_id = c.id), c.last_seq, c.created_at
		FROM conversations c LEFT JOIN users u ON u.id = c.owner_id`+where+`
		ORDER BY c.dissolved, COALESCE((SELECT max(e.created_at) FROM events e WHERE e.conv_id = c.id), c.created_at) DESC
		LIMIT ? OFFSET ?`, append(args, limit, offset)...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var out []*PanelChannel
	for rows.Next() {
		c := &PanelChannel{}
		if err := rows.Scan(&c.ID, &c.Name, &c.AvatarMediaID, &c.Public, &c.Dissolved, &c.OwnerID, &c.OwnerName,
			&c.Members, &c.LastSeq, &c.CreatedAt); err != nil {
			return nil, 0, err
		}
		out = append(out, c)
	}
	return out, total, rows.Err()
}

// ListEventsBefore returns up to limit events with seq < beforeSeq, newest
// first (for paging backwards through history).
func (q *Queries) ListEventsBefore(ctx context.Context, convID, beforeSeq int64, limit int) ([]*Event, error) {
	rows, err := q.query(ctx, `SELECT `+eventCols+` FROM events WHERE conv_id=? AND seq < ?
		ORDER BY seq DESC LIMIT ?`, convID, beforeSeq, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Event
	for rows.Next() {
		e, err := scanEvent(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// PanelCanSeeMedia reports whether the admin panel may show a media item:
// it is kept as evidence, sent in a channel (kind groupKind), or an
// account's or channel's avatar. Images sent in direct messages are not.
func (q *Queries) PanelCanSeeMedia(ctx context.Context, mediaID int64, groupKind int16) (bool, error) {
	var n int
	err := q.queryRow(ctx, `SELECT
		(SELECT count(*) FROM evidence WHERE media_id=?) +
		(SELECT count(*) FROM events e JOIN conversations c ON c.id = e.conv_id WHERE e.media_id=? AND c.kind=?) +
		(SELECT count(*) FROM users WHERE avatar_media_id=?) +
		(SELECT count(*) FROM conversations WHERE avatar_media_id=? AND kind=?)`,
		mediaID, mediaID, groupKind, mediaID, mediaID, groupKind).Scan(&n)
	return n > 0, err
}

// StruckTargets returns which of the given event ids were struck through
// (an event of kind strikeKind points at them).
func (q *Queries) StruckTargets(ctx context.Context, ids []int64, strikeKind int16) (map[int64]bool, error) {
	out := map[int64]bool{}
	if len(ids) == 0 {
		return out, nil
	}
	list, args := inList(ids)
	rows, err := q.query(ctx, `SELECT target_event_id FROM events WHERE body_kind = ? AND target_event_id IN `+list,
		append([]any{strikeKind}, args...)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = true
	}
	return out, rows.Err()
}
