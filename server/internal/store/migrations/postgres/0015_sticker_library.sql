-- The shared sticker library (docs/design.md §11). One row per picture:
-- copies that are the same file or look the same are merged into the
-- earliest one (media_id, uploader_id). People's collections (stickers)
-- point at it. Tags are everyone's: one row per tag per person who added it.
-- An admin delete keeps the row (and so the picture) as evidence until
-- purge_after; hidden ones stay in collections but are not listed.
CREATE TABLE sticker_library (
    id            BIGINT PRIMARY KEY,
    media_id      BIGINT NOT NULL,
    uploader_id   BIGINT NOT NULL,
    fingerprint   TEXT NOT NULL,
    animated      BOOLEAN NOT NULL,
    ratio         INTEGER NOT NULL,
    collectors    INTEGER NOT NULL DEFAULT 0,
    created_at    BIGINT NOT NULL,
    hidden_by     BIGINT,
    hidden_at     BIGINT,
    deleted_by    BIGINT,
    delete_reason TEXT NOT NULL DEFAULT '',
    deleted_at    BIGINT,
    purge_after   BIGINT
);
CREATE INDEX sticker_library_media ON sticker_library (media_id);
CREATE INDEX sticker_library_hot ON sticker_library (collectors, id);
CREATE INDEX sticker_library_purge ON sticker_library (purge_after);

-- Files (SHA-256) known to be a library picture, for exact matches and
-- for clients copying stickers from another server.
CREATE TABLE sticker_library_files (
    sha256     TEXT PRIMARY KEY,
    library_id BIGINT NOT NULL
);
CREATE INDEX sticker_library_files_item ON sticker_library_files (library_id);

CREATE TABLE sticker_library_tags (
    library_id BIGINT NOT NULL,
    tag_key    TEXT NOT NULL,
    tag        TEXT NOT NULL,
    added_by   BIGINT NOT NULL,
    added_at   BIGINT NOT NULL,
    PRIMARY KEY (library_id, tag_key, added_by)
);
CREATE INDEX sticker_library_tags_key ON sticker_library_tags (tag_key);

-- library_id NULL and is_private FALSE = shared but not linked yet (made
-- before the library existed, or while it was turned off); am-server links
-- those at start.
ALTER TABLE stickers ADD COLUMN library_id BIGINT;
ALTER TABLE stickers ADD COLUMN is_private BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX stickers_library ON stickers (library_id);
