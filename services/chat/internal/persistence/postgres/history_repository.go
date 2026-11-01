package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"strconv"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/KovalMax/zwei/services/chat/internal/domain/conversation"
	sharedmessage "github.com/KovalMax/zwei/services/shared/message"
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
	query := `SELECT m.id, m.conversation_id, m.sender_id, m.client_message_id, m.sequence, m.ciphertext, m.nonce, m.created_at, m.kind, m.content_type, m.mentions_ciphertext, m.mentions_nonce, m.reply_to_message_id FROM (SELECT conversation_id, visible_from_sequence FROM conversation_members WHERE conversation_id = $2 AND user_id = $1 AND active) member CROSS JOIN LATERAL (SELECT id, conversation_id, sender_id, client_message_id, sequence, ciphertext, nonce, created_at, kind, content_type, expires_at, mentions_ciphertext, mentions_nonce, reply_to_message_id FROM messages WHERE conversation_id = member.conversation_id AND sequence >= member.visible_from_sequence`
	args := []any{userID, conversationID}
	if before > 0 {
		query += ` AND sequence < $3`
		args = append(args, before)
	}
	limitArgument := len(args) + 1
	query += ` AND (expires_at IS NULL OR expires_at > now()) ORDER BY sequence DESC LIMIT $` + strconv.Itoa(limitArgument) + `) m ORDER BY m.sequence DESC`
	args = append(args, limit+1)
	rows, err := r.db.Query(ctx, query, args...)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	messages := make([]conversation.Message, 0, limit)
	for rows.Next() {
		var message conversation.Message
		var ciphertext, nonce, mentionsCiphertext, mentionsNonce []byte
		if err := rows.Scan(&message.ID, &message.ConversationID, &message.SenderID, &message.ClientMessageID, &message.Sequence, &ciphertext, &nonce, &message.CreatedAt, &message.Kind, &message.ContentType, &mentionsCiphertext, &mentionsNonce, &message.ReplyToMessageID); err != nil {
			return nil, "", err
		}
		body, err := sharedmessage.Decrypt(r.key, ciphertext, nonce)
		if err != nil {
			return nil, "", errors.New("could not decrypt history")
		}
		message.Body = body
		if len(mentionsCiphertext) > 0 {
			mentionsJSON, err := sharedmessage.Decrypt(r.key, mentionsCiphertext, mentionsNonce)
			if err != nil || json.Unmarshal([]byte(mentionsJSON), &message.Mentions) != nil {
				return nil, "", errors.New("could not decode history mentions")
			}
		}
		messages = append(messages, message)
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	rows.Close()
	if len(messages) == 0 {
		var member bool
		if err := r.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2 AND active)`, conversationID, userID).Scan(&member); err != nil {
			return nil, "", err
		}
		if !member {
			return nil, "", ErrNotFound
		}
	}
	nextCursor := ""
	if len(messages) > limit {
		nextCursor = strconv.FormatInt(messages[limit-1].Sequence, 10)
		messages = messages[:limit]
	}
	return messages, nextCursor, nil
}

// Get returns only a currently visible, unexpired message to an active member.
func (r *HistoryRepository) Get(ctx context.Context, userID, conversationID, messageID uuid.UUID) (conversation.Message, error) {
	var message conversation.Message
	var ciphertext, nonce, mentionsCiphertext, mentionsNonce []byte
	err := r.db.QueryRow(ctx, `SELECT m.id, m.conversation_id, m.sender_id, m.client_message_id, m.sequence, m.ciphertext, m.nonce, m.created_at, m.kind, m.content_type, m.mentions_ciphertext, m.mentions_nonce, m.reply_to_message_id FROM messages m JOIN conversation_members member ON member.conversation_id = m.conversation_id AND member.user_id = $1 AND member.active AND m.sequence >= member.visible_from_sequence WHERE m.conversation_id = $2 AND m.id = $3 AND (m.expires_at IS NULL OR m.expires_at > now())`, userID, conversationID, messageID).Scan(&message.ID, &message.ConversationID, &message.SenderID, &message.ClientMessageID, &message.Sequence, &ciphertext, &nonce, &message.CreatedAt, &message.Kind, &message.ContentType, &mentionsCiphertext, &mentionsNonce, &message.ReplyToMessageID)
	if errors.Is(err, pgx.ErrNoRows) {
		return conversation.Message{}, ErrNotFound
	}
	if err != nil {
		return conversation.Message{}, err
	}
	message.Body, err = sharedmessage.Decrypt(r.key, ciphertext, nonce)
	if err != nil {
		return conversation.Message{}, errors.New("could not decrypt history")
	}
	if len(mentionsCiphertext) > 0 {
		value, err := sharedmessage.Decrypt(r.key, mentionsCiphertext, mentionsNonce)
		if err != nil || json.Unmarshal([]byte(value), &message.Mentions) != nil {
			return conversation.Message{}, errors.New("could not decode history mentions")
		}
	}
	return message, nil
}
