-- Settings of an AI / bot account (persona, model, runner device, who may
-- chat with it...), written and read only by its owner. JSON kept as the
-- client sends it (docs/design.md §9).
CREATE TABLE ai_settings (
    user_id    BIGINT PRIMARY KEY REFERENCES users(id),
    data       TEXT NOT NULL,
    updated_at BIGINT NOT NULL
);
