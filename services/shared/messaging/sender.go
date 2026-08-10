package messaging

import (
	"context"
	"crypto/sha256"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	sharedmessage "github.com/KovalMax/zwei/services/shared/message"
)

// Sender coordinates the durable, idempotent message-send workflow.
type Sender struct {
	db  *pgxpool.Pool
	key []byte
	now func() time.Time
}

func NewSender(db *pgxpool.Pool, encryptionSecret string) *Sender {
	key := sha256.Sum256([]byte(encryptionSecret))
	return &Sender{db: db, key: key[:], now: time.Now}
}

// Send commits a message before returning it. Duplicate client IDs return the original message.
func (s *Sender) Send(ctx context.Context, request SendRequest) (Message, bool, error) {
	request.ClientMessageID = strings.TrimSpace(request.ClientMessageID)
	request.Body = strings.TrimSpace(request.Body)
	if request.SenderID == uuid.Nil || request.ConversationID == uuid.Nil || request.ClientMessageID == "" || len(request.ClientMessageID) > 128 || request.Body == "" || len(request.Body) > 4096 {
		return Message{}, false, ErrInvalidMessage
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Message{}, false, ErrUnavailable
	}
	defer tx.Rollback(ctx)

	var recipient uuid.UUID
	var retention string
	err = tx.QueryRow(ctx, `SELECT CASE WHEN c.user_low_id = $1 THEN c.user_high_id ELSE c.user_low_id END, u.retention_period FROM conversations c JOIN conversation_members m ON m.conversation_id = c.id JOIN users u ON u.id = m.user_id WHERE c.id = $2 AND m.user_id = $1 FOR UPDATE OF c`, request.SenderID, request.ConversationID).Scan(&recipient, &retention)
	if errors.Is(err, pgx.ErrNoRows) {
		return Message{}, false, ErrConversationNotFound
	}
	if err != nil {
		return Message{}, false, ErrPersistence
	}

	var result Message
	var ciphertext, nonce []byte
	err = tx.QueryRow(ctx, `SELECT id, conversation_id, sender_id, client_message_id, sequence, ciphertext, nonce, created_at FROM messages WHERE sender_id = $1 AND client_message_id = $2`, request.SenderID, request.ClientMessageID).Scan(&result.ID, &result.ConversationID, &result.SenderID, &result.ClientMessageID, &result.Sequence, &ciphertext, &nonce, &result.CreatedAt)
	if err == nil {
		result.Body, err = sharedmessage.Decrypt(s.key, ciphertext, nonce)
		if err != nil || tx.Commit(ctx) != nil {
			return Message{}, false, ErrPersistence
		}
		result.RecipientID = recipient
		return result, false, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Message{}, false, ErrPersistence
	}
	if err = tx.QueryRow(ctx, `UPDATE conversations SET next_sequence = next_sequence + 1, last_message_at = now() WHERE id = $1 RETURNING next_sequence - 1`, request.ConversationID).Scan(&result.Sequence); err != nil {
		return Message{}, false, ErrPersistence
	}
	ciphertext, nonce, err = sharedmessage.Encrypt(s.key, []byte(request.Body))
	if err != nil {
		return Message{}, false, ErrPersistence
	}
	var expires *time.Time
	if retention != "forever" {
		duration, ok := map[string]time.Duration{"30d": 30 * 24 * time.Hour, "90d": 90 * 24 * time.Hour, "1y": 365 * 24 * time.Hour}[retention]
		if !ok {
			return Message{}, false, ErrPersistence
		}
		value := s.now().Add(duration)
		expires = &value
	}
	if err = tx.QueryRow(ctx, `INSERT INTO messages (conversation_id, sender_id, client_message_id, sequence, ciphertext, nonce, encryption_key_version, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, created_at`, request.ConversationID, request.SenderID, request.ClientMessageID, result.Sequence, ciphertext, nonce, "v1", expires).Scan(&result.ID, &result.CreatedAt); err != nil {
		return Message{}, false, ErrPersistence
	}
	if _, err = tx.Exec(ctx, `INSERT INTO message_delivery (message_id, device_id) SELECT $1, id FROM devices WHERE user_id = $2 AND revoked_at IS NULL`, result.ID, recipient); err != nil {
		return Message{}, false, ErrPersistence
	}
	if _, err = tx.Exec(ctx, `INSERT INTO user_read_cursors (user_id, conversation_id, last_read_sequence, unread_count) VALUES ($1, $2, 0, 1) ON CONFLICT (user_id, conversation_id) DO UPDATE SET unread_count = user_read_cursors.unread_count + 1, updated_at = now()`, recipient, request.ConversationID); err != nil {
		return Message{}, false, ErrPersistence
	}
	if err = tx.Commit(ctx); err != nil {
		return Message{}, false, ErrPersistence
	}
	result.ConversationID = request.ConversationID
	result.SenderID = request.SenderID
	result.ClientMessageID = request.ClientMessageID
	result.Body = request.Body
	result.RecipientID = recipient
	return result, true, nil
}
