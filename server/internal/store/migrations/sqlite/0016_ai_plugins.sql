-- NoneBot (OneBot v11) plugins of AI accounts, run by am-server
-- (docs/design.md §10, docs/plugins.md). One row per plugin package of an
-- AI; the files live under data/plugins/pkgs/<id>/. A plugin runs only
-- after a site admin approved it (status = approved) and while its owner
-- keeps it enabled. Uploading a new version makes it pending again.
CREATE TABLE ai_plugins (
    id            BIGINT PRIMARY KEY,
    ai_id         BIGINT NOT NULL,
    dir           TEXT NOT NULL,
    meta          TEXT NOT NULL,
    files_sha256  TEXT NOT NULL,
    status        TEXT NOT NULL,
    enabled       BOOLEAN NOT NULL,
    config        TEXT NOT NULL,
    uploaded_by   BIGINT NOT NULL,
    uploaded_at   BIGINT NOT NULL,
    decided_by    BIGINT,
    decided_at    BIGINT,
    reject_reason TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX ai_plugins_ai_dir ON ai_plugins (ai_id, dir);
CREATE INDEX ai_plugins_status ON ai_plugins (status);
