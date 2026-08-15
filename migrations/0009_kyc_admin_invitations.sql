BEGIN;

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS kyc_status smallint NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS email_verified_at timestamptz DEFAULT now(),
    ADD COLUMN IF NOT EXISTS activation_token_hash bytea,
    ADD COLUMN IF NOT EXISTS activation_expires_at timestamptz;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_kyc_status_valid') THEN
        ALTER TABLE users ADD CONSTRAINT users_kyc_status_valid CHECK (kyc_status IN (1, 2, 3));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS users_kyc_status_created_idx ON users (kyc_status, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS invitation_codes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text NOT NULL,
    code_hash bytea NOT NULL,
    created_by uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    expires_at timestamptz NOT NULL,
    redeemed_at timestamptz,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT invitation_codes_email_lowercase CHECK (email = lower(email)),
    CONSTRAINT invitation_codes_email_not_blank CHECK (length(trim(email)) > 3),
    CONSTRAINT invitation_codes_hash_unique UNIQUE (code_hash)
);

CREATE INDEX IF NOT EXISTS invitation_codes_active_idx
    ON invitation_codes (email, expires_at DESC)
    WHERE redeemed_at IS NULL AND revoked_at IS NULL;

INSERT INTO schema_migrations (version)
VALUES ('0009_kyc_admin_invitations')
ON CONFLICT (version) DO NOTHING;

COMMIT;
