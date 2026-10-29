package store

import "context"

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
	err := q.db.QueryRow(ctx, `SELECT requester, addressee, state FROM friendships
		WHERE (requester=$1 AND addressee=$2) OR (requester=$2 AND addressee=$1)`, a, b).
		Scan(&f.Requester, &f.Addressee, &f.State)
	if err != nil {
		return nil, notFound(err)
	}
	return f, nil
}

func (q *Queries) InsertFriendRequest(ctx context.Context, requester, addressee, now int64) error {
	_, err := q.db.Exec(ctx, `INSERT INTO friendships (requester, addressee, state, created_at, updated_at)
		VALUES ($1,$2,0,$3,$3)`, requester, addressee, now)
	return err
}

// AcceptFriendRequest turns a pending request into a friendship.
// Returns ErrNotFound if there is no such pending request.
func (q *Queries) AcceptFriendRequest(ctx context.Context, requester, addressee, now int64) error {
	tag, err := q.db.Exec(ctx, `UPDATE friendships SET state=1, updated_at=$3
		WHERE requester=$1 AND addressee=$2 AND state=0`, requester, addressee, now)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// ListFriendships returns all rows involving the user.
func (q *Queries) ListFriendships(ctx context.Context, userID int64) ([]*Friendship, error) {
	rows, err := q.db.Query(ctx, `SELECT requester, addressee, state FROM friendships
		WHERE requester=$1 OR addressee=$1 ORDER BY updated_at DESC`, userID)
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
	if err == ErrNotFound {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return f.State == FriendAccepted, nil
}
