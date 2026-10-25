BEGIN;

CREATE TABLE IF NOT EXISTS message_push_outbox (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id uuid NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    conversation_id uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    sender_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    recipient_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    event_type text NOT NULL DEFAULT 'message.push' CHECK (event_type = 'message.push'),
    expires_at timestamptz NOT NULL,
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0 AND attempt_count <= 12),
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    claim_token uuid,
    claim_expires_at timestamptz,
    processed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT message_push_outbox_idempotency UNIQUE (message_id, recipient_id, event_type),
    CONSTRAINT message_push_outbox_claim_pair CHECK ((claim_token IS NULL) = (claim_expires_at IS NULL))
);

CREATE INDEX IF NOT EXISTS message_push_outbox_pending_idx
    ON message_push_outbox (next_attempt_at, expires_at, created_at)
    WHERE processed_at IS NULL;

INSERT INTO schema_migrations (version)
VALUES ('0019_message_push_outbox')
ON CONFLICT (version) DO NOTHING;

COMMIT;
