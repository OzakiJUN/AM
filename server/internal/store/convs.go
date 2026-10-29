package store

import "context"

type Conversation struct {
	ID        int64
	Kind      int16
	Name      string
	Avatar    string
	Notice    string
	OwnerID   int64
	LastSeq   int64
	CreatedAt int64
}

type Member struct {
	ConvID      int64
	UserID      int64
	Role        int16
	ReadSeq     int64
	PinnedOrder int64
	DndUntil    int64
	MutedUntil  int64
	JoinedAt    int64
}

// ConvWithSelf is a conversation plus the requesting user's member row.
type ConvWithSelf struct {
	Conversation
	Self Member
}

func (q *Queries) CreateConversation(ctx context.Context, c *Conversation, dmKey string) error {
	var key, owner any
	if dmKey != "" {
		key = dmKey
	}
	if c.OwnerID != 0 {
		owner = c.OwnerID
	}
	_, err := q.db.Exec(ctx, `INSERT INTO conversations (id, kind, name, avatar, notice, owner_id, last_seq, dm_key, created_at)
		VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8)`, c.ID, c.Kind, c.Name, c.Avatar, c.Notice, owner, key, c.CreatedAt)
	return err
}

func (q *Queries) GetConvIDByDMKey(ctx context.Context, dmKey string) (int64, error) {
	var id int64
	err := q.db.QueryRow(ctx, `SELECT id FROM conversations WHERE dm_key=$1`, dmKey).Scan(&id)
	return id, notFound(err)
}

func (q *Queries) AddMember(ctx context.Context, m *Member) error {
	_, err := q.db.Exec(ctx, `INSERT INTO conv_members (conv_id, user_id, role, joined_at) VALUES ($1,$2,$3,$4)`,
		m.ConvID, m.UserID, m.Role, m.JoinedAt)
	return err
}

const convSelfCols = `c.id, c.kind, c.name, c.avatar, c.notice, COALESCE(c.owner_id, 0), c.last_seq, c.created_at,
	m.conv_id, m.user_id, m.role, m.read_seq, m.pinned_order, m.dnd_until, m.muted_until, m.joined_at`

func scanConvSelf(row interface{ Scan(...any) error }) (*ConvWithSelf, error) {
	c := &ConvWithSelf{}
	err := row.Scan(&c.ID, &c.Kind, &c.Name, &c.Avatar, &c.Notice, &c.OwnerID, &c.LastSeq, &c.CreatedAt,
		&c.Self.ConvID, &c.Self.UserID, &c.Self.Role, &c.Self.ReadSeq, &c.Self.PinnedOrder,
		&c.Self.DndUntil, &c.Self.MutedUntil, &c.Self.JoinedAt)
	if err != nil {
		return nil, notFound(err)
	}
	return c, nil
}

// GetConvForUser returns the conversation if the user is a member, else ErrNotFound.
func (q *Queries) GetConvForUser(ctx context.Context, convID, userID int64) (*ConvWithSelf, error) {
	return scanConvSelf(q.db.QueryRow(ctx, `SELECT `+convSelfCols+`
		FROM conversations c JOIN conv_members m ON m.conv_id = c.id
		WHERE c.id=$1 AND m.user_id=$2`, convID, userID))
}

func (q *Queries) ListConvsForUser(ctx context.Context, userID int64) ([]*ConvWithSelf, error) {
	rows, err := q.db.Query(ctx, `SELECT `+convSelfCols+`
		FROM conversations c JOIN conv_members m ON m.conv_id = c.id
		WHERE m.user_id=$1 ORDER BY c.id`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*ConvWithSelf
	for rows.Next() {
		c, err := scanConvSelf(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// MemberIDs returns user ids of members, keyed by conversation id.
func (q *Queries) MemberIDs(ctx context.Context, convIDs []int64) (map[int64][]int64, error) {
	out := make(map[int64][]int64, len(convIDs))
	if len(convIDs) == 0 {
		return out, nil
	}
	rows, err := q.db.Query(ctx, `SELECT conv_id, user_id FROM conv_members WHERE conv_id = ANY($1) ORDER BY joined_at, user_id`, convIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var c, u int64
		if err := rows.Scan(&c, &u); err != nil {
			return nil, err
		}
		out[c] = append(out[c], u)
	}
	return out, rows.Err()
}

// SetReadSeq moves the read position forward (never backwards, never past last_seq).
func (q *Queries) SetReadSeq(ctx context.Context, convID, userID, seq int64) error {
	_, err := q.db.Exec(ctx, `UPDATE conv_members m SET read_seq = LEAST(GREATEST(m.read_seq, $3), c.last_seq)
		FROM conversations c WHERE c.id = m.conv_id AND m.conv_id=$1 AND m.user_id=$2`, convID, userID, seq)
	return err
}
