-- Shared emoji positions and media inside forwarded history snapshots.
CREATE TABLE message_pins (
    id BIGINT PRIMARY KEY,
    conv_id BIGINT NOT NULL,
    target_event_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    emoji TEXT NOT NULL,
    x DOUBLE PRECISION NOT NULL,
    y DOUBLE PRECISION NOT NULL,
    revision BIGINT NOT NULL,
    on_bubble BOOLEAN NOT NULL DEFAULT FALSE,
    removed BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX message_pins_conv ON message_pins(conv_id);
CREATE TABLE forwarded_media (
    event_id BIGINT NOT NULL REFERENCES events(event_id),
    media_id BIGINT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    PRIMARY KEY(event_id, media_id)
);
CREATE INDEX forwarded_media_media ON forwarded_media(media_id);
