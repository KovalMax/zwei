package messaging

import (
	"context"
	"crypto/sha256"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	sharedmessage "github.com/KovalMax/zwei/services/shared/message"
)

// DeliveryRepository replays messages that were accepted while a recipient device was offline.
type DeliveryRepository struct {
	db  *pgxpool.Pool
	key []byte
}

func NewDeliveryRepository(db *pgxpool.Pool, encryptionSecret string) *DeliveryRepository {
	key := sha256.Sum256([]byte(encryptionSecret))
	return &DeliveryRepository{db: db, key: key[:]}
}

func (r *DeliveryRepository) Pending(ctx context.Context, deviceID uuid.UUID, limit int) ([]Message, error) {
	// Delivery rows are created at send time, but group membership and history
	// visibility can change before a device reconnects. Re-check the current
	// authoritative membership here so an old pending row cannot disclose a
	// message to a removed member (or one from before a later rejoin).
	rows, err := r.db.Query(ctx, `SELECT m.id, m.conversation_id, m.sender_id, m.client_message_id, m.sequence, m.ciphertext, m.nonce, m.created_at, m.kind FROM message_delivery d JOIN devices device ON device.id = d.device_id JOIN messages m ON m.id = d.message_id JOIN conversation_members member ON member.conversation_id = m.conversation_id AND member.user_id = device.user_id AND member.active AND m.sequence >= member.visible_from_sequence WHERE d.device_id = $1 AND d.delivered_at IS NULL AND device.revoked_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > now()) ORDER BY m.created_at, m.id LIMIT $2`, deviceID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	messages := make([]Message, 0)
	for rows.Next() {
		var message Message
		var ciphertext, nonce []byte
		if err := rows.Scan(&message.ID, &message.ConversationID, &message.SenderID, &message.ClientMessageID, &message.Sequence, &ciphertext, &nonce, &message.CreatedAt, &message.Kind); err != nil {
			return nil, err
		}
		body, err := sharedmessage.Decrypt(r.key, ciphertext, nonce)
		if err != nil {
			return nil, errors.New("could not decrypt pending message")
		}
		message.Body = body
		messages = append(messages, message)
	}
	return messages, rows.Err()
}

func (r *DeliveryRepository) MarkDelivered(ctx context.Context, deviceID uuid.UUID, messageIDs []uuid.UUID) error {
	if len(messageIDs) == 0 {
		return nil
	}
	_, err := r.db.Exec(ctx, `UPDATE message_delivery SET delivered_at = now() WHERE device_id = $1 AND message_id = ANY($2) AND delivered_at IS NULL`, deviceID, messageIDs)
	return err
}
