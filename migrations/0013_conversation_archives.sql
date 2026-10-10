CREATE TABLE IF NOT EXISTS conversation_archives (
    conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    archived_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (conversation_id, user_id)
);

CREATE INDEX IF NOT EXISTS conversation_archives_user_idx ON conversation_archives (user_id, conversation_id);

INSERT INTO schema_migrations (version)
VALUES ('0013_conversation_archives')
ON CONFLICT (version) DO NOTHING;
