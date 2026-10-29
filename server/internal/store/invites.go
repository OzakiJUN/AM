package store

import "context"

type Invite struct {
	Code          string
	CreatedBy     int64 // 0 = bootstrap or admin panel
	CreatedByName string
	UsedBy        int64
	UsedByName    string
	MakesAdmin    bool
	Note          string
	CreatedAt     int64
	UsedAt        int64
}

const inviteCols = `i.code, COALESCE(i.created_by, 0), COALESCE(c.display_name, ''), COALESCE(i.used_by, 0),
	COALESCE(u.display_name, ''), i.makes_admin, i.note, i.created_at, COALESCE(i.used_at, 0)`

const inviteFrom = ` FROM invite_codes i
	LEFT JOIN users c ON c.id = i.created_by
	LEFT JOIN users u ON u.id = i.used_by`

func scanInvites(rows interface {
	Next() bool
	Scan(...any) error
	Err() error
}) ([]*Invite, error) {
	var out []*Invite
	for rows.Next() {
		inv := &Invite{}
		if err := rows.Scan(&inv.Code, &inv.CreatedBy, &inv.CreatedByName, &inv.UsedBy, &inv.UsedByName,
			&inv.MakesAdmin, &inv.Note, &inv.CreatedAt, &inv.UsedAt); err != nil {
			return nil, err
		}
		out = append(out, inv)
	}
	return out, rows.Err()
}

// CreateInvite stores a new code. createdBy = 0 for bootstrap / panel codes.
func (q *Queries) CreateInvite(ctx context.Context, inv *Invite) error {
	_, err := q.exec(ctx, `INSERT INTO invite_codes (code, created_by, makes_admin, note, created_at) VALUES (?,?,?,?,?)`,
		inv.Code, nullInt(inv.CreatedBy), inv.MakesAdmin, inv.Note, inv.CreatedAt)
	return err
}

// LockUnusedInvite locks an unused invite row until the transaction ends.
// Must run inside a transaction.
func (q *Queries) LockUnusedInvite(ctx context.Context, code string) (*Invite, error) {
	inv := &Invite{Code: code}
	err := q.queryRow(ctx, `SELECT COALESCE(created_by, 0), makes_admin, created_at FROM invite_codes
		WHERE code=? AND used_by IS NULL`+q.forUpdate(), code).Scan(&inv.CreatedBy, &inv.MakesAdmin, &inv.CreatedAt)
	if err != nil {
		return nil, notFound(err)
	}
	return inv, nil
}

func (q *Queries) MarkInviteUsed(ctx context.Context, code string, userID, now int64) error {
	_, err := q.exec(ctx, `UPDATE invite_codes SET used_by=?, used_at=? WHERE code=?`, userID, now, code)
	return err
}

func (q *Queries) CountInvitesBy(ctx context.Context, userID int64) (int, error) {
	var n int
	err := q.queryRow(ctx, `SELECT count(*) FROM invite_codes WHERE created_by=?`, userID).Scan(&n)
	return n, err
}

func (q *Queries) ListInvitesBy(ctx context.Context, userID int64) ([]*Invite, error) {
	rows, err := q.query(ctx, `SELECT `+inviteCols+inviteFrom+` WHERE i.created_by=? ORDER BY i.created_at`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanInvites(rows)
}

// ListAllInvites returns every invite code, newest first (admin panel).
// unusedOnly limits the list to codes nobody has used yet.
func (q *Queries) ListAllInvites(ctx context.Context, unusedOnly bool, limit, offset int) ([]*Invite, error) {
	where := ""
	if unusedOnly {
		where = ` WHERE i.used_by IS NULL`
	}
	rows, err := q.query(ctx, `SELECT `+inviteCols+inviteFrom+where+` ORDER BY i.created_at DESC LIMIT ? OFFSET ?`,
		limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanInvites(rows)
}

// DeleteUnusedInvite removes a code nobody has used. ErrNotFound if it does
// not exist or was already used (used codes stay as registration records).
func (q *Queries) DeleteUnusedInvite(ctx context.Context, code string) error {
	return affected(q.exec(ctx, `DELETE FROM invite_codes WHERE code=? AND used_by IS NULL`, code))
}

// UnusedBootstrapInvite returns an unused bootstrap code, or ErrNotFound.
func (q *Queries) UnusedBootstrapInvite(ctx context.Context) (string, error) {
	var code string
	err := q.queryRow(ctx, `SELECT code FROM invite_codes
		WHERE created_by IS NULL AND makes_admin AND used_by IS NULL LIMIT 1`).Scan(&code)
	return code, notFound(err)
}
