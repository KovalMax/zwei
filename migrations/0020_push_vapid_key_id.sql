BEGIN;

-- Existing registrations have no provable enrollment key. Leave NULL so they
-- are suppressed until the browser explicitly re-enrolls under the served key.
ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS vapid_key_id text;
ALTER TABLE push_subscriptions DROP CONSTRAINT IF EXISTS push_subscriptions_version_valid;
ALTER TABLE push_subscriptions ADD CONSTRAINT push_subscriptions_version_valid CHECK (encryption_version IN ('v1', 'v2'));

INSERT INTO schema_migrations (version)
VALUES ('0020_push_vapid_key_id')
ON CONFLICT (version) DO NOTHING;

COMMIT;
