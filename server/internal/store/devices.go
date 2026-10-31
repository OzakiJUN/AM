package store

import (
	"context"
	"database/sql"
	"errors"
)

// CountSessions returns how many devices the user is logged in on.
func (q *Queries) CountSessions(ctx context.Context, userID int64) (int, error) {
	var n int
	err := q.queryRow(ctx, `SELECT COUNT(*) FROM sessions WHERE user_id=?`, userID).Scan(&n)
	return n, err
}

// PairTicket is a one-time ticket for logging in a new device.
type PairTicket struct {
	UserID    int64
	Bundle    []byte
	CreatedAt int64
	ExpiresAt int64
}

// ReplacePairTicket stores a new ticket for the user; older ones stop working.
func (q *Queries) ReplacePairTicket(ctx context.Context, hash []byte, t *PairTicket) error {
	if _, err := q.exec(ctx, `DELETE FROM pair_tickets WHERE user_id=?`, t.UserID); err != nil {
		return err
	}
	_, err := q.exec(ctx, `INSERT INTO pair_tickets (ticket_hash, user_id, bundle, created_at, expires_at)
		VALUES (?,?,?,?,?)`, hash, t.UserID, t.Bundle, t.CreatedAt, t.ExpiresAt)
	return err
}

// TakePairTicket uses up a ticket. ErrNotFound if it does not exist or has
// expired (an expired one is removed too).
func (q *Queries) TakePairTicket(ctx context.Context, hash []byte, now int64) (*PairTicket, error) {
	t := &PairTicket{}
	err := q.queryRow(ctx, `SELECT user_id, bundle, created_at, expires_at FROM pair_tickets
		WHERE ticket_hash=?`+q.forUpdate(), hash).Scan(&t.UserID, &t.Bundle, &t.CreatedAt, &t.ExpiresAt)
	if err != nil {
		return nil, notFound(err)
	}
	if _, err := q.exec(ctx, `DELETE FROM pair_tickets WHERE ticket_hash=?`, hash); err != nil {
		return nil, err
	}
	if t.ExpiresAt <= now {
		return nil, ErrNotFound
	}
	return t, nil
}

// DeleteUserPairTickets removes the user's unused tickets.
func (q *Queries) DeleteUserPairTickets(ctx context.Context, userID int64) error {
	_, err := q.exec(ctx, `DELETE FROM pair_tickets WHERE user_id=?`, userID)
	return err
}

// PurgePairTickets removes expired tickets.
func (q *Queries) PurgePairTickets(ctx context.Context, now int64) (int64, error) {
	res, err := q.exec(ctx, `DELETE FROM pair_tickets WHERE expires_at <= ?`, now)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// GetClientState returns the user's encrypted device state; updatedAt is 0
// when there is none.
func (q *Queries) GetClientState(ctx context.Context, userID int64) (data []byte, updatedAt int64, err error) {
	err = q.queryRow(ctx, `SELECT data, updated_at FROM client_states WHERE user_id=?`+q.forUpdate(), userID).Scan(&data, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, 0, nil
	}
	return data, updatedAt, err
}

// PutClientState replaces the user's encrypted device state.
func (q *Queries) PutClientState(ctx context.Context, userID int64, data []byte, now int64) error {
	_, err := q.exec(ctx, `INSERT INTO client_states (user_id, data, updated_at) VALUES (?,?,?)
		ON CONFLICT (user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`, userID, data, now)
	return err
}

// DeleteClientState removes the user's device state (leaving the server).
func (q *Queries) DeleteClientState(ctx context.Context, userID int64) error {
	_, err := q.exec(ctx, `DELETE FROM client_states WHERE user_id=?`, userID)
	return err
}
