BEGIN;

ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS activation_token_purpose text;
CREATE INDEX IF NOT EXISTS users_activation_token_hash_idx
    ON users (activation_token_hash)
    WHERE activation_token_hash IS NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_activation_token_purpose_check') THEN
        ALTER TABLE users ADD CONSTRAINT users_activation_token_purpose_check
            CHECK (activation_token_purpose IS NULL OR activation_token_purpose IN ('setup', 'admin'));
    END IF;
END $$;

INSERT INTO schema_migrations (version) VALUES ('0029_password_setup_tokens')
ON CONFLICT (version) DO NOTHING;

COMMIT;
