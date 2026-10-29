package store

import "context"

type Event struct {
	EventID       int64
	ConvID        int64
	Seq           int64
	SenderID      int64
	ClientMsgID   string
	BodyKind      int16
	TargetEventID int64
	MediaID       int64
	Payload       []byte
	RedactedBy    int64
	RedactReason  string
	RedactedAt    int64
	CreatedAt     int64
}

const eventCols = `event_id, conv_id, seq, sender_id, client_msg_id, body_kind, COALESCE(target_event_id, 0),
	COALESCE(media_id, 0), payload, COALESCE(redacted_by, 0), COALESCE(redact_reason, ''), COALESCE(redacted_at, 0), created_at`

func scanEvent(row scanner) (*Event, error) {
	e := &Event{}
	err := row.Scan(&e.EventID, &e.ConvID, &e.Seq, &e.SenderID, &e.ClientMsgID, &e.BodyKind, &e.TargetEventID,
		&e.MediaID, &e.Payload, &e.RedactedBy, &e.RedactReason, &e.RedactedAt, &e.CreatedAt)
	if err != nil {
		return nil, notFound(err)
	}
	return e, nil
}

// AppendEvent takes the next seq of the conversation and inserts the event.
// Must run inside a transaction: the conversation row stays locked until
// commit (PostgreSQL) or the whole database is (SQLite), so seqs are
// assigned one at a time with no gaps. e.Seq is filled in.
func (q *Queries) AppendEvent(ctx context.Context, e *Event) error {
	if err := q.queryRow(ctx, `UPDATE conversations SET last_seq = last_seq + 1 WHERE id=? RETURNING last_seq`,
		e.ConvID).Scan(&e.Seq); err != nil {
		return notFound(err)
	}
	_, err := q.exec(ctx, `INSERT INTO events (event_id, conv_id, seq, sender_id, client_msg_id, body_kind,
		target_event_id, media_id, payload, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
		e.EventID, e.ConvID, e.Seq, e.SenderID, e.ClientMsgID, e.BodyKind, nullInt(e.TargetEventID),
		nullInt(e.MediaID), e.Payload, e.CreatedAt)
	return err
}

func (q *Queries) GetEvent(ctx context.Context, eventID int64) (*Event, error) {
	return scanEvent(q.queryRow(ctx, `SELECT `+eventCols+` FROM events WHERE event_id=?`, eventID))
}

func (q *Queries) GetEventByClientMsgID(ctx context.Context, senderID int64, clientMsgID string) (*Event, error) {
	return scanEvent(q.queryRow(ctx, `SELECT `+eventCols+` FROM events WHERE sender_id=? AND client_msg_id=?`,
		senderID, clientMsgID))
}

// HasEventTargeting reports whether an event of bodyKind already points at target.
func (q *Queries) HasEventTargeting(ctx context.Context, target int64, bodyKind int16) (bool, error) {
	var n int
	err := q.queryRow(ctx, `SELECT count(*) FROM events WHERE target_event_id=? AND body_kind=?`,
		target, bodyKind).Scan(&n)
	return n > 0, err
}

// ListEvents returns up to limit events with seq > afterSeq, in seq order.
func (q *Queries) ListEvents(ctx context.Context, convID, afterSeq int64, limit int) ([]*Event, error) {
	rows, err := q.query(ctx, `SELECT `+eventCols+` FROM events WHERE conv_id=? AND seq > ?
		ORDER BY seq LIMIT ?`, convID, afterSeq, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Event
	for rows.Next() {
		e, err := scanEvent(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// ---- admin delete ----

type Evidence struct {
	EventID    int64
	ConvID     int64
	SenderID   int64
	Payload    []byte
	MediaID    int64
	DeletedBy  int64
	Reason     string
	DeletedAt  int64
	PurgeAfter int64
}

// RedactEvent moves an event's content into the evidence table and blanks
// it in events. Must run inside a transaction.
func (q *Queries) RedactEvent(ctx context.Context, ev *Event, by int64, reason string, now, purgeAfter int64) error {
	if _, err := q.exec(ctx, `INSERT INTO evidence (event_id, conv_id, sender_id, payload, media_id, deleted_by,
		reason, deleted_at, purge_after) VALUES (?,?,?,?,?,?,?,?,?)`,
		ev.EventID, ev.ConvID, ev.SenderID, ev.Payload, nullInt(ev.MediaID), by, reason, now, purgeAfter); err != nil {
		return err
	}
	return affected(q.exec(ctx, `UPDATE events SET payload=?, media_id=NULL, redacted_by=?, redact_reason=?, redacted_at=?
		WHERE event_id=? AND redacted_by IS NULL`, []byte{}, by, reason, now, ev.EventID))
}

func (q *Queries) GetEvidence(ctx context.Context, eventID int64) (*Evidence, error) {
	e := &Evidence{}
	err := q.queryRow(ctx, `SELECT event_id, conv_id, sender_id, payload, COALESCE(media_id, 0), deleted_by, reason,
		deleted_at, purge_after FROM evidence WHERE event_id=?`, eventID).
		Scan(&e.EventID, &e.ConvID, &e.SenderID, &e.Payload, &e.MediaID, &e.DeletedBy, &e.Reason, &e.DeletedAt, &e.PurgeAfter)
	if err != nil {
		return nil, notFound(err)
	}
	return e, nil
}

// PurgeEvidence deletes evidence whose retention has passed. Returns rows removed.
func (q *Queries) PurgeEvidence(ctx context.Context, now int64) (int64, error) {
	res, err := q.exec(ctx, `DELETE FROM evidence WHERE purge_after < ?`, now)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// EvidenceRow is an evidence entry with names resolved, for the admin panel.
type EvidenceRow struct {
	Evidence
	SenderName  string
	DeleterName string
	ConvName    string
	ConvKind    int16
}

// ListEvidence returns evidence entries, newest deletion first.
func (q *Queries) ListEvidence(ctx context.Context, limit, offset int) ([]*EvidenceRow, int64, error) {
	var total int64
	if err := q.queryRow(ctx, `SELECT count(*) FROM evidence`).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := q.query(ctx, `SELECT ev.event_id, ev.conv_id, ev.sender_id, ev.payload, COALESCE(ev.media_id, 0),
		ev.deleted_by, ev.reason, ev.deleted_at, ev.purge_after,
		COALESCE(s.display_name, ''), COALESCE(d.display_name, ''), COALESCE(c.name, ''), COALESCE(c.kind, 0)
		FROM evidence ev
		LEFT JOIN users s ON s.id = ev.sender_id
		LEFT JOIN users d ON d.id = ev.deleted_by
		LEFT JOIN conversations c ON c.id = ev.conv_id
		ORDER BY ev.deleted_at DESC LIMIT ? OFFSET ?`, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var out []*EvidenceRow
	for rows.Next() {
		e := &EvidenceRow{}
		if err := rows.Scan(&e.EventID, &e.ConvID, &e.SenderID, &e.Payload, &e.MediaID, &e.DeletedBy, &e.Reason,
			&e.DeletedAt, &e.PurgeAfter, &e.SenderName, &e.DeleterName, &e.ConvName, &e.ConvKind); err != nil {
			return nil, 0, err
		}
		out = append(out, e)
	}
	return out, total, rows.Err()
}

// EvidenceHasMedia reports whether a media item is referenced by evidence.
func (q *Queries) EvidenceHasMedia(ctx context.Context, mediaID int64) (bool, error) {
	var n int
	err := q.queryRow(ctx, `SELECT count(*) FROM evidence WHERE media_id=?`, mediaID).Scan(&n)
	return n > 0, err
}
