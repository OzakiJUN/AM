-- Stage 1 batch 4 follow-up: signature on the profile page, invisible mode and
-- activity ("listening to ...", "playing ..."). Saved per account so they
-- survive reconnects and restarts.
ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN invisible BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN activity_kind SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN activity_text TEXT NOT NULL DEFAULT '';
