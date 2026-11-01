package store

import (
	"context"
	"encoding/json"
	"errors"
)

// NewsSub is a keyword a conversation follows (游戏资讯).
type NewsSub struct {
	ConvID      int64
	Keyword     string
	Alias       []string
	ManualSteam int64
	CreatedBy   int64
	CreatedAt   int64
}

// NewsSubs returns every subscription (convID 0) or one conversation's, oldest first.
func (q *Queries) NewsSubs(ctx context.Context, convID int64) ([]*NewsSub, error) {
	where, args := "", []any{}
	if convID != 0 {
		where, args = ` WHERE conv_id=?`, []any{convID}
	}
	rows, err := q.query(ctx, `SELECT conv_id, kw, alias, manual_steam, created_by, created_at FROM news_subs`+where+` ORDER BY created_at, kw`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*NewsSub
	for rows.Next() {
		s := &NewsSub{}
		var alias string
		if err := rows.Scan(&s.ConvID, &s.Keyword, &alias, &s.ManualSteam, &s.CreatedBy, &s.CreatedAt); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(alias), &s.Alias)
		out = append(out, s)
	}
	return out, rows.Err()
}

// PutNewsSub adds a subscription or replaces its aliases / Steam id.
func (q *Queries) PutNewsSub(ctx context.Context, s *NewsSub) error {
	alias, _ := json.Marshal(append([]string{}, s.Alias...))
	_, err := q.exec(ctx, `INSERT INTO news_subs (conv_id, kw, alias, manual_steam, created_by, created_at) VALUES (?,?,?,?,?,?)
		ON CONFLICT (conv_id, kw) DO UPDATE SET alias = excluded.alias, manual_steam = excluded.manual_steam`,
		s.ConvID, s.Keyword, string(alias), s.ManualSteam, s.CreatedBy, s.CreatedAt)
	return err
}

// DeleteNewsSub removes one subscription.
func (q *Queries) DeleteNewsSub(ctx context.Context, convID int64, kw string) error {
	_, err := q.exec(ctx, `DELETE FROM news_subs WHERE conv_id=? AND kw=?`, convID, kw)
	return err
}

// NewsState returns a piece of the news feature's state ("" when not saved yet).
func (q *Queries) NewsState(ctx context.Context, name string) (string, error) {
	var data string
	err := q.queryRow(ctx, `SELECT data FROM news_state WHERE name=?`, name).Scan(&data)
	if errors.Is(notFound(err), ErrNotFound) {
		return "", nil
	}
	return data, err
}

// SetNewsState saves a piece of the news feature's state.
func (q *Queries) SetNewsState(ctx context.Context, name, data string, at int64) error {
	_, err := q.exec(ctx, `INSERT INTO news_state (name, data, updated_at) VALUES (?,?,?)
		ON CONFLICT (name) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`, name, data, at)
	return err
}
