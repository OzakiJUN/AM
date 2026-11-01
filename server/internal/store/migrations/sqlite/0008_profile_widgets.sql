-- Profile pages are boards of widgets (proto am.v1.ProfileLayout). Every
-- save is a new version: the newest is current, older ones are kept as
-- evidence / undo and purged after retention.evidence_days.
-- owner_kind: 1 = a user's profile (owner_id = user id), 2 = the server's (owner_id = 0).
CREATE TABLE profile_layouts (
    owner_kind  SMALLINT NOT NULL,
    owner_id    BIGINT NOT NULL,
    version     BIGINT NOT NULL,
    layout      BLOB NOT NULL,
    saved_by    BIGINT NOT NULL,
    saved_at    BIGINT NOT NULL,
    PRIMARY KEY (owner_kind, owner_id, version)
);

-- Media used by a profile's current layout: everyone on the server may see
-- it, and media cleanup keeps it.
CREATE TABLE profile_media (
    owner_kind  SMALLINT NOT NULL,
    owner_id    BIGINT NOT NULL,
    media_id    BIGINT NOT NULL,
    PRIMARY KEY (owner_kind, owner_id, media_id)
);
CREATE INDEX profile_media_media ON profile_media (media_id);

-- Days (server local date, yyyymmdd) on which a user was connected, for
-- the "days in a row" statistic.
CREATE TABLE user_days (
    user_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day      INTEGER NOT NULL,
    PRIMARY KEY (user_id, day)
);

-- Guestbook widget entries. Nobody can edit or delete their own; the
-- profile owner can hide one; a site admin can delete one, which keeps the
-- text as evidence until purge_after.
CREATE TABLE guestbook (
    id             BIGINT PRIMARY KEY,
    owner_kind     SMALLINT NOT NULL,
    owner_id       BIGINT NOT NULL,
    widget_id      TEXT NOT NULL,
    author_id      BIGINT NOT NULL REFERENCES users(id),
    text           TEXT NOT NULL,
    created_at     BIGINT NOT NULL,
    hidden_by      BIGINT,
    hidden_at      BIGINT,
    deleted_by     BIGINT,
    delete_reason  TEXT NOT NULL DEFAULT '',
    deleted_at     BIGINT,
    purge_after    BIGINT
);
CREATE INDEX guestbook_board ON guestbook (owner_kind, owner_id, widget_id, id);
CREATE INDEX guestbook_author ON guestbook (author_id, created_at);
CREATE INDEX guestbook_purge ON guestbook (purge_after) WHERE purge_after IS NOT NULL;

-- "Messages sent" statistic.
CREATE INDEX events_sender ON events (sender_id, body_kind);
