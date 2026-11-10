-- What AIs searched, opened and watched with their browser (docs/design.md §9
-- 搜索记录): written by the client running the AI, read by its owner, kept
-- retention.ai_browse_days and at most limits.max_browse_log per AI.
CREATE TABLE ai_browse_log (
    id    BIGINT PRIMARY KEY,
    ai_id BIGINT NOT NULL,
    at    BIGINT NOT NULL,
    kind  TEXT NOT NULL,
    text  TEXT NOT NULL,
    place TEXT NOT NULL
);
CREATE INDEX ai_browse_log_ai ON ai_browse_log (ai_id, id);
CREATE INDEX ai_browse_log_at ON ai_browse_log (at);
