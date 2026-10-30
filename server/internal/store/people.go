package store

import "context"

// ListUsers pages through accounts that are not banned and have not left, ordered by id.
// search matches username or display name (case-insensitive for ASCII).
func (q *Queries) ListUsers(ctx context.Context, search string, after int64, limit int) ([]*User, error) {
	where := ` WHERE NOT banned AND left_at IS NULL AND id > ?`
	args := []any{after}
	if search != "" {
		where += ` AND (lower(username) LIKE ? ESCAPE '\' OR lower(display_name) LIKE ? ESCAPE '\')`
		pat := "%" + escapeLike(toLower(search)) + "%"
		args = append(args, pat, pat)
	}
	rows, err := q.query(ctx, `SELECT `+userCols+` FROM users`+where+` ORDER BY id LIMIT ?`, append(args, limit)...)
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

// ---- blocks ----

func (q *Queries) AddBlock(ctx context.Context, userID, targetID, now int64) error {
	_, err := q.exec(ctx, `INSERT INTO blocks (user_id, target_id, created_at) VALUES (?,?,?)`, userID, targetID, now)
	if IsUniqueViolation(err) {
		return nil // already blocked
	}
	return err
}

func (q *Queries) RemoveBlock(ctx context.Context, userID, targetID int64) error {
	_, err := q.exec(ctx, `DELETE FROM blocks WHERE user_id=? AND target_id=?`, userID, targetID)
	return err
}

// BlockedIDs returns the users userID has blocked, newest first.
func (q *Queries) BlockedIDs(ctx context.Context, userID int64) ([]int64, error) {
	rows, err := q.query(ctx, `SELECT target_id FROM blocks WHERE user_id=? ORDER BY created_at DESC`, userID)
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

// BlockedEither reports whether a blocked b or b blocked a.
func (q *Queries) BlockedEither(ctx context.Context, a, b int64) (bool, error) {
	var n int
	err := q.queryRow(ctx, `SELECT count(*) FROM blocks
		WHERE (user_id=? AND target_id=?) OR (user_id=? AND target_id=?)`, a, b, b, a).Scan(&n)
	return n > 0, err
}

// DMPeer returns the other member of a DM.
func (q *Queries) DMPeer(ctx context.Context, convID, me int64) (int64, error) {
	var id int64
	err := q.queryRow(ctx, `SELECT user_id FROM conv_members WHERE conv_id=? AND user_id<>? LIMIT 1`, convID, me).Scan(&id)
	return id, notFound(err)
}
