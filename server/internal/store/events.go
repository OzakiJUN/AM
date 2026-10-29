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
	Payload       []byte
	RedactedBy    int64
	RedactReason  string
	RedactedAt    int64
	CreatedAt     int64
}

const eventCols = `event_id, conv_id, seq, sender_id, client_msg_id, body_kind, COALESCE(target_event_id, 0),
	payload, COALESCE(redacted_by, 0), COALESCE(redact_reason, ''), COALESCE(redacted_at, 0), created_at`

func scanEvent(row interface{ Scan(...any) error }) (*Event, error) {
	e := &Event{}
	err := row.Scan(&e.EventID, &e.ConvID, &e.Seq, &e.SenderID, &e.ClientMsgID, &e.BodyKind, &e.TargetEventID,
		&e.Payload, &e.RedactedBy, &e.RedactReason, &e.RedactedAt, &e.CreatedAt)
	if err != nil {
		return nil, notFound(err)
	}
	return e, nil
}

// AppendEvent takes the next seq of the conversation and inserts the event.
// Must run inside a transaction: the conversation row stays locked until
// commit, so seqs are assigned one at a time with no gaps.
// e.Seq is filled in.
func (q *Queries) AppendEvent(ctx context.Context, e *Event) error {
	if err := q.db.QueryRow(ctx, `UPDATE conversations SET last_seq = last_seq + 1 WHERE id=$1 RETURNING last_seq`,
		e.ConvID).Scan(&e.Seq); err != nil {
		return notFound(err)
	}
	var target any
	if e.TargetEventID != 0 {
		target = e.TargetEventID
	}
	_, err := q.db.Exec(ctx, `INSERT INTO events (event_id, conv_id, seq, sender_id, client_msg_id, body_kind,
		target_event_id, payload, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
		e.EventID, e.ConvID, e.Seq, e.SenderID, e.ClientMsgID, e.BodyKind, target, e.Payload, e.CreatedAt)
	return err
}

func (q *Queries) GetEvent(ctx context.Context, eventID int64) (*Event, error) {
	return scanEvent(q.db.QueryRow(ctx, `SELECT `+eventCols+` FROM events WHERE event_id=$1`, eventID))
}

func (q *Queries) GetEventByClientMsgID(ctx context.Context, senderID int64, clientMsgID string) (*Event, error) {
	return scanEvent(q.db.QueryRow(ctx, `SELECT `+eventCols+` FROM events WHERE sender_id=$1 AND client_msg_id=$2`,
		senderID, clientMsgID))
}

// HasEventTargeting reports whether an event of bodyKind already points at target.
func (q *Queries) HasEventTargeting(ctx context.Context, target int64, bodyKind int16) (bool, error) {
	var ok bool
	err := q.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM events WHERE target_event_id=$1 AND body_kind=$2)`,
		target, bodyKind).Scan(&ok)
	return ok, err
}

// ListEvents returns up to limit events with seq > afterSeq, in seq order.
func (q *Queries) ListEvents(ctx context.Context, convID, afterSeq int64, limit int) ([]*Event, error) {
	rows, err := q.db.Query(ctx, `SELECT `+eventCols+` FROM events WHERE conv_id=$1 AND seq > $2
		ORDER BY seq LIMIT $3`, convID, afterSeq, limit)
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
