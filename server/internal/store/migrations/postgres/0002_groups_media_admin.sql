-- Stage 1 batch 2: groups, media, admin delete evidence, audit log, login records.

ALTER TABLE users ADD COLUMN avatar_media_id BIGINT;
-- Reserved for real-name (phone) verification, not used yet.
ALTER TABLE users ADD COLUMN phone TEXT;
ALTER TABLE users ADD COLUMN phone_verified_at BIGINT;

ALTER TABLE conversations ADD COLUMN join_approval BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE conversations ADD COLUMN dissolved BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE conversations ADD COLUMN avatar_media_id BIGINT;

ALTER TABLE events ADD COLUMN media_id BIGINT;
CREATE INDEX events_media ON events (media_id) WHERE media_id IS NOT NULL;

-- Pending "member invited X" requests in groups with join approval on.
CREATE TABLE join_requests (
    conv_id     BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    inviter_id  BIGINT NOT NULL REFERENCES users(id),
    created_at  BIGINT NOT NULL,
    PRIMARY KEY (conv_id, user_id)
);

-- One row per upload. Files with the same sha256 share one blob on disk.
CREATE TABLE media (
    id           BIGINT PRIMARY KEY,
    uploader_id  BIGINT NOT NULL REFERENCES users(id),
    sha256       TEXT NOT NULL,
    phash        BIGINT,                         -- 64-bit dHash, images only
    mime         TEXT NOT NULL,
    size         BIGINT NOT NULL,
    width        INT NOT NULL DEFAULT 0,
    height       INT NOT NULL DEFAULT 0,
    name         TEXT NOT NULL DEFAULT '',
    is_image     BOOLEAN NOT NULL,
    has_thumb    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at   BIGINT NOT NULL
);
CREATE INDEX media_sha ON media (sha256);

-- Content removed by admins. Only site admins can read it; purged after purge_after.
CREATE TABLE evidence (
    event_id     BIGINT PRIMARY KEY,
    conv_id      BIGINT NOT NULL,
    sender_id    BIGINT NOT NULL,
    payload      BYTEA NOT NULL,
    media_id     BIGINT,
    deleted_by   BIGINT NOT NULL,
    reason       TEXT NOT NULL,
    deleted_at   BIGINT NOT NULL,
    purge_after  BIGINT NOT NULL
);
CREATE INDEX evidence_purge ON evidence (purge_after);

CREATE TABLE media_blocklist (
    id          BIGINT PRIMARY KEY,
    phash       BIGINT NOT NULL,
    reason      TEXT NOT NULL,
    created_by  BIGINT,
    created_at  BIGINT NOT NULL
);

CREATE TABLE audit_log (
    id          BIGINT PRIMARY KEY,
    actor_id    BIGINT NOT NULL,
    action      TEXT NOT NULL,
    conv_id     BIGINT,
    target_id   BIGINT,
    detail      TEXT NOT NULL DEFAULT '',
    created_at  BIGINT NOT NULL
);
CREATE INDEX audit_log_time ON audit_log (created_at);

-- kind: "login" or "register". ip is the real client IP when proxy protocol is on.
CREATE TABLE login_records (
    id           BIGINT PRIMARY KEY,
    user_id      BIGINT NOT NULL,
    session_id   BIGINT,
    kind         TEXT NOT NULL,
    ip           TEXT NOT NULL,
    device_name  TEXT NOT NULL DEFAULT '',
    created_at   BIGINT NOT NULL
);
CREATE INDEX login_records_user ON login_records (user_id, created_at);
CREATE INDEX login_records_time ON login_records (created_at);
