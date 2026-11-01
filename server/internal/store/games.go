package store

import (
	"context"
	"database/sql"
	"errors"
)

// Game is one board game; State is the game package's JSON document.
type Game struct {
	ID        int64
	ConvID    int64
	Kind      string
	HostID    int64
	Status    string
	State     string
	CreatedAt int64
	UpdatedAt int64
}

const gameCols = `id, conv_id, kind, host_id, status, state, created_at, updated_at`

func scanGame(r interface{ Scan(...any) error }) (*Game, error) {
	var g Game
	if err := r.Scan(&g.ID, &g.ConvID, &g.Kind, &g.HostID, &g.Status, &g.State, &g.CreatedAt, &g.UpdatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return &g, nil
}

func (q *Queries) CreateGame(ctx context.Context, g *Game) error {
	_, err := q.exec(ctx, `INSERT INTO games (`+gameCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		g.ID, g.ConvID, g.Kind, g.HostID, g.Status, g.State, g.CreatedAt, g.UpdatedAt)
	return err
}

func (q *Queries) GetGame(ctx context.Context, id int64) (*Game, error) {
	return scanGame(q.queryRow(ctx, `SELECT `+gameCols+` FROM games WHERE id=?`, id))
}

// GetGameForUpdate reads a game and locks its row until the transaction ends.
func (q *Queries) GetGameForUpdate(ctx context.Context, id int64) (*Game, error) {
	return scanGame(q.queryRow(ctx, `SELECT `+gameCols+` FROM games WHERE id=?`+q.forUpdate(), id))
}

func (q *Queries) SaveGame(ctx context.Context, g *Game) error {
	_, err := q.exec(ctx, `UPDATE games SET status=?, state=?, updated_at=? WHERE id=?`, g.Status, g.State, g.UpdatedAt, g.ID)
	return err
}

// ListGames returns a conversation's open and running games, and those
// that ended after `endedSince`, newest first.
func (q *Queries) ListGames(ctx context.Context, convID, endedSince int64) ([]*Game, error) {
	rows, err := q.query(ctx, `SELECT `+gameCols+` FROM games WHERE conv_id=? AND (status<>'ended' OR updated_at>=?)
		ORDER BY created_at DESC, id DESC LIMIT 50`, convID, endedSince)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Game
	for rows.Next() {
		g, err := scanGame(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

// EndedGames returns a conversation's finished games that ended before `before`, newest first.
func (q *Queries) EndedGames(ctx context.Context, convID, before int64, limit int) ([]*Game, error) {
	rows, err := q.query(ctx, `SELECT `+gameCols+` FROM games WHERE conv_id=? AND status='ended' AND updated_at<?
		ORDER BY updated_at DESC, id DESC LIMIT ?`, convID, before, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Game
	for rows.Next() {
		g, err := scanGame(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

// CountActiveGames counts a conversation's games that have not ended.
func (q *Queries) CountActiveGames(ctx context.Context, convID int64) (int, error) {
	var n int
	err := q.queryRow(ctx, `SELECT count(*) FROM games WHERE conv_id=? AND status<>'ended'`, convID).Scan(&n)
	return n, err
}

// DeleteEndedGames removes games that ended before `before` (janitor).
func (q *Queries) DeleteEndedGames(ctx context.Context, before int64) (int64, error) {
	res, err := q.exec(ctx, `DELETE FROM games WHERE status='ended' AND updated_at<?`, before)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
