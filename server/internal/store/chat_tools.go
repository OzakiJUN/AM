package store

import (
	"context"
	"errors"
)

var ErrPinLimit = errors.New("pin limit")

type MessagePin struct {
	OnBubble                               bool
	ID, ConvID, TargetID, UserID, Revision int64
	Emoji                                  string
	X, Y                                   float64
	Removed                                bool
}

func (q *Queries) ListMessagePins(ctx context.Context, convID int64) ([]MessagePin, error) {
	rows, err := q.query(ctx, `SELECT id,conv_id,target_event_id,user_id,emoji,x,y,revision,removed,on_bubble FROM message_pins WHERE conv_id=?`, convID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []MessagePin
	for rows.Next() {
		var p MessagePin
		if err := rows.Scan(&p.ID, &p.ConvID, &p.TargetID, &p.UserID, &p.Emoji, &p.X, &p.Y, &p.Revision, &p.Removed, &p.OnBubble); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}
func (q *Queries) GetMessagePin(ctx context.Context, id int64) (*MessagePin, error) {
	var p MessagePin
	err := q.queryRow(ctx, `SELECT id,conv_id,target_event_id,user_id,emoji,x,y,revision,removed,on_bubble FROM message_pins WHERE id=?`, id).Scan(&p.ID, &p.ConvID, &p.TargetID, &p.UserID, &p.Emoji, &p.X, &p.Y, &p.Revision, &p.Removed, &p.OnBubble)
	return &p, notFound(err)
}
func (q *Queries) AddMessagePin(ctx context.Context, p MessagePin, max int) error {
	var count int
	if err := q.queryRow(ctx, `SELECT count(*) FROM message_pins WHERE conv_id=? AND target_event_id=? AND removed=?`, p.ConvID, p.TargetID, false).Scan(&count); err != nil {
		return err
	}
	if count >= max {
		return ErrPinLimit
	}
	_, err := q.exec(ctx, `INSERT INTO message_pins (id,conv_id,target_event_id,user_id,emoji,x,y,revision,removed,on_bubble) VALUES (?,?,?,?,?,?,?,?,?,?)`, p.ID, p.ConvID, p.TargetID, p.UserID, p.Emoji, p.X, p.Y, p.Revision, false, p.OnBubble)
	return err
}
func (q *Queries) RemoveMessagePin(ctx context.Context, id, revision int64) error {
	_, err := q.exec(ctx, `UPDATE message_pins SET removed=?,revision=? WHERE id=?`, true, revision, id)
	return err
}
func (q *Queries) AddForwardMedia(ctx context.Context, eventID int64, mediaIDs map[int64]bool) error {
	for mediaID := range mediaIDs {
		if _, err := q.exec(ctx, `INSERT INTO forwarded_media(event_id,media_id) VALUES (?,?)`, eventID, mediaID); err != nil {
			return err
		}
	}
	return nil
}
