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
}

const userCols = `id, username, display_name, avatar, COALESCE(avatar_media_id, 0), COALESCE(password_hash, ''),
	account_type, COALESCE(owner_id, 0), is_site_admin, banned, created_at`

type scanner interface{ Scan(...any) error }

func scanUser(row scanner) (*User, error) {
	u := &User{}
	err := row.Scan(&u.ID, &u.Username, &u.DisplayName, &u.Avatar, &u.AvatarMediaID, &u.PasswordHash,
		&u.AccountType, &u.OwnerID, &u.IsSiteAdmin, &u.Banned, &u.CreatedAt)
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
