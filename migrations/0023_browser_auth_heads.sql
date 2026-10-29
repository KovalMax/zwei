BEGIN;

-- Browser IDs are selectors, never credentials. Existing sessions are not
-- backfilled: clients must authenticate again when the new protocol is enabled.
CREATE TABLE IF NOT EXISTS browser_auth_heads (
    browser_id uuid PRIMARY KEY,
    generation uuid NOT NULL,
    user_id uuid REFERENCES users (id) ON DELETE CASCADE,
    current_refresh_hash bytea,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT browser_auth_heads_state CHECK ((user_id IS NULL) = (current_refresh_hash IS NULL)),
    CONSTRAINT browser_auth_heads_hash_length CHECK (current_refresh_hash IS NULL OR octet_length(current_refresh_hash) = 32)
);

CREATE INDEX IF NOT EXISTS browser_auth_heads_current_refresh_hash_idx
    ON browser_auth_heads (current_refresh_hash) WHERE current_refresh_hash IS NOT NULL;

INSERT INTO schema_migrations (version) VALUES ('0023_browser_auth_heads') ON CONFLICT (version) DO NOTHING;
COMMIT;
