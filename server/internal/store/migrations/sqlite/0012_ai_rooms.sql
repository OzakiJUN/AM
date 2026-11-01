-- A shared AI room (docs/design.md §9 共享 AI): a private group that belongs
-- to one AI; its owner adds the people who may talk with it there.
ALTER TABLE conversations ADD COLUMN ai_id BIGINT;
