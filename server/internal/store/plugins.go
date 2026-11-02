package store

import "context"

// AIPlugin is one plugin package of an AI account (docs/plugins.md).
type AIPlugin struct {
	ID           int64
	AIID         int64
	Dir          string
	Meta         string // plugin.Meta as JSON
	FilesSHA256  string
	Status       string // pending | approved | rejected
	Enabled      bool
	Config       string // JSON object: key -> value
	UploadedBy   int64
	UploadedAt   int64
	DecidedBy    int64
	DecidedAt    int64
	RejectReason string
	// Filled by ListPluginsAdmin.
	AIName, OwnerName string
}

const pluginCols = `p.id, p.ai_id, p.dir, p.meta, p.files_sha256, p.status, p.enabled, p.config, p.uploaded_by, p.uploaded_at,
	COALESCE(p.decided_by, 0), COALESCE(p.decided_at, 0), p.reject_reason`

func scanPlugin(r scanner, extra ...any) (*AIPlugin, error) {
	p := &AIPlugin{}
	dst := []any{&p.ID, &p.AIID, &p.Dir, &p.Meta, &p.FilesSHA256, &p.Status, &p.Enabled, &p.Config, &p.UploadedBy, &p.UploadedAt,
		&p.DecidedBy, &p.DecidedAt, &p.RejectReason}
	if len(extra) > 0 {
		dst = append(dst, &p.AIName, &p.OwnerName)
	}
	if err := r.Scan(dst...); err != nil {
		return nil, notFound(err)
	}
	return p, nil
}

func (q *Queries) plugins(ctx context.Context, where string, args ...any) ([]*AIPlugin, error) {
	rows, err := q.query(ctx, `SELECT `+pluginCols+` FROM ai_plugins p `+where, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*AIPlugin
	for rows.Next() {
		p, err := scanPlugin(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// ListPlugins returns an AI's plugins, by folder name.
func (q *Queries) ListPlugins(ctx context.Context, aiID int64) ([]*AIPlugin, error) {
	return q.plugins(ctx, `WHERE p.ai_id=? ORDER BY p.dir`, aiID)
}

// RunnablePlugins returns approved, enabled plugins of every AI (for starting hosts).
func (q *Queries) RunnablePlugins(ctx context.Context) ([]*AIPlugin, error) {
	return q.plugins(ctx, `JOIN users u ON u.id = p.ai_id
		WHERE p.status='approved' AND p.enabled=? AND u.banned=? AND u.left_at IS NULL ORDER BY p.ai_id, p.dir`, true, false)
}

// GetPlugin returns one plugin by id.
func (q *Queries) GetPlugin(ctx context.Context, id int64) (*AIPlugin, error) {
	return scanPlugin(q.queryRow(ctx, `SELECT `+pluginCols+` FROM ai_plugins p WHERE p.id=?`, id))
}

// PluginByDir returns an AI's plugin with this folder name.
func (q *Queries) PluginByDir(ctx context.Context, aiID int64, dir string) (*AIPlugin, error) {
	return scanPlugin(q.queryRow(ctx, `SELECT `+pluginCols+` FROM ai_plugins p WHERE p.ai_id=? AND p.dir=?`, aiID, dir))
}

// InsertPlugin adds a plugin.
func (q *Queries) InsertPlugin(ctx context.Context, p *AIPlugin) error {
	_, err := q.exec(ctx, `INSERT INTO ai_plugins (id, ai_id, dir, meta, files_sha256, status, enabled, config, uploaded_by, uploaded_at)
		VALUES (?,?,?,?,?,?,?,?,?,?)`, p.ID, p.AIID, p.Dir, p.Meta, p.FilesSHA256, p.Status, p.Enabled, p.Config, p.UploadedBy, p.UploadedAt)
	return err
}

// ReplacePluginFiles records a new upload of a plugin: new files, pending again.
func (q *Queries) ReplacePluginFiles(ctx context.Context, id int64, meta, sha string, by, at int64) error {
	_, err := q.exec(ctx, `UPDATE ai_plugins SET meta=?, files_sha256=?, status='pending', uploaded_by=?, uploaded_at=?,
		decided_by=NULL, decided_at=NULL, reject_reason='' WHERE id=?`, meta, sha, by, at, id)
	return err
}

// SetPluginEnabled turns a plugin on or off (owner).
func (q *Queries) SetPluginEnabled(ctx context.Context, id int64, on bool) error {
	_, err := q.exec(ctx, `UPDATE ai_plugins SET enabled=? WHERE id=?`, on, id)
	return err
}

// SetPluginConfig replaces a plugin's settings (JSON object).
func (q *Queries) SetPluginConfig(ctx context.Context, id int64, config string) error {
	_, err := q.exec(ctx, `UPDATE ai_plugins SET config=? WHERE id=?`, config, id)
	return err
}

// DecidePlugin approves or rejects a pending plugin.
func (q *Queries) DecidePlugin(ctx context.Context, id int64, status string, by int64, reason string, at int64) error {
	res, err := q.exec(ctx, `UPDATE ai_plugins SET status=?, decided_by=?, decided_at=?, reject_reason=? WHERE id=?`, status, by, at, reason, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// DeletePlugin removes a plugin row.
func (q *Queries) DeletePlugin(ctx context.Context, id int64) error {
	_, err := q.exec(ctx, `DELETE FROM ai_plugins WHERE id=?`, id)
	return err
}

// ListPluginsAdmin lists plugins for the admin panel ("" = all statuses), newest upload first.
func (q *Queries) ListPluginsAdmin(ctx context.Context, status string) ([]*AIPlugin, error) {
	where, args := ``, []any{}
	if status != "" {
		where, args = `WHERE p.status=?`, append(args, status)
	}
	rows, err := q.query(ctx, `SELECT `+pluginCols+`, COALESCE(a.display_name, ''), COALESCE(o.display_name, '')
		FROM ai_plugins p LEFT JOIN users a ON a.id = p.ai_id LEFT JOIN users o ON o.id = a.owner_id `+where+`
		ORDER BY p.uploaded_at DESC LIMIT 500`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*AIPlugin
	for rows.Next() {
		p, err := scanPlugin(rows, true)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}
