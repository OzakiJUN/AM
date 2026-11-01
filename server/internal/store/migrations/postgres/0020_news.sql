-- 游戏资讯 (docs/design.md §10 内置 bot): what each conversation follows
-- (a channel, or someone's DM with the built-in bot), and the feature's own
-- state (game / company guesses, seen links, today's events) as JSON.
CREATE TABLE news_subs (
    conv_id      BIGINT NOT NULL,
    kw           TEXT NOT NULL,
    alias        TEXT NOT NULL,
    manual_steam BIGINT NOT NULL,
    created_by   BIGINT NOT NULL,
    created_at   BIGINT NOT NULL,
    PRIMARY KEY (conv_id, kw)
);
CREATE TABLE news_state (
    name       TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    updated_at BIGINT NOT NULL
);
