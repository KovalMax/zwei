BEGIN;

-- Receipts contain only a hash of a separate bearer secret, never the secret.
CREATE TABLE IF NOT EXISTS browser_logout_receipts (
    receipt_hash bytea PRIMARY KEY CHECK (octet_length(receipt_hash) = 32),
    browser_id uuid NOT NULL,
    generation uuid NOT NULL,
    user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL
);

INSERT INTO schema_migrations (version) VALUES ('0025_browser_logout_receipts') ON CONFLICT (version) DO NOTHING;
COMMIT;
