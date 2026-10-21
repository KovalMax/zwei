BEGIN;

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS alert_mode text NOT NULL DEFAULT 'off';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_alert_mode_valid') THEN
        ALTER TABLE users ADD CONSTRAINT users_alert_mode_valid
            CHECK (alert_mode IN ('off', 'sounds', 'notifications'));
    END IF;
END;
$$;

INSERT INTO schema_migrations (version)
VALUES ('0015_user_alert_mode')
ON CONFLICT (version) DO NOTHING;

COMMIT;
