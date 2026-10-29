package store

import "context"

// ---- audit log ----

type AuditEntry struct {
	ID        int64
	ActorID   int64
	Action    string
	ConvID    int64
	TargetID  int64
	Detail    string
	CreatedAt int64
}

func (q *Queries) AddAudit(ctx context.Context, a *AuditEntry) error {
	_, err := q.exec(ctx, `INSERT INTO audit_log (id, actor_id, action, conv_id, target_id, detail, created_at)
		VALUES (?,?,?,?,?,?,?)`, a.ID, a.ActorID, a.Action, nullInt(a.ConvID), nullInt(a.TargetID), a.Detail, a.CreatedAt)
	return err
}

func (q *Queries) ListAudit(ctx context.Context, limit int) ([]*AuditEntry, error) {
	rows, err := q.query(ctx, `SELECT id, actor_id, action, COALESCE(conv_id, 0), COALESCE(target_id, 0), detail, created_at
		FROM audit_log ORDER BY created_at DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*AuditEntry
	for rows.Next() {
		a := &AuditEntry{}
		if err := rows.Scan(&a.ID, &a.ActorID, &a.Action, &a.ConvID, &a.TargetID, &a.Detail, &a.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// ---- login records ----

type LoginRecord struct {
	ID         int64
	UserID     int64
	SessionID  int64
	Kind       string // "login" or "register"
	IP         string
	DeviceName string
	CreatedAt  int64
}

func (q *Queries) AddLoginRecord(ctx context.Context, r *LoginRecord) error {
	_, err := q.exec(ctx, `INSERT INTO login_records (id, user_id, session_id, kind, ip, device_name, created_at)
		VALUES (?,?,?,?,?,?,?)`, r.ID, r.UserID, nullInt(r.SessionID), r.Kind, r.IP, r.DeviceName, r.CreatedAt)
	return err
}

func (q *Queries) ListLoginRecords(ctx context.Context, userID int64, limit int) ([]*LoginRecord, error) {
	rows, err := q.query(ctx, `SELECT id, user_id, COALESCE(session_id, 0), kind, ip, device_name, created_at
		FROM login_records WHERE user_id=? ORDER BY created_at DESC LIMIT ?`, userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*LoginRecord
	for rows.Next() {
		r := &LoginRecord{}
		if err := rows.Scan(&r.ID, &r.UserID, &r.SessionID, &r.Kind, &r.IP, &r.DeviceName, &r.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// PurgeLoginRecords deletes records created before `before`.
func (q *Queries) PurgeLoginRecords(ctx context.Context, before int64) (int64, error) {
	res, err := q.exec(ctx, `DELETE FROM login_records WHERE created_at < ?`, before)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
