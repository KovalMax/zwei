package postgres

import (
	"context"
	"crypto/sha256"
	"errors"
	"strconv"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/maxkoval/p2p-webchat/services/chat/internal/domain/conversation"
	sharedmessage "github.com/maxkoval/p2p-webchat/services/shared/message"
)

type HistoryRepository struct {
	db  *pgxpool.Pool
	key []byte
}

func NewHistoryRepository(db *pgxpool.Pool, encryptionSecret string) *HistoryRepository {
	key := sha256.Sum256([]byte(encryptionSecret))
	return &HistoryRepository{db: db, key: key[:]}
}

func (r *HistoryRepository) List(ctx context.Context, userID, conversationID uuid.UUID, before int64, limit int) ([]conversation.Message, string, error) {
	var member bool
	if err := r.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2)`, conversationID, userID).Scan(&member); err != nil {
		return nil, "", err
	}
	if !member {
		return nil, "", ErrNotFound
	}
	rows, err := r.db.Query(ctx, `SELECT id, conversation_id, sender_id, client_message_id, sequence, ciphertext, nonce, created_at FROM messages WHERE conversation_id = $1 AND ($2 = 0 OR sequence < $2) AND (expires_at IS NULL OR expires_at > now()) ORDER BY sequence DESC LIMIT $3`, conversationID, before, limit+1)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	messages := make([]conversation.Message, 0, limit)
	for rows.Next() {
		var message conversation.Message
		var ciphertext, nonce []byte
		if err := rows.Scan(&message.ID, &message.ConversationID, &message.SenderID, &message.ClientMessageID, &message.Sequence, &ciphertext, &nonce, &message.CreatedAt); err != nil {
			return nil, "", err
		}
		body, err := sharedmessage.Decrypt(r.key, ciphertext, nonce)
		if err != nil {
			return nil, "", errors.New("could not decrypt history")
		}
		message.Body = body
		messages = append(messages, message)
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	nextCursor := ""
	if len(messages) > limit {
		nextCursor = strconv.FormatInt(messages[limit-1].Sequence, 10)
		messages = messages[:limit]
	}
	return messages, nextCursor, nil
}
