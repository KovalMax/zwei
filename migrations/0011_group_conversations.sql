BEGIN;

ALTER TABLE conversations
    ALTER COLUMN user_low_id DROP NOT NULL,
    ALTER COLUMN user_high_id DROP NOT NULL,
    DROP CONSTRAINT IF EXISTS conversations_distinct_users,
    DROP CONSTRAINT IF EXISTS conversations_ordered_users,
    DROP CONSTRAINT IF EXISTS conversations_users_unique;

ALTER TABLE conversations
    ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'direct',
    ADD COLUMN IF NOT EXISTS group_name text,
    ADD COLUMN IF NOT EXISTS group_avatar_seed uuid,
    ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES users (id) ON DELETE RESTRICT,
    ADD COLUMN IF NOT EXISTS membership_revision bigint NOT NULL DEFAULT 1;

DO $$ BEGIN
    ALTER TABLE conversations ADD CONSTRAINT conversations_kind_valid CHECK (kind IN ('direct', 'group'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE conversations ADD CONSTRAINT conversations_membership_revision_positive CHECK (membership_revision > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE conversations ADD CONSTRAINT conversations_shape_valid CHECK (
        (kind = 'direct' AND user_low_id IS NOT NULL AND user_high_id IS NOT NULL AND group_name IS NULL AND owner_id IS NULL) OR
        (kind = 'group' AND user_low_id IS NULL AND user_high_id IS NULL AND group_name IS NOT NULL AND length(trim(group_name)) BETWEEN 1 AND 80 AND owner_id IS NOT NULL)
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS conversations_direct_users_unique
    ON conversations (user_low_id, user_high_id)
    WHERE kind = 'direct';

ALTER TABLE conversation_members
    ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'member',
    ADD COLUMN IF NOT EXISTS visible_from_sequence bigint NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS left_at timestamptz;

DO $$ BEGIN
    ALTER TABLE conversation_members ADD CONSTRAINT conversation_members_role_valid CHECK (role IN ('owner', 'admin', 'member'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE conversation_members ADD CONSTRAINT conversation_members_visible_sequence_positive CHECK (visible_from_sequence > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE conversation_members ADD CONSTRAINT conversation_members_active_shape CHECK ((active AND left_at IS NULL) OR (NOT active AND left_at IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS conversation_members_active_user_idx
    ON conversation_members (user_id, conversation_id)
    WHERE active;

ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'user';

DO $$ BEGIN
    ALTER TABLE messages ADD CONSTRAINT messages_kind_valid CHECK (kind IN ('user', 'system'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

INSERT INTO schema_migrations (version)
VALUES ('0011_group_conversations')
ON CONFLICT (version) DO NOTHING;

COMMIT;
