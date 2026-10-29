-- Stage 1 batch 4: Discord-style servers. No friends any more: everyone on a
-- server can message everyone else, and groups become channels.

-- Public channel: every member of the server can see and join it; new
-- accounts join all public channels automatically. Existing groups stay
-- private (invite only).
ALTER TABLE conversations ADD COLUMN is_public BOOLEAN NOT NULL DEFAULT FALSE;

-- user_id has blocked target_id: no direct messages between them.
CREATE TABLE blocks (
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  BIGINT NOT NULL,
    PRIMARY KEY (user_id, target_id)
);
CREATE INDEX blocks_target ON blocks (target_id);
