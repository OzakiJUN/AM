package store

import "context"

type Session struct {
	ID         int64
	UserID     int64
	DeviceName string
	CreatedAt  int64
	LastSeen   int64
}

func (q *Queries) CreateSession(ctx context.Context, s *Session, tokenHash []byte) error {
	_, err := q.db.Exec(ctx, `INSERT INTO sessions (id, user_id, token_hash, device_name, created_at, last_seen)
		VALUES ($1,$2,$3,$4,$5,$6)`, s.ID, s.UserID, tokenHash, s.DeviceName, s.CreatedAt, s.LastSeen)
	return err
}

// GetSessionByTokenHash returns the session and its user.
func (q *Queries) GetSessionByTokenHash(ctx context.Context, tokenHash []byte) (*Session, *User, error) {
	s := &Session{}
	u := &User{}
	err := q.db.QueryRow(ctx, `SELECT s.id, s.user_id, s.device_name, s.created_at, s.last_seen,
		u.id, u.username, u.display_name, u.avatar, COALESCE(u.password_hash, ''), u.account_type,
		COALESCE(u.owner_id, 0), u.is_site_admin, u.banned, u.created_at
		FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1`, tokenHash).
		Scan(&s.ID, &s.UserID, &s.DeviceName, &s.CreatedAt, &s.LastSeen,
			&u.ID, &u.Username, &u.DisplayName, &u.Avatar, &u.PasswordHash, &u.AccountType,
			&u.OwnerID, &u.IsSiteAdmin, &u.Banned, &u.CreatedAt)
	if err != nil {
		return nil, nil, notFound(err)
	}
	return s, u, nil
}

func (q *Queries) TouchSession(ctx context.Context, id, now int64) error {
	_, err := q.db.Exec(ctx, `UPDATE sessions SET last_seen=$2 WHERE id=$1`, id, now)
	return err
}

func (q *Queries) ListSessions(ctx context.Context, userID int64) ([]*Session, error) {
	rows, err := q.db.Query(ctx, `SELECT id, user_id, device_name, created_at, last_seen
		FROM sessions WHERE user_id=$1 ORDER BY last_seen DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Session
	for rows.Next() {
		s := &Session{}
		if err := rows.Scan(&s.ID, &s.UserID, &s.DeviceName, &s.CreatedAt, &s.LastSeen); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// DeleteSession deletes one of the user's sessions. Returns ErrNotFound if
// it does not exist or belongs to someone else.
func (q *Queries) DeleteSession(ctx context.Context, userID, sessionID int64) error {
	tag, err := q.db.Exec(ctx, `DELETE FROM sessions WHERE id=$1 AND user_id=$2`, sessionID, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
