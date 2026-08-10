ALTER TABLE conversations
    ADD COLUMN IF NOT EXISTS last_message_at timestamptz;

UPDATE conversations c
SET last_message_at = latest.created_at
FROM (
    SELECT DISTINCT ON (conversation_id) conversation_id, created_at
    FROM messages
    ORDER BY conversation_id, created_at DESC, id DESC
) AS latest
WHERE c.id = latest.conversation_id
  AND c.last_message_at IS DISTINCT FROM latest.created_at;

CREATE INDEX CONCURRENTLY IF NOT EXISTS conversations_last_message_idx
    ON conversations (last_message_at DESC, id DESC);

INSERT INTO schema_migrations (version)
VALUES ('0007_conversation_last_message_at')
ON CONFLICT (version) DO NOTHING;
