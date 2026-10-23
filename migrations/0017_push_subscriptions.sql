BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS devices_user_id_id_unique ON devices (user_id, id);

CREATE TABLE IF NOT EXISTS push_subscriptions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    device_id uuid NOT NULL,
    endpoint_fingerprint bytea NOT NULL,
    encryption_version text NOT NULL,
    encrypted_subscription bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT push_subscriptions_fingerprint_unique UNIQUE (endpoint_fingerprint),
    CONSTRAINT push_subscriptions_device_unique UNIQUE (device_id),
    CONSTRAINT push_subscriptions_user_device_fk FOREIGN KEY (user_id, device_id) REFERENCES devices (user_id, id) ON DELETE CASCADE,
    CONSTRAINT push_subscriptions_fingerprint_length CHECK (octet_length(endpoint_fingerprint) = 32),
    CONSTRAINT push_subscriptions_version_valid CHECK (encryption_version = 'v1'),
    CONSTRAINT push_subscriptions_payload_not_empty CHECK (octet_length(encrypted_subscription) > 0)
);

CREATE INDEX IF NOT EXISTS push_subscriptions_user_id_idx ON push_subscriptions (user_id);

INSERT INTO schema_migrations (version)
VALUES ('0017_push_subscriptions')
ON CONFLICT (version) DO NOTHING;

COMMIT;
