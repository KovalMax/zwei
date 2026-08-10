DROP INDEX CONCURRENTLY IF EXISTS messages_history_idx;

INSERT INTO schema_migrations (version)
VALUES ('0006_drop_redundant_message_history_index')
ON CONFLICT (version) DO NOTHING;
