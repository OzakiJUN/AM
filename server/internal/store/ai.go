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
