package store

import "context"

// MuseumArt is a work in a channel's museum (docs/design.md §13 博物馆).
type MuseumArt struct {
	ID          int64
	ConvID      int64
	Slot        int // 1–8 first hall, 0 warehouse, -1 waiting for a vote
	MediaID     int64
	Title       string
	ByUser      int64
	SourceEvent int64
	Method      string
	NSFW        bool
	CreatedAt   int64
	HungAt      int64
	StoredAt    int64
	// Filled by the list queries.
	Likes    int
	ConvName string
	Public   bool
}

const artCols = `a.id, a.conv_id, a.slot, a.media_id, a.title, a.by_user, a.source_event, a.method, a.nsfw, a.created_at, a.hung_at, a.stored_at,
	(SELECT count(*) FROM museum_likes l WHERE l.art_id = a.id), c.name, c.is_public`

func scanArt(r scanner) (*MuseumArt, error) {
	a := &MuseumArt{}
	if err := r.Scan(&a.ID, &a.ConvID, &a.Slot, &a.MediaID, &a.Title, &a.ByUser, &a.SourceEvent, &a.Method, &a.NSFW,
		&a.CreatedAt, &a.HungAt, &a.StoredAt, &a.Likes, &a.ConvName, &a.Public); err != nil {
		return nil, notFound(err)
	}
	return a, nil
}

func (q *Queries) arts(ctx context.Context, where string, args ...any) ([]*MuseumArt, error) {
	rows, err := q.query(ctx, `SELECT `+artCols+` FROM museum_arts a JOIN conversations c ON c.id = a.conv_id `+where, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*MuseumArt
	for rows.Next() {
		a, err := scanArt(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// GetMuseumArt returns one work.
func (q *Queries) GetMuseumArt(ctx context.Context, id int64) (*MuseumArt, error) {
	return scanArt(q.queryRow(ctx, `SELECT `+artCols+` FROM museum_arts a JOIN conversations c ON c.id = a.conv_id WHERE a.id=?`, id))
}

// MuseumArtsOfConv returns a channel's works (hall, warehouse and waiting ones).
func (q *Queries) MuseumArtsOfConv(ctx context.Context, convID int64) ([]*MuseumArt, error) {
	return q.arts(ctx, `WHERE a.conv_id=? ORDER BY a.stored_at DESC, a.id DESC`, convID)
}

// HungArtsInPublic returns every work hung in a public channel's first hall
// (candidates for the second hall).
func (q *Queries) HungArtsInPublic(ctx context.Context) ([]*MuseumArt, error) {
	return q.arts(ctx, `WHERE a.slot > 0 AND c.is_public=? AND c.dissolved=?`, true, false)
}

// InsertMuseumArt adds a work.
func (q *Queries) InsertMuseumArt(ctx context.Context, a *MuseumArt) error {
	_, err := q.exec(ctx, `INSERT INTO museum_arts (id, conv_id, slot, media_id, title, by_user, source_event, method, nsfw, created_at, hung_at, stored_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, a.ID, a.ConvID, a.Slot, a.MediaID, a.Title, a.ByUser, a.SourceEvent, a.Method, a.NSFW,
		a.CreatedAt, a.HungAt, a.StoredAt)
	return err
}

// SetArtSlot moves a work (hungAt / storedAt > 0 update those times).
func (q *Queries) SetArtSlot(ctx context.Context, id int64, slot int, hungAt, storedAt int64) error {
	_, err := q.exec(ctx, `UPDATE museum_arts SET slot=?,
		hung_at=CASE WHEN CAST(? AS BIGINT) > 0 THEN CAST(? AS BIGINT) ELSE hung_at END,
		stored_at=CASE WHEN CAST(? AS BIGINT) > 0 THEN CAST(? AS BIGINT) ELSE stored_at END WHERE id=?`,
		slot, hungAt, hungAt, storedAt, storedAt, id)
	return err
}

// DeleteMuseumArt removes a work (a new one whose vote failed) and its likes.
func (q *Queries) DeleteMuseumArt(ctx context.Context, id int64) error {
	if _, err := q.exec(ctx, `DELETE FROM museum_likes WHERE art_id=?`, id); err != nil {
		return err
	}
	_, err := q.exec(ctx, `DELETE FROM museum_arts WHERE id=?`, id)
	return err
}

// LikeArt adds (on) or takes back my like; changed = it made a difference.
func (q *Queries) LikeArt(ctx context.Context, artID, userID int64, on bool, at int64) (bool, error) {
	if on {
		res, err := q.exec(ctx, `INSERT INTO museum_likes (art_id, user_id, created_at) VALUES (?,?,?) ON CONFLICT (art_id, user_id) DO NOTHING`, artID, userID, at)
		if err != nil {
			return false, err
		}
		n, _ := res.RowsAffected()
		return n > 0, nil
	}
	res, err := q.exec(ctx, `DELETE FROM museum_likes WHERE art_id=? AND user_id=?`, artID, userID)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// LikedArts returns which of these works I liked.
func (q *Queries) LikedArts(ctx context.Context, userID int64, ids []int64) (map[int64]bool, error) {
	out := map[int64]bool{}
	if len(ids) == 0 {
		return out, nil
	}
	list, args := inList(ids)
	rows, err := q.query(ctx, `SELECT art_id FROM museum_likes WHERE user_id=? AND art_id IN `+list, append([]any{userID}, args...)...)
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

// MuseumVote is a vote on a museum change.
type MuseumVote struct {
	ID      int64
	ConvID  int64
	Action  string // JSON (museum package)
	Text    string
	ByUser  int64
	EndsAt  int64
	MediaID int64
	// Filled by VotesOfConv / GetMuseumVote.
	Yes, No int
}

const voteCols = `v.id, v.conv_id, v.action, v.text, v.by_user, v.ends_at, v.media_id,
	(SELECT count(*) FROM museum_ballots b WHERE b.vote_id = v.id AND b.agree=?),
	(SELECT count(*) FROM museum_ballots b WHERE b.vote_id = v.id AND b.agree=?)`

func (q *Queries) votes(ctx context.Context, where string, args ...any) ([]*MuseumVote, error) {
	rows, err := q.query(ctx, `SELECT `+voteCols+` FROM museum_votes v `+where, append([]any{true, false}, args...)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*MuseumVote
	for rows.Next() {
		v := &MuseumVote{}
		if err := rows.Scan(&v.ID, &v.ConvID, &v.Action, &v.Text, &v.ByUser, &v.EndsAt, &v.MediaID, &v.Yes, &v.No); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// InsertMuseumVote starts a vote.
func (q *Queries) InsertMuseumVote(ctx context.Context, v *MuseumVote) error {
	_, err := q.exec(ctx, `INSERT INTO museum_votes (id, conv_id, action, text, by_user, ends_at, media_id) VALUES (?,?,?,?,?,?,?)`,
		v.ID, v.ConvID, v.Action, v.Text, v.ByUser, v.EndsAt, v.MediaID)
	return err
}

// GetMuseumVote returns one vote with its counts.
func (q *Queries) GetMuseumVote(ctx context.Context, id int64) (*MuseumVote, error) {
	list, err := q.votes(ctx, `WHERE v.id=?`, id)
	if err != nil {
		return nil, err
	}
	if len(list) == 0 {
		return nil, ErrNotFound
	}
	return list[0], nil
}

// VotesOfConv returns a channel's open votes, oldest first.
func (q *Queries) VotesOfConv(ctx context.Context, convID int64) ([]*MuseumVote, error) {
	return q.votes(ctx, `WHERE v.conv_id=? ORDER BY v.ends_at`, convID)
}

// EndedMuseumVotes returns votes whose time is up.
func (q *Queries) EndedMuseumVotes(ctx context.Context, now int64) ([]*MuseumVote, error) {
	return q.votes(ctx, `WHERE v.ends_at <= ? ORDER BY v.ends_at`, now)
}

// SetBallot records (or changes) my ballot.
func (q *Queries) SetBallot(ctx context.Context, voteID, userID int64, agree bool) error {
	if _, err := q.exec(ctx, `DELETE FROM museum_ballots WHERE vote_id=? AND user_id=?`, voteID, userID); err != nil {
		return err
	}
	_, err := q.exec(ctx, `INSERT INTO museum_ballots (vote_id, user_id, agree) VALUES (?,?,?)`, voteID, userID, agree)
	return err
}

// MyBallots returns my ballots on these votes (1 agree, -1 against).
func (q *Queries) MyBallots(ctx context.Context, userID int64, ids []int64) (map[int64]int, error) {
	out := map[int64]int{}
	if len(ids) == 0 {
		return out, nil
	}
	list, args := inList(ids)
	rows, err := q.query(ctx, `SELECT vote_id, agree FROM museum_ballots WHERE user_id=? AND vote_id IN `+list, append([]any{userID}, args...)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var agree bool
		if err := rows.Scan(&id, &agree); err != nil {
			return nil, err
		}
		out[id] = map[bool]int{true: 1, false: -1}[agree]
	}
	return out, rows.Err()
}

// DeleteMuseumVote ends a vote.
func (q *Queries) DeleteMuseumVote(ctx context.Context, id int64) error {
	if _, err := q.exec(ctx, `DELETE FROM museum_ballots WHERE vote_id=?`, id); err != nil {
		return err
	}
	_, err := q.exec(ctx, `DELETE FROM museum_votes WHERE id=?`, id)
	return err
}
