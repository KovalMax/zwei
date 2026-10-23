BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS devices_user_id_id_unique ON devices (user_id, id);

ALTER TABLE push_subscriptions DROP CONSTRAINT IF EXISTS push_subscriptions_device_id_fkey;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'push_subscriptions'::regclass
          AND conname = 'push_subscriptions_user_device_fk'
    ) THEN
        ALTER TABLE push_subscriptions
            ADD CONSTRAINT push_subscriptions_user_device_fk
            FOREIGN KEY (user_id, device_id) REFERENCES devices (user_id, id) ON DELETE CASCADE;
    END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS push_subscriptions_user_id_idx ON push_subscriptions (user_id);

INSERT INTO schema_migrations (version)
VALUES ('0018_push_subscription_device_ownership')
ON CONFLICT (version) DO NOTHING;

COMMIT;
