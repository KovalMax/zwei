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

// Advance records the highest existing sequence read by an active device in an authorized conversation.
func (r *ReadCursorRepository) Advance(ctx context.Context, deviceID, userID, conversationID uuid.UUID, sequence int64) (int64, error) {
	var cursor int64
	err := r.db.QueryRow(ctx, `INSERT INTO device_read_cursors (device_id, conversation_id, last_read_sequence) SELECT d.id, $3, LEAST($4, COALESCE((SELECT MAX(sequence) FROM messages WHERE conversation_id = $3), 0)) FROM devices d JOIN conversation_members cm ON cm.user_id = d.user_id AND cm.conversation_id = $3 WHERE d.id = $1 AND d.user_id = $2 AND d.revoked_at IS NULL ON CONFLICT (device_id, conversation_id) DO UPDATE SET last_read_sequence = GREATEST(device_read_cursors.last_read_sequence, EXCLUDED.last_read_sequence), updated_at = now() RETURNING last_read_sequence`, deviceID, userID, conversationID, sequence).Scan(&cursor)
	return cursor, err
}
