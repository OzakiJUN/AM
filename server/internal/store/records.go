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

// AuditRow is an audit entry with names resolved, for the admin panel.
type AuditRow struct {
	AuditEntry
	ActorName  string
	TargetName string
	ConvName   string
}

// ListAudit returns audit entries, newest first. actor_id 0 is the admin panel.
func (q *Queries) ListAudit(ctx context.Context, limit, offset int) ([]*AuditRow, int64, error) {
	var total int64
	if err := q.queryRow(ctx, `SELECT count(*) FROM audit_log`).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := q.query(ctx, `SELECT a.id, a.actor_id, a.action, COALESCE(a.conv_id, 0), COALESCE(a.target_id, 0),
		a.detail, a.created_at, COALESCE(u.display_name, ''), COALESCE(t.display_name, ''), COALESCE(c.name, '')
		FROM audit_log a
		LEFT JOIN users u ON u.id = a.actor_id
		LEFT JOIN users t ON t.id = a.target_id
		LEFT JOIN conversations c ON c.id = a.conv_id
		ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var out []*AuditRow
	for rows.Next() {
		a := &AuditRow{}
		if err := rows.Scan(&a.ID, &a.ActorID, &a.Action, &a.ConvID, &a.TargetID, &a.Detail, &a.CreatedAt,
			&a.ActorName, &a.TargetName, &a.ConvName); err != nil {
			return nil, 0, err
		}
		out = append(out, a)
	}
	return out, total, rows.Err()
}

// Stats are the counters on the admin panel's overview page.
type Stats struct {
	Users         int64
	Banned        int64
	Groups        int64
	DMs           int64
	Messages      int64
	MediaBytes    int64
	EvidenceItems int64
}

func (q *Queries) Stats(ctx context.Context, groupKind, dmKind int16) (*Stats, error) {
	s := &Stats{}
	err := q.queryRow(ctx, `SELECT
		(SELECT count(*) FROM users),
		(SELECT count(*) FROM users WHERE banned),
		(SELECT count(*) FROM conversations WHERE kind=? AND NOT dissolved),
		(SELECT count(*) FROM conversations WHERE kind=?),
		(SELECT count(*) FROM events WHERE body_kind < 20),
		(SELECT COALESCE(sum(size), 0) FROM media),
		(SELECT count(*) FROM evidence)`, groupKind, dmKind).
		Scan(&s.Users, &s.Banned, &s.Groups, &s.DMs, &s.Messages, &s.MediaBytes, &s.EvidenceItems)
	return s, err
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
