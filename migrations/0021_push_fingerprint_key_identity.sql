BEGIN;

CREATE TABLE IF NOT EXISTS push_fingerprint_key_identity (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    key_id bytea NOT NULL CHECK (octet_length(key_id) = 32)
);

INSERT INTO schema_migrations (version)
VALUES ('0021_push_fingerprint_key_identity')
ON CONFLICT (version) DO NOTHING;

COMMIT;
