CREATE INDEX CONCURRENTLY IF NOT EXISTS conversations_user_high_idx
    ON conversations (user_high_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_conversation_created_idx
    ON messages (conversation_id, created_at DESC, id DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_unread_idx
    ON messages (conversation_id, sequence) INCLUDE (sender_id);

INSERT INTO schema_migrations (version)
VALUES ('0004_global_read_indexes')
ON CONFLICT (version) DO NOTHING;
