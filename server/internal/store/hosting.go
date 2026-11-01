package store

import "context"

// AIHosting is an AI hosted (or asked to be hosted) on the server.
type AIHosting struct {
	AIID         int64
	OwnerID      int64
	Status       string // pending | approved | rejected
	Secrets      string // encrypted (hosting package)
	RequestedAt  int64
	DecidedBy    int64
	DecidedAt    int64
	RejectReason string
	// Filled by ListHostingAdmin.
	AIName, OwnerName string
}

const hostingCols = `h.ai_id, h.owner_id, h.status, h.secrets, h.requested_at, COALESCE(h.decided_by, 0), COALESCE(h.decided_at, 0), h.reject_reason`

func scanHosting(r scanner, names bool) (*AIHosting, error) {
	h := &AIHosting{}
	dst := []any{&h.AIID, &h.OwnerID, &h.Status, &h.Secrets, &h.RequestedAt, &h.DecidedBy, &h.DecidedAt, &h.RejectReason}
	if names {
		dst = append(dst, &h.AIName, &h.OwnerName)
	}
	if err := r.Scan(dst...); err != nil {
		return nil, notFound(err)
	}
	return h, nil
}

// GetHosting returns an AI's hosting row.
func (q *Queries) GetHosting(ctx context.Context, aiID int64) (*AIHosting, error) {
	return scanHosting(q.queryRow(ctx, `SELECT `+hostingCols+` FROM ai_hosting h WHERE h.ai_id=?`, aiID), false)
}

// HostingOfOwner returns the hosting rows of someone's AIs.
func (q *Queries) HostingOfOwner(ctx context.Context, ownerID int64) ([]*AIHosting, error) {
	return q.hostings(ctx, false, `FROM ai_hosting h WHERE h.owner_id=? ORDER BY h.requested_at`, ownerID)
}

// ApprovedHosting returns the AIs to run: approved, the AI still on the server.
func (q *Queries) ApprovedHosting(ctx context.Context) ([]*AIHosting, error) {
	return q.hostings(ctx, false, `FROM ai_hosting h JOIN users u ON u.id = h.ai_id
		WHERE h.status='approved' AND u.banned=? AND u.left_at IS NULL ORDER BY h.ai_id`, false)
}

// ListHostingAdmin lists hosting rows for the panel ("" = every status), newest first.
func (q *Queries) ListHostingAdmin(ctx context.Context, status string) ([]*AIHosting, error) {
	where, args := ``, []any{}
	if status != "" {
		where, args = `WHERE h.status=?`, []any{status}
	}
	return q.hostings(ctx, true, `, COALESCE(a.display_name, ''), COALESCE(o.display_name, '')
		FROM ai_hosting h LEFT JOIN users a ON a.id = h.ai_id LEFT JOIN users o ON o.id = h.owner_id `+where+`
		ORDER BY h.requested_at DESC LIMIT 500`, args...)
}

func (q *Queries) hostings(ctx context.Context, names bool, rest string, args ...any) ([]*AIHosting, error) {
	rows, err := q.query(ctx, `SELECT `+hostingCols+` `+rest, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*AIHosting
	for rows.Next() {
		h, err := scanHosting(rows, names)
		if err != nil {
			return nil, err
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

// PutHosting adds or replaces an AI's hosting request.
func (q *Queries) PutHosting(ctx context.Context, h *AIHosting) error {
	if _, err := q.exec(ctx, `DELETE FROM ai_hosting WHERE ai_id=?`, h.AIID); err != nil {
		return err
	}
	_, err := q.exec(ctx, `INSERT INTO ai_hosting (ai_id, owner_id, status, secrets, requested_at, decided_by, decided_at, reject_reason)
		VALUES (?,?,?,?,?,?,?,?)`, h.AIID, h.OwnerID, h.Status, h.Secrets, h.RequestedAt, nullInt(h.DecidedBy), nullInt(h.DecidedAt), h.RejectReason)
	return err
}

// DecideHosting approves or rejects a request.
func (q *Queries) DecideHosting(ctx context.Context, aiID int64, status string, by int64, reason string, at int64) error {
	res, err := q.exec(ctx, `UPDATE ai_hosting SET status=?, decided_by=?, decided_at=?, reject_reason=? WHERE ai_id=?`, status, by, at, reason, aiID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// DeleteHosting ends hosting for an AI.
func (q *Queries) DeleteHosting(ctx context.Context, aiID int64) error {
	_, err := q.exec(ctx, `DELETE FROM ai_hosting WHERE ai_id=?`, aiID)
	return err
}

// CountPendingHosting is the panel's badge.
func (q *Queries) CountPendingHosting(ctx context.Context) (int, error) {
	var n int
	err := q.queryRow(ctx, `SELECT count(*) FROM ai_hosting WHERE status='pending'`).Scan(&n)
	return n, err
}
