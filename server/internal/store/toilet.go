package store

import "context"

// ToiletPit is a picture in the 电子厕所.
type ToiletPit struct {
	ID        int64
	MediaID   int64
	Title     string
	CulpritID int64 // who made it (0 = unknown)
	ByUser    int64 // who threw it in
	ConvID    int64
	NSFW      bool
	CreatedAt int64
}

// ToiletPits returns the pits, newest (pit 1) first.
func (q *Queries) ToiletPits(ctx context.Context) ([]*ToiletPit, error) {
	rows, err := q.query(ctx, `SELECT id, media_id, title, culprit_id, by_user, conv_id, nsfw, created_at
		FROM toilet_pits ORDER BY created_at DESC, id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*ToiletPit
	for rows.Next() {
		p := &ToiletPit{}
		if err := rows.Scan(&p.ID, &p.MediaID, &p.Title, &p.CulpritID, &p.ByUser, &p.ConvID, &p.NSFW, &p.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// InsertToiletPit throws a picture in.
func (q *Queries) InsertToiletPit(ctx context.Context, p *ToiletPit) error {
	_, err := q.exec(ctx, `INSERT INTO toilet_pits (id, media_id, title, culprit_id, by_user, conv_id, nsfw, created_at) VALUES (?,?,?,?,?,?,?,?)`,
		p.ID, p.MediaID, p.Title, p.CulpritID, p.ByUser, p.ConvID, p.NSFW, p.CreatedAt)
	return err
}

// DeleteToiletPit flushes one.
func (q *Queries) DeleteToiletPit(ctx context.Context, id int64) error {
	_, err := q.exec(ctx, `DELETE FROM toilet_pits WHERE id=?`, id)
	return err
}
