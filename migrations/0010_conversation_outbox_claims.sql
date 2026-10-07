BEGIN;

ALTER TABLE outbox_events
    ADD COLUMN IF NOT EXISTS claim_token uuid,
    ADD COLUMN IF NOT EXISTS claim_expires_at timestamptz;

CREATE INDEX IF NOT EXISTS outbox_events_claimable_idx
    ON outbox_events (created_at, id)
    WHERE processed_at IS NULL;

INSERT INTO schema_migrations (version)
VALUES ('0010_conversation_outbox_claims')
ON CONFLICT (version) DO NOTHING;

COMMIT;
