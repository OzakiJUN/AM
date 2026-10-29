-- Stage 1 batch 3: server admin panel.

-- Invite codes created from the admin panel have no creator (like the
-- bootstrap code), so whether a code makes the new account a site admin is
-- now an explicit column. Existing creator-less codes are bootstrap codes.
ALTER TABLE invite_codes ADD COLUMN makes_admin BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE invite_codes SET makes_admin = TRUE WHERE created_by IS NULL;
-- Free-text note shown in the admin panel ("for Xiao Ming").
ALTER TABLE invite_codes ADD COLUMN note TEXT NOT NULL DEFAULT '';

-- Why and when an account was banned.
ALTER TABLE users ADD COLUMN ban_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN banned_at BIGINT;

CREATE INDEX evidence_time ON evidence (deleted_at);
