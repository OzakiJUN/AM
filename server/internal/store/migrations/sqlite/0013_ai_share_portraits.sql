-- A bot / AI's own portrait pack (docs/design.md §9 AI 形象): one image per
-- emotion, uploaded by its owner, shown to everyone.
CREATE TABLE portrait_packs (
    user_id  BIGINT NOT NULL,
    mood     TEXT NOT NULL,
    media_id BIGINT NOT NULL,
    PRIMARY KEY (user_id, mood)
);
CREATE INDEX portrait_packs_media ON portrait_packs (media_id);
-- When the pack last changed (clients refetch when it moves; 0 = none).
ALTER TABLE users ADD COLUMN portraits_at BIGINT NOT NULL DEFAULT 0;
-- People asking an AI's owner to let them talk with it (共享聊天).
CREATE TABLE ai_share_requests (
    ai_id      BIGINT NOT NULL,
    user_id    BIGINT NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (ai_id, user_id)
);
