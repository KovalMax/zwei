package postgres

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type ReadCursorRepository struct{ db *pgxpool.Pool }

func NewReadCursorRepository(db *pgxpool.Pool) *ReadCursorRepository {
	return &ReadCursorRepository{db: db}
}

// Advance records the highest existing sequence read by a user in an authorized conversation.
func (r *ReadCursorRepository) Advance(ctx context.Context, userID, conversationID uuid.UUID, sequence int64) (int64, error) {
	var cursor int64
	err := r.db.QueryRow(ctx, `WITH requested AS (SELECT LEAST($3, COALESCE((SELECT sequence FROM messages WHERE conversation_id = $2 ORDER BY sequence DESC LIMIT 1), 0)) AS sequence WHERE EXISTS (SELECT 1 FROM conversation_members WHERE user_id = $1 AND conversation_id = $2)) INSERT INTO user_read_cursors (user_id, conversation_id, last_read_sequence, unread_count) SELECT $1, $2, requested.sequence, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = $2 AND m.sender_id <> $1 AND m.sequence > requested.sequence) FROM requested ON CONFLICT (user_id, conversation_id) DO UPDATE SET last_read_sequence = GREATEST(user_read_cursors.last_read_sequence, EXCLUDED.last_read_sequence), unread_count = CASE WHEN EXCLUDED.last_read_sequence > user_read_cursors.last_read_sequence THEN EXCLUDED.unread_count ELSE user_read_cursors.unread_count END, updated_at = now() RETURNING last_read_sequence`, userID, conversationID, sequence).Scan(&cursor)
	return cursor, err
}
