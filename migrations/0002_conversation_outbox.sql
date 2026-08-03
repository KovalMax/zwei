BEGIN;

CREATE TABLE IF NOT EXISTS outbox_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type text NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz,
    CONSTRAINT outbox_events_type_not_blank CHECK (length(trim(event_type)) > 0)
);

CREATE INDEX IF NOT EXISTS outbox_events_pending_idx
    ON outbox_events (created_at, id)
    WHERE processed_at IS NULL;

INSERT INTO schema_migrations (version)
VALUES ('0002_conversation_outbox')
ON CONFLICT (version) DO NOTHING;

COMMIT;
