package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/KovalMax/zwei/services/chat/internal/domain/conversation"
)

var ErrNotFound = errors.New("conversation or user not found")

// Repository is the PostgreSQL adapter for direct-conversation queries and creation.
type Repository struct{ db *pgxpool.Pool }

func NewConversationRepository(db *pgxpool.Pool) *Repository { return &Repository{db: db} }

func (r *Repository) SearchUsers(ctx context.Context, userID uuid.UUID, query string) ([]conversation.User, error) {
	pattern := "%" + strings.ToLower(query) + "%"
	rows, err := r.db.Query(ctx, `SELECT id, display_name, email FROM users WHERE id <> $1 AND (lower(display_name) LIKE $2 OR lower(email) LIKE $2) ORDER BY display_name, id LIMIT 20`, userID, pattern)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	users := make([]conversation.User, 0)
	for rows.Next() {
		var user conversation.User
		if err := rows.Scan(&user.ID, &user.DisplayName, &user.Email); err != nil {
			return nil, err
		}
		users = append(users, user)
	}
	return users, rows.Err()
}

func (r *Repository) Create(ctx context.Context, userID, otherUserID uuid.UUID) (conversation.Conversation, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return conversation.Conversation{}, err
	}
	defer tx.Rollback(ctx)
	var exists bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM users WHERE id = $1)`, otherUserID).Scan(&exists); err != nil {
		return conversation.Conversation{}, err
	}
	if !exists {
		return conversation.Conversation{}, ErrNotFound
	}
	low, high := conversation.OrderedUsers(userID, otherUserID)
	var result conversation.Conversation
	created := true
	err = tx.QueryRow(ctx, `INSERT INTO conversations (user_low_id, user_high_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id, created_at`, low, high).Scan(&result.ID, &result.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		created = false
		err = tx.QueryRow(ctx, `SELECT id, created_at FROM conversations WHERE user_low_id = $1 AND user_high_id = $2`, low, high).Scan(&result.ID, &result.CreatedAt)
	}
	if err != nil {
		return conversation.Conversation{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2), ($1, $3) ON CONFLICT DO NOTHING`, result.ID, low, high); err != nil {
		return conversation.Conversation{}, err
	}
	if created {
		payload, err := json.Marshal(struct {
			ConversationID uuid.UUID   `json:"conversation_id"`
			UserIDs        []uuid.UUID `json:"user_ids"`
		}{ConversationID: result.ID, UserIDs: []uuid.UUID{userID, otherUserID}})
		if err != nil {
			return conversation.Conversation{}, err
		}
		if _, err = tx.Exec(ctx, `INSERT INTO outbox_events (event_type, payload) VALUES ('conversation.created', $1)`, payload); err != nil {
			return conversation.Conversation{}, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return conversation.Conversation{}, err
	}
	if err = r.db.QueryRow(ctx, `SELECT u.id, u.display_name, u.email FROM users u WHERE u.id = $1`, otherUserID).Scan(&result.OtherUserID, &result.OtherDisplayName, &result.OtherEmail); err != nil {
		return conversation.Conversation{}, err
	}
	result.LastMessageAt = result.CreatedAt
	return result, nil
}

func (r *Repository) List(ctx context.Context, userID uuid.UUID) ([]conversation.Conversation, error) {
	rows, err := r.db.Query(ctx, `SELECT c.id, peer.id, peer.display_name, peer.email, c.created_at, COALESCE(c.last_message_at, c.created_at), COALESCE(rc.unread_count, 0) FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id JOIN users peer ON peer.id = CASE WHEN c.user_low_id = $1 THEN c.user_high_id ELSE c.user_low_id END LEFT JOIN user_read_cursors rc ON rc.user_id = $1 AND rc.conversation_id = c.id WHERE cm.user_id = $1 ORDER BY COALESCE(c.last_message_at, c.created_at) DESC, c.id DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	conversations := make([]conversation.Conversation, 0)
	for rows.Next() {
		var item conversation.Conversation
		if err := rows.Scan(&item.ID, &item.OtherUserID, &item.OtherDisplayName, &item.OtherEmail, &item.CreatedAt, &item.LastMessageAt, &item.UnreadCount); err != nil {
			return nil, err
		}
		conversations = append(conversations, item)
	}
	return conversations, rows.Err()
}

func (r *Repository) Get(ctx context.Context, userID, conversationID uuid.UUID) (conversation.Conversation, error) {
	var item conversation.Conversation
	err := r.db.QueryRow(ctx, `SELECT c.id, u.id, u.display_name, u.email, c.created_at FROM conversations c JOIN conversation_members m ON m.conversation_id = c.id JOIN users u ON u.id = CASE WHEN c.user_low_id = $1 THEN c.user_high_id ELSE c.user_low_id END WHERE c.id = $2 AND m.user_id = $1`, userID, conversationID).Scan(&item.ID, &item.OtherUserID, &item.OtherDisplayName, &item.OtherEmail, &item.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return conversation.Conversation{}, ErrNotFound
	}
	return item, err
}
