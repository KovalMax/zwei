BEGIN;

-- Requires the maintenance barrier: all Auth and Realtime replicas and the
-- public edge must be stopped until this migration and deployment complete.
-- Existing registrations cannot be associated safely with browser heads.
-- This deletion is irreversible; users must re-enable push after cutover.
SELECT pg_advisory_xact_lock(1515668809, 27);
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0027_v2_push_cutover') THEN
        DELETE FROM push_subscriptions;
        INSERT INTO schema_migrations (version) VALUES ('0027_v2_push_cutover');
    END IF;
END $$;
COMMIT;
