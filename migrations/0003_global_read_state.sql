BEGIN;

CREATE TABLE IF NOT EXISTS user_read_cursors (
    user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    conversation_id uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    last_read_sequence bigint NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, conversation_id),
    CONSTRAINT user_read_cursor_non_negative CHECK (last_read_sequence >= 0)
);

INSERT INTO user_read_cursors (user_id, conversation_id, last_read_sequence, updated_at)
SELECT d.user_id, c.conversation_id, MAX(c.last_read_sequence), MAX(c.updated_at)
FROM device_read_cursors c
JOIN devices d ON d.id = c.device_id
GROUP BY d.user_id, c.conversation_id
ON CONFLICT (user_id, conversation_id) DO UPDATE
SET last_read_sequence = GREATEST(user_read_cursors.last_read_sequence, EXCLUDED.last_read_sequence),
    updated_at = GREATEST(user_read_cursors.updated_at, EXCLUDED.updated_at);

DROP TABLE IF EXISTS device_read_cursors;

INSERT INTO schema_migrations (version)
VALUES ('0003_global_read_state')
ON CONFLICT (version) DO NOTHING;

COMMIT;
