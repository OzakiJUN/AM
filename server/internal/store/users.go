package store

import "context"

type User struct {
	ID            int64
	Username      string
	DisplayName   string
	Avatar        string
	AvatarMediaID int64
	PasswordHash  string
	AccountType   int16
	OwnerID       int64
	IsSiteAdmin   bool
	Banned        bool
	CreatedAt     int64
	Bio           string
	Invisible     bool
	ActivityKind  int16
	ActivityText  string
	// LeftAt is when the user left the server (0 = still a member).
	LeftAt int64
}

// Gone reports whether the account is banned or has left the server: it is
// not listed, cannot be messaged or added, and cannot log in.
func (u *User) Gone() bool { return u.Banned || u.LeftAt != 0 }

const userCols = `id, username, display_name, avatar, COALESCE(avatar_media_id, 0), COALESCE(password_hash, ''),
	account_type, COALESCE(owner_id, 0), is_site_admin, banned, created_at, bio, invisible, activity_kind, activity_text,
	COALESCE(left_at, 0)`

type scanner interface{ Scan(...any) error }

// scanTargets lists u's fields in userCols order.
func (u *User) scanTargets() []any {
	return []any{&u.ID, &u.Username, &u.DisplayName, &u.Avatar, &u.AvatarMediaID, &u.PasswordHash,
		&u.AccountType, &u.OwnerID, &u.IsSiteAdmin, &u.Banned, &u.CreatedAt,
		&u.Bio, &u.Invisible, &u.ActivityKind, &u.ActivityText, &u.LeftAt}
}

func scanUser(row scanner) (*User, error) {
	u := &User{}
	err := row.Scan(u.scanTargets()...)
	if err != nil {
		return nil, notFound(err)
	}
	return u, nil
}

func (q *Queries) CreateUser(ctx context.Context, u *User) error {
	_, err := q.exec(ctx, `INSERT INTO users (id, username, display_name, avatar, password_hash,
		account_type, owner_id, is_site_admin, banned, created_at)
		VALUES (?,?,?,?,?,?,?,?,?,?)`,
		u.ID, u.Username, u.DisplayName, u.Avatar, nullStr(u.PasswordHash), u.AccountType, nullInt(u.OwnerID),
		u.IsSiteAdmin, u.Banned, u.CreatedAt)
	return err
}

func (q *Queries) GetUser(ctx context.Context, id int64) (*User, error) {
	return scanUser(q.queryRow(ctx, `SELECT `+userCols+` FROM users WHERE id=?`, id))
}

func (q *Queries) GetUserByUsername(ctx context.Context, username string) (*User, error) {
	return scanUser(q.queryRow(ctx, `SELECT `+userCols+` FROM users WHERE lower(username)=lower(?)`, username))
}

// GetUsers returns the users with the given ids, keyed by id.
func (q *Queries) GetUsers(ctx context.Context, ids []int64) (map[int64]*User, error) {
	out := make(map[int64]*User, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	list, args := inList(ids)
	rows, err := q.query(ctx, `SELECT `+userCols+` FROM users WHERE id IN `+list, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, err
		}
		out[u.ID] = u
	}
	return out, rows.Err()
}

func (q *Queries) CountUsers(ctx context.Context) (int64, error) {
	var n int64
	err := q.queryRow(ctx, `SELECT count(*) FROM users`).Scan(&n)
	return n, err
}

// UpdateProfile changes display name and/or avatar. Empty displayName keeps
// the current one; avatarMediaID < 0 keeps the avatar, 0 clears it.
func (q *Queries) UpdateProfile(ctx context.Context, userID int64, displayName string, avatarMediaID int64, avatar string) error {
	if displayName != "" {
		if _, err := q.exec(ctx, `UPDATE users SET display_name=? WHERE id=?`, displayName, userID); err != nil {
			return err
		}
	}
	if avatarMediaID >= 0 {
		if _, err := q.exec(ctx, `UPDATE users SET avatar_media_id=?, avatar=? WHERE id=?`,
			nullInt(avatarMediaID), avatar, userID); err != nil {
			return err
		}
	}
	return nil
}

// SetBio changes the profile signature.
func (q *Queries) SetBio(ctx context.Context, userID int64, bio string) error {
	_, err := q.exec(ctx, `UPDATE users SET bio=? WHERE id=?`, bio, userID)
	return err
}

// SetPresence saves the invisible flag and the activity.
func (q *Queries) SetPresence(ctx context.Context, userID int64, invisible bool, activityKind int16, activityText string) error {
	return affected(q.exec(ctx, `UPDATE users SET invisible=?, activity_kind=?, activity_text=? WHERE id=?`,
		invisible, activityKind, activityText, userID))
}

// SetLeft marks the user as having left the server at `at`, or back (at = 0).
func (q *Queries) SetLeft(ctx context.Context, userID, at int64) error {
	return affected(q.exec(ctx, `UPDATE users SET left_at=? WHERE id=?`, nullInt(at), userID))
}

// AdminUser is a row of the admin panel's user list.
type AdminUser struct {
	User
	BanReason string
	BannedAt  int64
	LastSeen  int64 // latest session activity, 0 if never / logged out everywhere
	Sessions  int
}

// escapeLike escapes LIKE wildcards; use with ESCAPE '\'.
func escapeLike(s string) string {
	r := make([]rune, 0, len(s))
	for _, c := range s {
		if c == '\\' || c == '%' || c == '_' {
			r = append(r, '\\')
		}
		r = append(r, c)
	}
	return string(r)
}

// ListUsersAdmin lists accounts for the admin panel, newest first. search
// matches username or display name (case-insensitive substring).
func (q *Queries) ListUsersAdmin(ctx context.Context, search string, limit, offset int) ([]*AdminUser, int64, error) {
	where := ""
	var args []any
	if search != "" {
		where = ` WHERE lower(username) LIKE ? ESCAPE '\' OR lower(display_name) LIKE ? ESCAPE '\'`
		pat := "%" + escapeLike(toLower(search)) + "%"
		args = append(args, pat, pat)
	}
	var total int64
	if err := q.queryRow(ctx, `SELECT count(*) FROM users`+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := q.query(ctx, `SELECT `+userCols+`, ban_reason, COALESCE(banned_at, 0),
		COALESCE((SELECT max(s.last_seen) FROM sessions s WHERE s.user_id = users.id), 0),
		(SELECT count(*) FROM sessions s WHERE s.user_id = users.id)
		FROM users`+where+` ORDER BY created_at DESC LIMIT ? OFFSET ?`, append(args, limit, offset)...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var out []*AdminUser
	for rows.Next() {
		u := &AdminUser{}
		if err := rows.Scan(append(u.scanTargets(), &u.BanReason, &u.BannedAt, &u.LastSeen, &u.Sessions)...); err != nil {
			return nil, 0, err
		}
		out = append(out, u)
	}
	return out, total, rows.Err()
}

// SetBanned bans or unbans an account. Banning records reason and time.
func (q *Queries) SetBanned(ctx context.Context, userID int64, banned bool, reason string, now int64) error {
	if banned {
		return affected(q.exec(ctx, `UPDATE users SET banned=?, ban_reason=?, banned_at=? WHERE id=?`,
			true, reason, now, userID))
	}
	return affected(q.exec(ctx, `UPDATE users SET banned=?, ban_reason='', banned_at=NULL WHERE id=?`, false, userID))
}

func (q *Queries) SetSiteAdmin(ctx context.Context, userID int64, admin bool) error {
	return affected(q.exec(ctx, `UPDATE users SET is_site_admin=? WHERE id=?`, admin, userID))
}

func (q *Queries) SetPasswordHash(ctx context.Context, userID int64, hash string) error {
	return affected(q.exec(ctx, `UPDATE users SET password_hash=? WHERE id=?`, hash, userID))
}

// CountSiteAdmins counts site admins that are not banned.
func (q *Queries) CountSiteAdmins(ctx context.Context) (int64, error) {
	var n int64
	err := q.queryRow(ctx, `SELECT count(*) FROM users WHERE is_site_admin AND NOT banned AND left_at IS NULL`).Scan(&n)
	return n, err
}

func toLower(s string) string {
	// ASCII-only lowering matches SQL lower() on both databases for the
	// characters usernames may contain; other characters pass through.
	b := []byte(s)
	for i, c := range b {
		if 'A' <= c && c <= 'Z' {
			b[i] = c + 32
		}
	}
	return string(b)
}
