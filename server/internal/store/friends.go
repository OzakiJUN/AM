package store

import (
	"context"
	"errors"
)

const (
	FriendPending  = 0
	FriendAccepted = 1
)

type Friendship struct {
	Requester int64
	Addressee int64
	State     int16
}

// GetFriendship returns the row between two users in either direction.
func (q *Queries) GetFriendship(ctx context.Context, a, b int64) (*Friendship, error) {
	f := &Friendship{}
	err := q.queryRow(ctx, `SELECT requester, addressee, state FROM friendships
		WHERE (requester=? AND addressee=?) OR (requester=? AND addressee=?)`, a, b, b, a).
		Scan(&f.Requester, &f.Addressee, &f.State)
	if err != nil {
		return nil, notFound(err)
	}
	return f, nil
}

func (q *Queries) InsertFriendRequest(ctx context.Context, requester, addressee, now int64) error {
	_, err := q.exec(ctx, `INSERT INTO friendships (requester, addressee, state, created_at, updated_at)
		VALUES (?,?,0,?,?)`, requester, addressee, now, now)
	return err
}

// AcceptFriendRequest turns a pending request into a friendship.
// Returns ErrNotFound if there is no such pending request.
func (q *Queries) AcceptFriendRequest(ctx context.Context, requester, addressee, now int64) error {
	return affected(q.exec(ctx, `UPDATE friendships SET state=1, updated_at=?
		WHERE requester=? AND addressee=? AND state=0`, now, requester, addressee))
}

// ListFriendships returns all rows involving the user.
func (q *Queries) ListFriendships(ctx context.Context, userID int64) ([]*Friendship, error) {
	rows, err := q.query(ctx, `SELECT requester, addressee, state FROM friendships
		WHERE requester=? OR addressee=? ORDER BY updated_at DESC`, userID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Friendship
	for rows.Next() {
		f := &Friendship{}
		if err := rows.Scan(&f.Requester, &f.Addressee, &f.State); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

func (q *Queries) AreFriends(ctx context.Context, a, b int64) (bool, error) {
	f, err := q.GetFriendship(ctx, a, b)
	if errors.Is(err, ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return f.State == FriendAccepted, nil
}
