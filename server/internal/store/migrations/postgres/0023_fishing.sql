CREATE TABLE fishing_accounts (
    user_id BIGINT PRIMARY KEY REFERENCES users(id),
    state TEXT NOT NULL
);
CREATE TABLE fishing_actions (
    user_id BIGINT NOT NULL REFERENCES users(id),
    request_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    PRIMARY KEY (user_id, request_id)
);
CREATE TABLE fishing_catches (
    user_id BIGINT NOT NULL REFERENCES users(id),
    fish_id BIGINT NOT NULL,
    specimen TEXT NOT NULL,
    PRIMARY KEY (user_id, fish_id)
);
