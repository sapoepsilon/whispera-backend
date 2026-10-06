CREATE TABLE accounts (
    id          TEXT PRIMARY KEY NOT NULL,
    issuer      TEXT NOT NULL,
    subject     TEXT NOT NULL,
    created_at  BIGINT NOT NULL,
    UNIQUE (issuer, subject)
);

CREATE TABLE devices (
    id           TEXT PRIMARY KEY NOT NULL,
    account_id   TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    platform     TEXT NOT NULL,
    link_pub     TEXT NOT NULL,
    approve_pub  TEXT,
    kem_pub      TEXT,
    apns_token   TEXT,
    apns_env     TEXT,
    created_at   BIGINT NOT NULL,
    revoked_at   BIGINT
);
CREATE INDEX devices_account ON devices (account_id);

-- seq is the delivery cursor: strictly increasing and never reused, so a
-- recipient can ack "everything up to N" safely.
CREATE TABLE mailbox (
    seq               BIGSERIAL PRIMARY KEY,
    id                TEXT NOT NULL UNIQUE,
    recipient_device  TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    sender_device     TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    ciphertext        BYTEA NOT NULL,
    created_at        BIGINT NOT NULL,
    expires_at        BIGINT NOT NULL
);
CREATE INDEX mailbox_recipient ON mailbox (recipient_device, seq);
CREATE INDEX mailbox_expires ON mailbox (expires_at);
