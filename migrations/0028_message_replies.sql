BEGIN;

ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_message_id uuid;

INSERT INTO schema_migrations (version) VALUES ('0028_message_replies')
ON CONFLICT (version) DO NOTHING;

COMMIT;
