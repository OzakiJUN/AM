package store

import "context"

type Conversation struct {
	ID           int64
	Kind         int16
	Name         string
	Avatar       string
	AvatarMedia  int64
	Notice       string
	OwnerID      int64
	LastSeq      int64
	JoinApproval bool
	Dissolved    bool
	CreatedAt    int64
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
	_, err := q.exec(ctx, `INSERT INTO conversations (id, kind, name, avatar, notice, owner_id, last_seq, dm_key,
		join_approval, dissolved, created_at) VALUES (?,?,?,?,?,?,0,?,?,?,?)`,
		c.ID, c.Kind, c.Name, c.Avatar, c.Notice, nullInt(c.OwnerID), nullStr(dmKey), c.JoinApproval, false, c.CreatedAt)
	return err
}

func (q *Queries) GetConvIDByDMKey(ctx context.Context, dmKey string) (int64, error) {
	var id int64
	err := q.queryRow(ctx, `SELECT id FROM conversations WHERE dm_key=?`, dmKey).Scan(&id)
	return id, notFound(err)
}

const convCols = `c.id, c.kind, c.name, c.avatar, COALESCE(c.avatar_media_id, 0), c.notice, COALESCE(c.owner_id, 0),
	c.last_seq, c.join_approval, c.dissolved, c.created_at`

func scanConv(row scanner) (*Conversation, error) {
	c := &Conversation{}
	err := row.Scan(&c.ID, &c.Kind, &c.Name, &c.Avatar, &c.AvatarMedia, &c.Notice, &c.OwnerID, &c.LastSeq,
		&c.JoinApproval, &c.Dissolved, &c.CreatedAt)
	if err != nil {
		return nil, notFound(err)
	}
	return c, nil
}

// GetConv returns a conversation regardless of membership. Lock it for
// update inside a transaction with GetConvForUpdate.
func (q *Queries) GetConv(ctx context.Context, id int64) (*Conversation, error) {
	return scanConv(q.queryRow(ctx, `SELECT `+convCols+` FROM conversations c WHERE c.id=?`, id))
}

// GetConvForUpdate locks the conversation row until the transaction ends,
// so membership changes on the same group happen one at a time.
func (q *Queries) GetConvForUpdate(ctx context.Context, id int64) (*Conversation, error) {
	return scanConv(q.queryRow(ctx, `SELECT `+convCols+` FROM conversations c WHERE c.id=?`+q.forUpdate(), id))
}

// UpdateConvInfo sets the non-nil fields. avatarMedia 0 clears the avatar.
func (q *Queries) UpdateConvInfo(ctx context.Context, id int64, name *string, avatarMedia *int64, notice *string, joinApproval *bool) error {
	if name != nil {
		if _, err := q.exec(ctx, `UPDATE conversations SET name=? WHERE id=?`, *name, id); err != nil {
			return err
		}
	}
	if avatarMedia != nil {
		if _, err := q.exec(ctx, `UPDATE conversations SET avatar_media_id=? WHERE id=?`, nullInt(*avatarMedia), id); err != nil {
			return err
		}
	}
	if notice != nil {
		if _, err := q.exec(ctx, `UPDATE conversations SET notice=? WHERE id=?`, *notice, id); err != nil {
			return err
		}
	}
	if joinApproval != nil {
		if _, err := q.exec(ctx, `UPDATE conversations SET join_approval=? WHERE id=?`, *joinApproval, id); err != nil {
			return err
		}
	}
	return nil
}

func (q *Queries) SetConvOwner(ctx context.Context, id, ownerID int64) error {
	_, err := q.exec(ctx, `UPDATE conversations SET owner_id=? WHERE id=?`, ownerID, id)
	return err
}

// MarkDissolved flags the group and removes every member and pending request.
// Events stay (log retention).
func (q *Queries) MarkDissolved(ctx context.Context, id int64) error {
	if _, err := q.exec(ctx, `UPDATE conversations SET dissolved=? WHERE id=?`, true, id); err != nil {
		return err
	}
	if _, err := q.exec(ctx, `DELETE FROM conv_members WHERE conv_id=?`, id); err != nil {
		return err
	}
	_, err := q.exec(ctx, `DELETE FROM join_requests WHERE conv_id=?`, id)
	return err
}

// ---- members ----

func (q *Queries) AddMember(ctx context.Context, m *Member) error {
	_, err := q.exec(ctx, `INSERT INTO conv_members (conv_id, user_id, role, joined_at) VALUES (?,?,?,?)`,
		m.ConvID, m.UserID, m.Role, m.JoinedAt)
	return err
}

func (q *Queries) RemoveMember(ctx context.Context, convID, userID int64) error {
	return affected(q.exec(ctx, `DELETE FROM conv_members WHERE conv_id=? AND user_id=?`, convID, userID))
}

func (q *Queries) SetMemberRole(ctx context.Context, convID, userID int64, role int16) error {
	return affected(q.exec(ctx, `UPDATE conv_members SET role=? WHERE conv_id=? AND user_id=?`, role, convID, userID))
}

func (q *Queries) SetMemberMute(ctx context.Context, convID, userID, until int64) error {
	return affected(q.exec(ctx, `UPDATE conv_members SET muted_until=? WHERE conv_id=? AND user_id=?`, until, convID, userID))
}

func (q *Queries) GetMember(ctx context.Context, convID, userID int64) (*Member, error) {
	m := &Member{}
	err := q.queryRow(ctx, `SELECT conv_id, user_id, role, read_seq, pinned_order, dnd_until, muted_until, joined_at
		FROM conv_members WHERE conv_id=? AND user_id=?`, convID, userID).
		Scan(&m.ConvID, &m.UserID, &m.Role, &m.ReadSeq, &m.PinnedOrder, &m.DndUntil, &m.MutedUntil, &m.JoinedAt)
	if err != nil {
		return nil, notFound(err)
	}
	return m, nil
}

func (q *Queries) CountMembers(ctx context.Context, convID int64) (int, error) {
	var n int
	err := q.queryRow(ctx, `SELECT count(*) FROM conv_members WHERE conv_id=?`, convID).Scan(&n)
	return n, err
}

const convSelfCols = convCols + `,
	m.conv_id, m.user_id, m.role, m.read_seq, m.pinned_order, m.dnd_until, m.muted_until, m.joined_at`

func scanConvSelf(row scanner) (*ConvWithSelf, error) {
	c := &ConvWithSelf{}
	err := row.Scan(&c.ID, &c.Kind, &c.Name, &c.Avatar, &c.AvatarMedia, &c.Notice, &c.OwnerID, &c.LastSeq,
		&c.JoinApproval, &c.Dissolved, &c.CreatedAt,
		&c.Self.ConvID, &c.Self.UserID, &c.Self.Role, &c.Self.ReadSeq, &c.Self.PinnedOrder,
		&c.Self.DndUntil, &c.Self.MutedUntil, &c.Self.JoinedAt)
	if err != nil {
		return nil, notFound(err)
	}
	return c, nil
}

// GetConvForUser returns the conversation if the user is a member, else ErrNotFound.
func (q *Queries) GetConvForUser(ctx context.Context, convID, userID int64) (*ConvWithSelf, error) {
	return scanConvSelf(q.queryRow(ctx, `SELECT `+convSelfCols+`
		FROM conversations c JOIN conv_members m ON m.conv_id = c.id
		WHERE c.id=? AND m.user_id=?`, convID, userID))
}

func (q *Queries) ListConvsForUser(ctx context.Context, userID int64) ([]*ConvWithSelf, error) {
	rows, err := q.query(ctx, `SELECT `+convSelfCols+`
		FROM conversations c JOIN conv_members m ON m.conv_id = c.id
		WHERE m.user_id=? ORDER BY c.id`, userID)
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

// MemberRole is one member's user id and role.
type MemberRole struct {
	UserID int64
	Role   int16
}

// MemberIDs returns user ids of members, keyed by conversation id, in join order.
func (q *Queries) MemberIDs(ctx context.Context, convIDs []int64) (map[int64][]int64, error) {
	full, err := q.MemberRoles(ctx, convIDs)
	if err != nil {
		return nil, err
	}
	out := make(map[int64][]int64, len(full))
	for c, list := range full {
		for _, m := range list {
			out[c] = append(out[c], m.UserID)
		}
	}
	return out, nil
}

// MemberRoles returns the members with roles, keyed by conversation id, in join order.
func (q *Queries) MemberRoles(ctx context.Context, convIDs []int64) (map[int64][]MemberRole, error) {
	out := make(map[int64][]MemberRole, len(convIDs))
	if len(convIDs) == 0 {
		return out, nil
	}
	list, args := inList(convIDs)
	rows, err := q.query(ctx, `SELECT conv_id, user_id, role FROM conv_members WHERE conv_id IN `+list+`
		ORDER BY joined_at, user_id`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var c int64
		var m MemberRole
		if err := rows.Scan(&c, &m.UserID, &m.Role); err != nil {
			return nil, err
		}
		out[c] = append(out[c], m)
	}
	return out, rows.Err()
}

// SetReadSeq moves the read position forward (never backwards). The caller
// clamps seq to the conversation's last_seq.
func (q *Queries) SetReadSeq(ctx context.Context, convID, userID, seq int64) error {
	_, err := q.exec(ctx, `UPDATE conv_members SET read_seq=? WHERE conv_id=? AND user_id=? AND read_seq < ?`,
		seq, convID, userID, seq)
	return err
}

// ---- join requests ----

type JoinRequest struct {
	ConvID    int64
	UserID    int64
	InviterID int64
	CreatedAt int64
}

// UpsertJoinRequest records a pending request (keeps the first one).
func (q *Queries) UpsertJoinRequest(ctx context.Context, r *JoinRequest) error {
	_, err := q.exec(ctx, `INSERT INTO join_requests (conv_id, user_id, inviter_id, created_at) VALUES (?,?,?,?)
		ON CONFLICT (conv_id, user_id) DO NOTHING`, r.ConvID, r.UserID, r.InviterID, r.CreatedAt)
	return err
}

func (q *Queries) DeleteJoinRequest(ctx context.Context, convID, userID int64) error {
	return affected(q.exec(ctx, `DELETE FROM join_requests WHERE conv_id=? AND user_id=?`, convID, userID))
}

func (q *Queries) ListJoinRequests(ctx context.Context, convID int64) ([]*JoinRequest, error) {
	rows, err := q.query(ctx, `SELECT conv_id, user_id, inviter_id, created_at FROM join_requests
		WHERE conv_id=? ORDER BY created_at`, convID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*JoinRequest
	for rows.Next() {
		r := &JoinRequest{}
		if err := rows.Scan(&r.ConvID, &r.UserID, &r.InviterID, &r.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
