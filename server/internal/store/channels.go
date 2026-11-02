package store

import "context"

// Channel is a public channel as listed in "browse channels".
type Channel struct {
	Conversation
	MemberCount int
	// The viewer is a member.
	Joined bool
}

// ListPublicChannels returns every public channel that is not dissolved,
// oldest first, with member counts and whether viewer is in it.
func (q *Queries) ListPublicChannels(ctx context.Context, viewer int64) ([]*Channel, error) {
	rows, err := q.query(ctx, `SELECT `+convCols+`,
		(SELECT count(*) FROM conv_members cm JOIN users ON users.id = cm.user_id WHERE cm.conv_id = c.id AND `+notServerBot+`),
		EXISTS (SELECT 1 FROM conv_members cm WHERE cm.conv_id = c.id AND cm.user_id = ?)
		FROM conversations c WHERE c.is_public AND NOT c.dissolved ORDER BY c.id`, viewer)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Channel
	for rows.Next() {
		ch := &Channel{}
		c := &ch.Conversation
		if err := rows.Scan(&c.ID, &c.Kind, &c.Name, &c.Avatar, &c.AvatarMedia, &c.Notice, &c.OwnerID, &c.LastSeq,
			&c.JoinApproval, &c.Dissolved, &c.Public, &c.CreatedAt, &c.AIID, &c.Nsfw, &ch.MemberCount, &ch.Joined); err != nil {
			return nil, err
		}
		out = append(out, ch)
	}
	return out, rows.Err()
}

// PublicChannelIDs returns the ids of all public channels that are not dissolved.
func (q *Queries) PublicChannelIDs(ctx context.Context) ([]int64, error) {
	rows, err := q.query(ctx, `SELECT id FROM conversations WHERE is_public AND NOT dissolved ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// ActiveUserIDs returns every account that is not banned.
func (q *Queries) ActiveUserIDs(ctx context.Context) ([]int64, error) {
	rows, err := q.query(ctx, `SELECT id FROM users WHERE NOT banned AND `+notServerBot+` ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// ChannelsWithout lists live channels (not AI rooms) userID is not in.
func (q *Queries) ChannelsWithout(ctx context.Context, userID int64) ([]int64, error) {
	rows, err := q.query(ctx, `SELECT c.id FROM conversations c WHERE c.kind=? AND NOT c.dissolved AND c.ai_id IS NULL
		AND NOT EXISTS (SELECT 1 FROM conv_members m WHERE m.conv_id = c.id AND m.user_id = ?) ORDER BY c.id`, int16(2), userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}
