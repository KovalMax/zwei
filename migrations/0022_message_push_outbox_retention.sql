BEGIN;

-- Pending work has its own partial index (0019). This partial index keeps
-- terminal-row retention from scanning pending work and orders purge batches.
CREATE INDEX IF NOT EXISTS message_push_outbox_processed_retention_idx
    ON message_push_outbox (processed_at, id)
    WHERE processed_at IS NOT NULL;

INSERT INTO schema_migrations (version)
VALUES ('0022_message_push_outbox_retention')
ON CONFLICT (version) DO NOTHING;

COMMIT;
