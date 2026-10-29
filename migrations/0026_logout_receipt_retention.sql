BEGIN;

ALTER TABLE browser_logout_receipts ADD COLUMN IF NOT EXISTS refresh_hash bytea;
CREATE INDEX IF NOT EXISTS browser_logout_receipts_expires_at_idx ON browser_logout_receipts (expires_at);
INSERT INTO schema_migrations (version) VALUES ('0026_logout_receipt_retention') ON CONFLICT (version) DO NOTHING;
COMMIT;
