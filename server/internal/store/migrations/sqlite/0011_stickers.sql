-- A person's sticker collection (docs/design.md §11): one of their own
-- uploaded images plus the tags they gave it. The shared library comes
-- later and will point at the same media.
CREATE TABLE stickers (
    id         BIGINT PRIMARY KEY,
    owner_id   BIGINT NOT NULL,
    media_id   BIGINT NOT NULL,
    tags       TEXT NOT NULL,
    created_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX stickers_owner_media ON stickers (owner_id, media_id);
CREATE INDEX stickers_media ON stickers (media_id);
