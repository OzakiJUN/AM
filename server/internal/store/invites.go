package store

import "context"

type Invite struct {
	Code       string
	CreatedBy  int64
	UsedBy     int64
	UsedByName string
	CreatedAt  int64
}

func (q *Queries) CreateInvite(ctx context.Context, code string, createdBy int64, now int64) error {
	var creator any
	if createdBy != 0 {
		creator = createdBy
	}
	_, err := q.db.Exec(ctx, `INSERT INTO invite_codes (code, created_by, created_at) VALUES ($1,$2,$3)`, code, creator, now)
	return err
}

// LockUnusedInvite locks an unused invite row until the transaction ends.
// CreatedBy = 0 means a bootstrap code. Must run inside a transaction.
func (q *Queries) LockUnusedInvite(ctx context.Context, code string) (*Invite, error) {
	inv := &Invite{Code: code}
	err := q.db.QueryRow(ctx, `SELECT COALESCE(created_by, 0), created_at FROM invite_codes
		WHERE code=$1 AND used_by IS NULL FOR UPDATE`, code).Scan(&inv.CreatedBy, &inv.CreatedAt)
	if err != nil {
		return nil, notFound(err)
	}
	return inv, nil
}

func (q *Queries) MarkInviteUsed(ctx context.Context, code string, userID, now int64) error {
	_, err := q.db.Exec(ctx, `UPDATE invite_codes SET used_by=$2, used_at=$3 WHERE code=$1`, code, userID, now)
	return err
}

func (q *Queries) CountInvitesBy(ctx context.Context, userID int64) (int, error) {
	var n int
	err := q.db.QueryRow(ctx, `SELECT count(*) FROM invite_codes WHERE created_by=$1`, userID).Scan(&n)
	return n, err
}

func (q *Queries) ListInvitesBy(ctx context.Context, userID int64) ([]*Invite, error) {
	rows, err := q.db.Query(ctx, `SELECT i.code, COALESCE(i.created_by, 0), COALESCE(i.used_by, 0),
		COALESCE(u.display_name, ''), i.created_at
		FROM invite_codes i LEFT JOIN users u ON u.id = i.used_by
		WHERE i.created_by=$1 ORDER BY i.created_at`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Invite
	for rows.Next() {
		inv := &Invite{}
		if err := rows.Scan(&inv.Code, &inv.CreatedBy, &inv.UsedBy, &inv.UsedByName, &inv.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, inv)
	}
	return out, rows.Err()
}

// UnusedBootstrapInvite returns an unused bootstrap code, or ErrNotFound.
func (q *Queries) UnusedBootstrapInvite(ctx context.Context) (string, error) {
	var code string
	err := q.db.QueryRow(ctx, `SELECT code FROM invite_codes WHERE created_by IS NULL AND used_by IS NULL LIMIT 1`).Scan(&code)
	return code, notFound(err)
}
