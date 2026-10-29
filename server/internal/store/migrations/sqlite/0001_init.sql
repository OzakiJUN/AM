-- Stage 1 schema: accounts, sessions, invites, friends, conversations, events.
-- Times that clients compare (until / read positions) are unix ms bigints.

CREATE TABLE users (
    id             BIGINT PRIMARY KEY,
    username       TEXT NOT NULL,
    display_name   TEXT NOT NULL,
    avatar         TEXT NOT NULL DEFAULT '',
    password_hash  TEXT,                         -- NULL for bot / ai accounts
    account_type   SMALLINT NOT NULL,            -- am.v1.AccountType
    owner_id       BIGINT REFERENCES users(id),  -- bot / ai owner
    is_site_admin  BOOLEAN NOT NULL DEFAULT FALSE,
    banned         BOOLEAN NOT NULL DEFAULT FALSE,
    created_at     BIGINT NOT NULL
);
CREATE UNIQUE INDEX users_username_lower ON users (lower(username));

CREATE TABLE sessions (
    id           BIGINT PRIMARY KEY,
    user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash   BLOB NOT NULL UNIQUE,          -- sha256 of the token
    device_name  TEXT NOT NULL DEFAULT '',
    created_at   BIGINT NOT NULL,
    last_seen    BIGINT NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE invite_codes (
    code        TEXT PRIMARY KEY,
    created_by  BIGINT REFERENCES users(id),     -- NULL = bootstrap code
    used_by     BIGINT REFERENCES users(id),
    created_at  BIGINT NOT NULL,
    used_at     BIGINT
);
CREATE INDEX invite_codes_creator ON invite_codes (created_by);

-- One row per pair of users. state: 0 = pending (requester -> addressee), 1 = friends.
CREATE TABLE friendships (
    requester   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    addressee   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    state       SMALLINT NOT NULL,
    created_at  BIGINT NOT NULL,
    updated_at  BIGINT NOT NULL,
    PRIMARY KEY (requester, addressee)
);
CREATE UNIQUE INDEX friendships_pair ON friendships (min(requester, addressee), max(requester, addressee));
CREATE INDEX friendships_addressee ON friendships (addressee);

CREATE TABLE conversations (
    id          BIGINT PRIMARY KEY,
    kind        SMALLINT NOT NULL,               -- am.v1.ConvKind
    name        TEXT NOT NULL DEFAULT '',
    avatar      TEXT NOT NULL DEFAULT '',
    notice      TEXT NOT NULL DEFAULT '',
    owner_id    BIGINT REFERENCES users(id),
    last_seq    BIGINT NOT NULL DEFAULT 0,
    dm_key      TEXT UNIQUE,                     -- "<small id>:<big id>" for DMs
    created_at  BIGINT NOT NULL
);

CREATE TABLE conv_members (
    conv_id       BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role          SMALLINT NOT NULL,             -- am.v1.MemberRole
    read_seq      BIGINT NOT NULL DEFAULT 0,
    pinned_order  BIGINT NOT NULL DEFAULT 0,
    dnd_until     BIGINT NOT NULL DEFAULT 0,
    muted_until   BIGINT NOT NULL DEFAULT 0,
    joined_at     BIGINT NOT NULL,
    PRIMARY KEY (conv_id, user_id)
);
CREATE INDEX conv_members_user ON conv_members (user_id);

CREATE TABLE events (
    event_id         BIGINT PRIMARY KEY,
    conv_id          BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    seq              BIGINT NOT NULL,
    sender_id        BIGINT NOT NULL REFERENCES users(id),
    client_msg_id    TEXT NOT NULL DEFAULT '',
    body_kind        SMALLINT NOT NULL,          -- proto field number of the Event.body case
    target_event_id  BIGINT,                     -- for strike / admin_delete
    payload          BLOB NOT NULL,             -- encoded am.v1.Event (body only)
    redacted_by      BIGINT,
    redact_reason    TEXT,
    redacted_at      BIGINT,
    created_at       BIGINT NOT NULL,
    UNIQUE (conv_id, seq)
);
CREATE UNIQUE INDEX events_client_msg ON events (sender_id, client_msg_id) WHERE client_msg_id <> '';
CREATE INDEX events_target ON events (target_event_id) WHERE target_event_id IS NOT NULL;
