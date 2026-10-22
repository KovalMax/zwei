BEGIN;

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS auto_load_approved_media boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS media_source_settings (
    source text PRIMARY KEY,
    enabled boolean NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT media_source_settings_source_valid CHECK (source = 'giphy')
);

INSERT INTO media_source_settings (source, enabled)
VALUES ('giphy', true)
ON CONFLICT (source) DO NOTHING;

INSERT INTO schema_migrations (version)
VALUES ('0016_inline_giphy_settings')
ON CONFLICT (version) DO NOTHING;

COMMIT;
