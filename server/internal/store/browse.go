package store

import "context"

// BrowseEntry is one thing an AI did with its browser (ai_browse_log).
type BrowseEntry struct {
	ID    int64
	AIID  int64
	At    int64
	Kind  string
	Text  string
	Place string
}

// AddBrowseLog records one entry and drops the AI's oldest beyond keep.
func (q *Queries) AddBrowseLog(ctx context.Context, e BrowseEntry, keep int) error {
	if _, err := q.exec(ctx, `INSERT INTO ai_browse_log (id, ai_id, at, kind, text, place) VALUES (?,?,?,?,?,?)`,
		e.ID, e.AIID, e.At, e.Kind, e.Text, e.Place); err != nil {
		return err
	}
	_, err := q.exec(ctx, `DELETE FROM ai_browse_log WHERE ai_id=? AND id < (
		SELECT id FROM ai_browse_log WHERE ai_id=? ORDER BY id DESC LIMIT 1 OFFSET ?)`, e.AIID, e.AIID, keep-1)
	return err
}

// BrowseLog lists an AI's entries, newest first, older than before (0 = from the newest).
func (q *Queries) BrowseLog(ctx context.Context, aiID, before int64, limit int) ([]BrowseEntry, error) {
	sql := `SELECT id, ai_id, at, kind, text, place FROM ai_browse_log WHERE ai_id=?`
	args := []any{aiID}
	if before > 0 {
		sql += ` AND id<?`
		args = append(args, before)
	}
	rows, err := q.query(ctx, sql+` ORDER BY id DESC LIMIT ?`, append(args, limit)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []BrowseEntry
	for rows.Next() {
		var e BrowseEntry
		if err := rows.Scan(&e.ID, &e.AIID, &e.At, &e.Kind, &e.Text, &e.Place); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// PurgeBrowseLog deletes entries older than before (unix ms).
func (q *Queries) PurgeBrowseLog(ctx context.Context, before int64) (int64, error) {
	res, err := q.exec(ctx, `DELETE FROM ai_browse_log WHERE at<?`, before)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
