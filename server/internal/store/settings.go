package store

import "context"

// ServerSettings returns every saved server setting (key -> value).
func (q *Queries) ServerSettings(ctx context.Context) (map[string]string, error) {
	rows, err := q.query(ctx, `SELECT key, value FROM server_settings`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		out[k] = v
	}
	return out, rows.Err()
}

// SetServerSetting saves one server setting.
func (q *Queries) SetServerSetting(ctx context.Context, key, value string) error {
	_, err := q.exec(ctx, `INSERT INTO server_settings (key, value) VALUES (?, ?)
		ON CONFLICT (key) DO UPDATE SET value = excluded.value`, key, value)
	return err
}

// CountActiveUsers counts accounts that are not banned and have not left.
func (q *Queries) CountActiveUsers(ctx context.Context) (int64, error) {
	var n int64
	err := q.queryRow(ctx, `SELECT count(*) FROM users WHERE NOT banned AND left_at IS NULL`).Scan(&n)
	return n, err
}
