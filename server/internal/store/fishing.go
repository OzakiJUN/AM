package store

import (
	"context"
	"database/sql"
	"errors"
)

// FishingAccountForUpdate creates an account once, then locks it. Call only in a transaction.
func (q *Queries) FishingAccountForUpdate(ctx context.Context, user int64, initial string) (string, error) {
	if _, err := q.exec(ctx, `INSERT INTO fishing_accounts (user_id,state) VALUES (?,?) ON CONFLICT (user_id) DO NOTHING`, user, initial); err != nil {
		return "", err
	}
	var state string
	err := q.queryRow(ctx, `SELECT state FROM fishing_accounts WHERE user_id=?`+q.forUpdate(), user).Scan(&state)
	return state, err
}
func (q *Queries) FishingAccount(ctx context.Context, user int64) (string, error) {
	var state string
	err := q.queryRow(ctx, `SELECT state FROM fishing_accounts WHERE user_id=?`, user).Scan(&state)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	return state, nil
}
func (q *Queries) SaveFishingAccount(ctx context.Context, user int64, state string) error {
	_, err := q.exec(ctx, `UPDATE fishing_accounts SET state=? WHERE user_id=?`, state, user)
	return err
}

var ErrFishingRequestReuse = errors.New("fishing request id reused with different payload")

// FishingReceipt is called while the player's account row is locked.
func (q *Queries) FishingReceipt(ctx context.Context, user int64, key, hash string) (bool, error) {
	var old string
	err := q.queryRow(ctx, `SELECT fingerprint FROM fishing_actions WHERE user_id=? AND request_id=?`, user, key).Scan(&old)
	if err == nil {
		if old != hash {
			return false, ErrFishingRequestReuse
		}
		return true, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return false, err
	}
	_, err = q.exec(ctx, `INSERT INTO fishing_actions (user_id,request_id,fingerprint) VALUES (?,?,?)`, user, key, hash)
	return false, err
}

// ArchiveFishingCatch preserves a self-caught fish for a future exhibit, even after sale.
func (q *Queries) ArchiveFishingCatch(ctx context.Context, user, fish int64, specimen string) error {
	_, err := q.exec(ctx, `INSERT INTO fishing_catches (user_id,fish_id,specimen) VALUES (?,?,?) ON CONFLICT (user_id,fish_id) DO NOTHING`, user, fish, specimen)
	return err
}
func (q *Queries) FishingExhibits(ctx context.Context, user int64, fish []int64) (map[int64]string, error) {
	out := map[int64]string{}
	if len(fish) == 0 {
		return out, nil
	}
	list, args := inList(fish)
	args = append([]any{user}, args...)
	rows, err := q.query(ctx, `SELECT fish_id,specimen FROM fishing_catches WHERE user_id=? AND fish_id IN `+list, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var data string
		if err := rows.Scan(&id, &data); err != nil {
			return nil, err
		}
		out[id] = data
	}
	return out, rows.Err()
}
