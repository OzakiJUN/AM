-- Pairing a new device (docs/design.md §7, 多设备): a one-time ticket made
-- by a logged-in device; redeeming it logs the new device in. The ticket on
-- the device's current server also carries the encrypted bundle for the new
-- device (my server list, saved login, settings); the key is only in the
-- pairing code and never reaches the server.
CREATE TABLE pair_tickets (
    ticket_hash BLOB PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id),
    bundle      BLOB,
    created_at  BIGINT NOT NULL,
    expires_at  BIGINT NOT NULL
);
CREATE INDEX pair_tickets_user ON pair_tickets(user_id);

-- State shared by my devices (the list of my servers), encrypted by the
-- client: the server only keeps it.
CREATE TABLE client_states (
    user_id    BIGINT PRIMARY KEY REFERENCES users(id),
    data       BLOB NOT NULL,
    updated_at BIGINT NOT NULL
);
