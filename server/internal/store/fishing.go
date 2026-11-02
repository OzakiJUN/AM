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

func (q *Queries) ActiveFishingGames(ctx context.Context) ([]*Game, error) {
	rows, err := q.query(ctx, `SELECT `+gameCols+` FROM games WHERE kind='fishing' AND status='playing' ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var games []*Game
	for rows.Next() {
		g, err := scanGame(rows)
		if err != nil {
			return nil, err
		}
		games = append(games, g)
	}
	return games, rows.Err()
}

func (q *Queries) FishingReceipts(ctx context.Context, user int64) (map[string]string, error) {
	rows, err := q.query(ctx, `SELECT request_id,fingerprint FROM fishing_actions WHERE user_id=?`, user)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var key, hash string
		if err := rows.Scan(&key, &hash); err != nil {
			return nil, err
		}
		out[key] = hash
	}
	return out, rows.Err()
}
