BEGIN;

-- Local runners replay every file. Serialize concurrent runners and record the
-- irreversible revocation in the same transaction as its one-time marker.
SELECT pg_advisory_xact_lock(1515668809, 24);
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0024_v2_session_cutover') THEN
        UPDATE users SET session_version = session_version + 1;
        UPDATE sessions SET revoked_at = now() WHERE revoked_at IS NULL;
        INSERT INTO schema_migrations (version) VALUES ('0024_v2_session_cutover');
    END IF;
END $$;
COMMIT;
