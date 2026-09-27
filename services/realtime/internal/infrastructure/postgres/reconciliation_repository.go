package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/KovalMax/zwei/services/realtime/internal/application"
	sharedmessage "github.com/KovalMax/zwei/services/shared/message"
	"github.com/KovalMax/zwei/services/shared/messaging"
)

type ReconciliationRepository struct {
	db  *pgxpool.Pool
	key []byte
}

func NewReconciliationRepository(db *pgxpool.Pool, encryptionSecret string) *ReconciliationRepository {
	key := sha256.Sum256([]byte(encryptionSecret))
	return &ReconciliationRepository{db: db, key: key[:]}
}

// Reconcile returns only messages after afterSequence for a current conversation member.
func (r *ReconciliationRepository) Reconcile(ctx context.Context, userID, conversationID uuid.UUID, afterSequence int64, limit int) (application.Reconciliation, error) {
	if userID == uuid.Nil || conversationID == uuid.Nil || afterSequence < 0 || limit < 1 {
		return application.Reconciliation{}, errors.New("invalid reconciliation request")
	}
	if limit > application.ReconciliationMessageLimit {
		limit = application.ReconciliationMessageLimit
	}

	result := application.Reconciliation{ConversationID: conversationID}
	rows, err := r.db.Query(ctx, `
		WITH authorized AS (
			SELECT c.kind, c.next_sequence - 1 AS high_watermark,
				member.visible_from_sequence,
				COALESCE((SELECT last_read_sequence FROM user_read_cursors WHERE user_id = $1 AND conversation_id = c.id), 0) AS own_read_sequence,
				CASE WHEN c.kind = 'direct' THEN COALESCE((SELECT last_read_sequence FROM user_read_cursors WHERE user_id <> $1 AND conversation_id = c.id LIMIT 1), 0) ELSE 0 END AS peer_read_sequence,
				CASE WHEN c.kind = 'group' THEN COALESCE((
					SELECT jsonb_agg(jsonb_build_object('user_id', peer.user_id, 'sequence', COALESCE(cursor.last_read_sequence, 0), 'visible_from_sequence', peer.visible_from_sequence) ORDER BY peer.user_id)
					FROM conversation_members peer
					LEFT JOIN user_read_cursors cursor ON cursor.user_id = peer.user_id AND cursor.conversation_id = c.id
					WHERE peer.conversation_id = c.id AND peer.active AND peer.user_id <> $1
				), '[]'::jsonb) ELSE NULL END AS peer_read_cursors
			FROM conversations c
			JOIN conversation_members member ON member.conversation_id = c.id AND member.user_id = $1 AND member.active
			WHERE c.id = $2
		)
		SELECT authorized.high_watermark, authorized.own_read_sequence, authorized.peer_read_sequence, authorized.peer_read_cursors,
			message.id, message.sender_id, message.client_message_id, message.sequence,
			message.ciphertext, message.nonce, message.created_at, message.kind
		FROM authorized
		LEFT JOIN LATERAL (
			SELECT id, sender_id, client_message_id, sequence, ciphertext, nonce, created_at, kind
			FROM messages
			WHERE conversation_id = $2
				AND sequence > GREATEST($3, authorized.visible_from_sequence - 1)
				AND sequence <= authorized.high_watermark
				AND (expires_at IS NULL OR expires_at > now())
			ORDER BY sequence
			LIMIT $4
		) message ON true
		ORDER BY message.sequence`, userID, conversationID, afterSequence, limit+1)
	if err != nil {
		return application.Reconciliation{}, err
	}
	defer rows.Close()
	authorized := false
	for rows.Next() {
		var highWatermark, ownReadSequence, peerReadSequence int64
		var peerReadCursors []byte
		var messageID, senderID pgtype.UUID
		var clientMessageID, kind pgtype.Text
		var sequence pgtype.Int8
		var createdAt pgtype.Timestamptz
		var message messaging.Message
		var ciphertext, nonce []byte
		if err := rows.Scan(&highWatermark, &ownReadSequence, &peerReadSequence, &peerReadCursors, &messageID, &senderID, &clientMessageID, &sequence, &ciphertext, &nonce, &createdAt, &kind); err != nil {
			return application.Reconciliation{}, err
		}
		authorized = true
		result.HighWatermark = highWatermark
		result.OwnReadSequence = ownReadSequence
		result.PeerReadSequence = peerReadSequence
		if peerReadCursors != nil {
			if err := json.Unmarshal(peerReadCursors, &result.PeerReadCursors); err != nil {
				return application.Reconciliation{}, errors.New("could not decode peer read cursors")
			}
		}
		if !messageID.Valid {
			continue
		}
		message.ID = uuid.UUID(messageID.Bytes)
		message.ConversationID = conversationID
		message.SenderID = uuid.UUID(senderID.Bytes)
		message.ClientMessageID = clientMessageID.String
		message.Sequence = sequence.Int64
		message.CreatedAt = createdAt.Time
		message.Kind = kind.String
		message.Body, err = sharedmessage.Decrypt(r.key, ciphertext, nonce)
		if err != nil {
			return application.Reconciliation{}, errors.New("could not decrypt reconciled message")
		}
		result.Messages = append(result.Messages, message)
	}
	if err := rows.Err(); err != nil {
		return application.Reconciliation{}, err
	}
	if !authorized {
		return application.Reconciliation{}, errors.New("conversation not found")
	}
	result.NextAfterSequence = afterSequence
	if len(result.Messages) > limit {
		result.HasMore = true
		result.Messages = result.Messages[:limit]
	}
	if len(result.Messages) > 0 {
		result.NextAfterSequence = result.Messages[len(result.Messages)-1].Sequence
	}
	return result, nil
}
