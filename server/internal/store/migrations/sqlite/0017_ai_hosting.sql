-- AIs hosted on the server (docs/design.md §10 托管): the owner asks, a
-- site admin approves, then am-server runs the AM client without a window
-- for that AI. One row per AI; secrets = the owner's model providers (with
-- their keys), encrypted with data/hosting/key.
CREATE TABLE ai_hosting (
    ai_id         BIGINT PRIMARY KEY,
    owner_id      BIGINT NOT NULL,
    status        TEXT NOT NULL,
    secrets       TEXT NOT NULL,
    requested_at  BIGINT NOT NULL,
    decided_by    BIGINT,
    decided_at    BIGINT,
    reject_reason TEXT NOT NULL DEFAULT ''
);
CREATE INDEX ai_hosting_owner ON ai_hosting (owner_id);
CREATE INDEX ai_hosting_status ON ai_hosting (status);
