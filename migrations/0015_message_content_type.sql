ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS content_type text NOT NULL DEFAULT 'text';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'messages_content_type_check'
          AND conrelid = 'messages'::regclass
    ) THEN
        ALTER TABLE messages
            ADD CONSTRAINT messages_content_type_check
            CHECK (content_type IN ('text', 'sticker'));
    END IF;
END $$;
