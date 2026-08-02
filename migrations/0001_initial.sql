BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text NOT NULL,
    password_hash text NOT NULL,
    display_name text NOT NULL,
    session_version bigint NOT NULL DEFAULT 1,
    retention_period text NOT NULL DEFAULT 'forever',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT users_email_lowercase CHECK (email = lower(email)),
    CONSTRAINT users_email_not_blank CHECK (length(trim(email)) > 3),
    CONSTRAINT users_display_name_not_blank CHECK (length(trim(display_name)) > 0),
    CONSTRAINT users_retention_period_valid CHECK (retention_period IN ('30d', '90d', '1y', 'forever'))
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (email);

CREATE TABLE IF NOT EXISTS devices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    client_device_id text NOT NULL,
    name text,
    last_seen_at timestamptz,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT devices_client_id_not_blank CHECK (length(trim(client_device_id)) > 0),
    CONSTRAINT devices_user_client_unique UNIQUE (user_id, client_device_id)
);

CREATE INDEX IF NOT EXISTS devices_user_active_idx
    ON devices (user_id, last_seen_at DESC)
    WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    device_id uuid REFERENCES devices (id) ON DELETE SET NULL,
    refresh_token_hash bytea NOT NULL,
    user_session_version bigint NOT NULL,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    CONSTRAINT sessions_refresh_hash_unique UNIQUE (refresh_token_hash)
);

CREATE INDEX IF NOT EXISTS sessions_user_active_idx
    ON sessions (user_id, expires_at)
    WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS conversations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_low_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    user_high_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    next_sequence bigint NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT conversations_distinct_users CHECK (user_low_id <> user_high_id),
    CONSTRAINT conversations_ordered_users CHECK (user_low_id < user_high_id),
    CONSTRAINT conversations_sequence_positive CHECK (next_sequence > 0),
    CONSTRAINT conversations_users_unique UNIQUE (user_low_id, user_high_id)
);

CREATE TABLE IF NOT EXISTS conversation_members (
    conversation_id uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    joined_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (conversation_id, user_id)
);

CREATE INDEX IF NOT EXISTS conversation_members_user_idx
    ON conversation_members (user_id, conversation_id);

CREATE TABLE IF NOT EXISTS messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    sender_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    client_message_id text NOT NULL,
    sequence bigint NOT NULL,
    ciphertext bytea NOT NULL,
    nonce bytea NOT NULL,
    encryption_key_version text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz,
    CONSTRAINT messages_client_id_not_blank CHECK (length(trim(client_message_id)) > 0),
    CONSTRAINT messages_sequence_positive CHECK (sequence > 0),
    CONSTRAINT messages_ciphertext_not_empty CHECK (octet_length(ciphertext) > 0),
    CONSTRAINT messages_nonce_not_empty CHECK (octet_length(nonce) > 0),
    CONSTRAINT messages_key_version_not_blank CHECK (length(trim(encryption_key_version)) > 0),
    CONSTRAINT messages_conversation_sequence_unique UNIQUE (conversation_id, sequence),
    CONSTRAINT messages_sender_idempotency_unique UNIQUE (sender_id, client_message_id)
);

CREATE INDEX IF NOT EXISTS messages_history_idx
    ON messages (conversation_id, sequence DESC, id DESC);

CREATE INDEX IF NOT EXISTS messages_expiry_idx
    ON messages (expires_at, id)
    WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS message_delivery (
    message_id uuid NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    device_id uuid NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    delivered_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, device_id)
);

CREATE INDEX IF NOT EXISTS message_delivery_device_pending_idx
    ON message_delivery (device_id, message_id)
    WHERE delivered_at IS NULL;

CREATE TABLE IF NOT EXISTS device_read_cursors (
    device_id uuid NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    conversation_id uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    last_read_sequence bigint NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (device_id, conversation_id),
    CONSTRAINT device_read_cursor_non_negative CHECK (last_read_sequence >= 0)
);

CREATE INDEX IF NOT EXISTS device_read_cursors_conversation_idx
    ON device_read_cursors (conversation_id, device_id);

INSERT INTO schema_migrations (version)
VALUES ('0001_initial')
ON CONFLICT (version) DO NOTHING;

COMMIT;
