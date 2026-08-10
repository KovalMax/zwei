CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX CONCURRENTLY IF NOT EXISTS users_display_name_lower_trgm_idx
    ON users USING gin (lower(display_name) gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS users_email_lower_trgm_idx
    ON users USING gin (lower(email) gin_trgm_ops);

INSERT INTO schema_migrations (version)
VALUES ('0005_chat_search_indexes')
ON CONFLICT (version) DO NOTHING;
