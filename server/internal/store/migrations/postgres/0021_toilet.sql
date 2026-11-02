-- 电子厕所 (docs/design.md §10 内置 bot): 16 pits shared by the whole
-- server, newest first; the oldest is flushed when a 17th comes in.
CREATE TABLE toilet_pits (
    id         BIGINT PRIMARY KEY,
    media_id   BIGINT NOT NULL,
    title      TEXT NOT NULL,
    culprit_id BIGINT NOT NULL,
    by_user    BIGINT NOT NULL,
    conv_id    BIGINT NOT NULL,
    nsfw       BOOLEAN NOT NULL,
    created_at BIGINT NOT NULL
);
CREATE INDEX toilet_pits_media ON toilet_pits (media_id);
