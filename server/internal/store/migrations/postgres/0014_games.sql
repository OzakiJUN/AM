-- Board games in channels and shared AI rooms (docs/design.md §13 小游戏).
-- The whole game (players, board, secret words) is one JSON document,
-- read and written under a row lock; only the server reads `state`.
CREATE TABLE games (
    id         BIGINT PRIMARY KEY,
    conv_id    BIGINT NOT NULL,
    kind       TEXT NOT NULL,
    host_id    BIGINT NOT NULL,
    status     TEXT NOT NULL,
    state      TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
);
CREATE INDEX games_conv ON games (conv_id, status);
