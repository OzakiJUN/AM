package store

import (
	"context"
	"database/sql"
	"errors"
)

// ListOwnedAI returns the AI / bot accounts of an owner that are still on
// the server, oldest first.
func (q *Queries) ListOwnedAI(ctx context.Context, ownerID int64) ([]*User, error) {
	rows, err := q.query(ctx, `SELECT `+userCols+` FROM users WHERE owner_id=? AND left_at IS NULL ORDER BY created_at, id`, ownerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*User
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

// GetAISettings returns an AI's settings JSON ("" and 0 when none yet).
func (q *Queries) GetAISettings(ctx context.Context, userID int64) (data string, updatedAt int64, err error) {
	err = q.queryRow(ctx, `SELECT data, updated_at FROM ai_settings WHERE user_id=?`+q.forUpdate(), userID).Scan(&data, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return "", 0, nil
	}
	return data, updatedAt, err
}

// PutAISettings replaces an AI's settings JSON.
func (q *Queries) PutAISettings(ctx context.Context, userID int64, data string, now int64) error {
	_, err := q.exec(ctx, `INSERT INTO ai_settings (user_id, data, updated_at) VALUES (?,?,?)
		ON CONFLICT (user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`, userID, data, now)
	return err
}

// PortraitPack returns a bot / AI's portrait pack: mood -> media id.
func (q *Queries) PortraitPack(ctx context.Context, userID int64) (map[string]int64, error) {
	rows, err := q.query(ctx, `SELECT mood, media_id FROM portrait_packs WHERE user_id=?`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int64{}
	for rows.Next() {
		var mood string
		var id int64
		if err := rows.Scan(&mood, &id); err != nil {
			return nil, err
		}
		out[mood] = id
	}
	return out, rows.Err()
}

// SetPortraitPack replaces a pack (empty = none) and stamps users.portraits_at.
func (q *Queries) SetPortraitPack(ctx context.Context, userID int64, pack map[string]int64, now int64) error {
	if _, err := q.exec(ctx, `DELETE FROM portrait_packs WHERE user_id=?`, userID); err != nil {
		return err
	}
	for mood, id := range pack {
		if _, err := q.exec(ctx, `INSERT INTO portrait_packs (user_id, mood, media_id) VALUES (?,?,?)`, userID, mood, id); err != nil {
			return err
		}
	}
	stamp := now
	if len(pack) == 0 {
		stamp = 0
	}
	_, err := q.exec(ctx, `UPDATE users SET portraits_at=? WHERE id=?`, stamp, userID)
	return err
}

// AddShareRequest records someone asking to talk with an AI (again = no-op).
func (q *Queries) AddShareRequest(ctx context.Context, aiID, userID, now int64) error {
	_, err := q.exec(ctx, `INSERT INTO ai_share_requests (ai_id, user_id, created_at) VALUES (?,?,?)
		ON CONFLICT (ai_id, user_id) DO NOTHING`, aiID, userID, now)
	return err
}

// ShareRequests lists who asked to talk with an AI, oldest first.
func (q *Queries) ShareRequests(ctx context.Context, aiID int64) ([]int64, error) {
	rows, err := q.query(ctx, `SELECT user_id FROM ai_share_requests WHERE ai_id=? ORDER BY created_at, user_id`, aiID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// DeleteShareRequest removes one request (answered either way).
func (q *Queries) DeleteShareRequest(ctx context.Context, aiID, userID int64) (bool, error) {
	r, err := q.exec(ctx, `DELETE FROM ai_share_requests WHERE ai_id=? AND user_id=?`, aiID, userID)
	if err != nil {
		return false, err
	}
	n, _ := r.RowsAffected()
	return n > 0, nil
}

// AIRoom returns the id of an AI's shared room, 0 if it has none.
func (q *Queries) AIRoom(ctx context.Context, aiID int64) (int64, error) {
	var id int64
	err := q.queryRow(ctx, `SELECT id FROM conversations WHERE ai_id=? AND dissolved=? ORDER BY created_at LIMIT 1`, aiID, false).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return id, err
}
