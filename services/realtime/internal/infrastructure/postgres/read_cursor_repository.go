package postgres

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/KovalMax/zwei/services/realtime/internal/application"
)

type ReadCursorRepository struct{ db *pgxpool.Pool }

func NewReadCursorRepository(db *pgxpool.Pool) *ReadCursorRepository {
	return &ReadCursorRepository{db: db}
}

// Advance records the highest existing sequence read by a user in an authorized conversation.
func (r *ReadCursorRepository) Advance(ctx context.Context, userID, conversationID uuid.UUID, sequence int64) (application.ReadAdvance, error) {
	var advance application.ReadAdvance
	cursor := &advance.Cursor
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return advance, err
	}
	defer tx.Rollback(ctx)

	// Sender.Send and group membership changes serialize on the conversation row.
	// Lock before reading membership, recipient eligibility, or message count.
	var lockedConversation uuid.UUID
	err = tx.QueryRow(ctx, `SELECT id FROM conversations WHERE id = $1 FOR UPDATE`, conversationID).Scan(&lockedConversation)
	if err != nil {
		return application.ReadAdvance{}, err
	}
	// Use a fresh READ COMMITTED statement after the lock wait. It both proves
	// current authorization and obtains the membership visibility boundary.
	err = tx.QueryRow(ctx, `SELECT COALESCE(m.visible_from_sequence, 1)
		FROM conversations c
		LEFT JOIN conversation_members m ON m.conversation_id = c.id AND m.user_id = $1 AND m.active
		WHERE c.id = $2 AND ((c.kind = 'direct' AND (c.user_low_id = $1 OR c.user_high_id = $1)) OR m.user_id IS NOT NULL)`, userID, conversationID).Scan(&cursor.VisibleFromSequence)
	if err != nil {
		return application.ReadAdvance{}, err
	}

	// Membership changes serialize on the same conversation row as this cursor
	// transaction. Resolve recipients only after obtaining that lock, in this
	// transaction, so a revoke cannot slip between recipient selection and the
	// cursor update/fan-out authorization.
	rows, err := tx.Query(ctx, `SELECT peer_id FROM (
		SELECT CASE WHEN c.user_low_id = $2 THEN c.user_high_id ELSE c.user_low_id END AS peer_id
		FROM conversations c WHERE c.id = $1 AND c.kind = 'direct' AND (c.user_low_id = $2 OR c.user_high_id = $2)
		UNION ALL
		SELECT member.user_id AS peer_id FROM conversations c
		JOIN conversation_members member ON member.conversation_id = c.id AND member.active AND member.user_id <> $2
		JOIN conversation_members reader ON reader.conversation_id = c.id AND reader.user_id = $2 AND reader.active
		WHERE c.id = $1 AND c.kind = 'group'
	) authorized_peers ORDER BY peer_id`, conversationID, userID)
	if err != nil {
		return application.ReadAdvance{}, err
	}
	for rows.Next() {
		var recipientID uuid.UUID
		if err := rows.Scan(&recipientID); err != nil {
			rows.Close()
			return application.ReadAdvance{}, err
		}
		advance.RecipientIDs = append(advance.RecipientIDs, recipientID)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return application.ReadAdvance{}, err
	}
	rows.Close()

	// This is deliberately a second READ COMMITTED statement: if we waited on a
	// sender's conversation lock, its committed message and unread increment are
	// visible in this statement's snapshot.
	err = tx.QueryRow(ctx, `WITH requested AS (
		SELECT GREATEST($4 - 1, LEAST($3, COALESCE((
			SELECT sequence FROM messages WHERE conversation_id = $2 AND sequence >= $4 ORDER BY sequence DESC LIMIT 1
		), $4 - 1))) AS sequence
	), advanced AS (
		INSERT INTO user_read_cursors (user_id, conversation_id, last_read_sequence, unread_count)
		SELECT $1, $2, requested.sequence, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = $2 AND m.sender_id <> $1 AND m.sequence >= $4 AND m.sequence > requested.sequence)
		FROM requested
		ON CONFLICT (user_id, conversation_id) DO UPDATE
		SET last_read_sequence = GREATEST(user_read_cursors.last_read_sequence, EXCLUDED.last_read_sequence),
			unread_count = CASE WHEN EXCLUDED.last_read_sequence > user_read_cursors.last_read_sequence THEN EXCLUDED.unread_count ELSE user_read_cursors.unread_count END,
			updated_at = now()
		RETURNING last_read_sequence
	)
	SELECT advanced.last_read_sequence FROM advanced`, userID, conversationID, sequence, cursor.VisibleFromSequence).Scan(&cursor.Sequence)
	if err != nil {
		return application.ReadAdvance{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return application.ReadAdvance{}, err
	}
	return advance, nil
}
