ALTER TABLE user_read_cursors
    ADD COLUMN IF NOT EXISTS unread_count bigint NOT NULL DEFAULT 0;

UPDATE user_read_cursors rc
SET unread_count = (
    SELECT COUNT(*)
    FROM messages m
    WHERE m.conversation_id = rc.conversation_id
      AND m.sender_id <> rc.user_id
      AND m.sequence > rc.last_read_sequence
);

INSERT INTO user_read_cursors (user_id, conversation_id, last_read_sequence, unread_count)
SELECT cm.user_id, cm.conversation_id, 0, COUNT(m.id)
FROM conversation_members cm
LEFT JOIN messages m
    ON m.conversation_id = cm.conversation_id
   AND m.sender_id <> cm.user_id
GROUP BY cm.user_id, cm.conversation_id
ON CONFLICT (user_id, conversation_id) DO NOTHING;

INSERT INTO schema_migrations (version)
VALUES ('0008_user_unread_counts')
ON CONFLICT (version) DO NOTHING;
