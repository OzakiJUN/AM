-- A channel's museum (docs/design.md §13 博物馆): works (pictures from the
-- chat), their place (first hall 1–8, 0 = warehouse, -1 = waiting for a
-- vote), likes, and votes on changes.
CREATE TABLE museum_arts (
    id           BIGINT PRIMARY KEY,
    conv_id      BIGINT NOT NULL,
    slot         INTEGER NOT NULL,
    media_id     BIGINT NOT NULL,
    title        TEXT NOT NULL,
    by_user      BIGINT NOT NULL,
    source_event BIGINT NOT NULL,
    method       TEXT NOT NULL,
    nsfw         BOOLEAN NOT NULL,
    created_at   BIGINT NOT NULL,
    hung_at      BIGINT NOT NULL,
    stored_at    BIGINT NOT NULL
);
CREATE INDEX museum_arts_conv ON museum_arts (conv_id, slot);
CREATE INDEX museum_arts_media ON museum_arts (media_id);
CREATE TABLE museum_likes (
    art_id     BIGINT NOT NULL,
    user_id    BIGINT NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (art_id, user_id)
);
CREATE TABLE museum_votes (
    id       BIGINT PRIMARY KEY,
    conv_id  BIGINT NOT NULL,
    action   TEXT NOT NULL,
    text     TEXT NOT NULL,
    by_user  BIGINT NOT NULL,
    ends_at  BIGINT NOT NULL,
    media_id BIGINT NOT NULL
);
CREATE INDEX museum_votes_conv ON museum_votes (conv_id);
CREATE TABLE museum_ballots (
    vote_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    agree   BOOLEAN NOT NULL,
    PRIMARY KEY (vote_id, user_id)
);
