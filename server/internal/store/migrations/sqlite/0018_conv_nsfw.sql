-- Channels: adult content allowed (AIs drawing with NovelAI, docs/design.md §9 画画).
-- Only channel owners / admins change it; off by default.
ALTER TABLE conversations ADD COLUMN nsfw BOOLEAN NOT NULL DEFAULT FALSE;
