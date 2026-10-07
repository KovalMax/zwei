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

// Send commits a message before returning it. Duplicate client IDs return the original message only within the same conversation.
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

	var retention string
	err = tx.QueryRow(ctx, `SELECT u.retention_period FROM conversations c JOIN conversation_members m ON m.conversation_id = c.id AND m.user_id = $1 AND m.active JOIN users u ON u.id = $1 WHERE c.id = $2 FOR UPDATE OF c`, request.SenderID, request.ConversationID).Scan(&retention)
	if errors.Is(err, pgx.ErrNoRows) {
		return Message{}, false, ErrConversationNotFound
	}
	if err != nil {
		return Message{}, false, ErrPersistence
	}

	var result Message
	var ciphertext, nonce []byte
	var expiresAt *time.Time
	err = tx.QueryRow(ctx, `SELECT id, conversation_id, sender_id, client_message_id, sequence, ciphertext, nonce, created_at, kind, expires_at FROM messages WHERE sender_id = $1 AND client_message_id = $2`, request.SenderID, request.ClientMessageID).Scan(&result.ID, &result.ConversationID, &result.SenderID, &result.ClientMessageID, &result.Sequence, &ciphertext, &nonce, &result.CreatedAt, &result.Kind, &expiresAt)
	if err == nil {
		if result.ConversationID != request.ConversationID {
			return Message{}, false, ErrClientMessageIDConflict
		}
		if expiresAt != nil && !expiresAt.After(s.now()) {
			return Message{}, false, ErrMessageExpired
		}
		result.Body, err = sharedmessage.Decrypt(s.key, ciphertext, nonce)
		if err != nil {
			return Message{}, false, ErrPersistence
		}
		result.RecipientIDs, err = s.recipientIDs(ctx, tx, request.SenderID, request.ConversationID)
		if err != nil {
			return Message{}, false, ErrPersistence
		}
		if err = tx.Commit(ctx); err != nil {
			return Message{}, false, ErrPersistence
		}
		if len(result.RecipientIDs) == 1 {
			result.RecipientID = result.RecipientIDs[0]
		}
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
	result.RecipientIDs, err = s.recipientIDs(ctx, tx, request.SenderID, request.ConversationID)
	if err != nil {
		return Message{}, false, ErrPersistence
	}
	if _, err = tx.Exec(ctx, `INSERT INTO message_delivery (message_id, device_id) SELECT $1, d.id FROM devices d JOIN conversation_members m ON m.user_id = d.user_id WHERE m.conversation_id = $2 AND m.active AND m.user_id <> $3 AND d.revoked_at IS NULL`, result.ID, request.ConversationID, request.SenderID); err != nil {
		return Message{}, false, ErrPersistence
	}
	if _, err = tx.Exec(ctx, `INSERT INTO user_read_cursors (user_id, conversation_id, last_read_sequence, unread_count) SELECT m.user_id, $1, m.visible_from_sequence - 1, 1 FROM conversation_members m WHERE m.conversation_id = $1 AND m.active AND m.user_id <> $2 ON CONFLICT (user_id, conversation_id) DO UPDATE SET unread_count = user_read_cursors.unread_count + 1, updated_at = now()`, request.ConversationID, request.SenderID); err != nil {
		return Message{}, false, ErrPersistence
	}
	if err = tx.Commit(ctx); err != nil {
		return Message{}, false, ErrPersistence
	}
	result.ConversationID = request.ConversationID
	result.SenderID = request.SenderID
	result.ClientMessageID = request.ClientMessageID
	result.Body = request.Body
	result.Kind = "user"
	if len(result.RecipientIDs) == 1 {
		result.RecipientID = result.RecipientIDs[0]
	}
	return result, true, nil
}

func (s *Sender) recipientIDs(ctx context.Context, tx pgx.Tx, senderID, conversationID uuid.UUID) ([]uuid.UUID, error) {
	rows, err := tx.Query(ctx, `SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND active AND user_id <> $2`, conversationID, senderID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var recipients []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		recipients = append(recipients, id)
	}
	return recipients, rows.Err()
}
