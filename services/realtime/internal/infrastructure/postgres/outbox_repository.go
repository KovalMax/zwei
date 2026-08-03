package postgres

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type ConversationCreatedEvent struct {
	ConversationID uuid.UUID   `json:"conversation_id"`
	UserIDs        []uuid.UUID `json:"user_ids"`
}

type OutboxRepository struct{ db *pgxpool.Pool }

func NewOutboxRepository(db *pgxpool.Pool) *OutboxRepository { return &OutboxRepository{db: db} }

func (r *OutboxRepository) ClaimConversationCreated(ctx context.Context, limit int) ([]ConversationCreatedEvent, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	rows, err := tx.Query(ctx, `SELECT id, payload FROM outbox_events WHERE event_type = 'conversation.created' AND processed_at IS NULL ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	ids := make([]uuid.UUID, 0)
	events := make([]ConversationCreatedEvent, 0)
	for rows.Next() {
		var id uuid.UUID
		var payload []byte
		if err := rows.Scan(&id, &payload); err != nil {
			return nil, err
		}
		var event ConversationCreatedEvent
		if err := json.Unmarshal(payload, &event); err != nil {
			return nil, err
		}
		ids = append(ids, id)
		events = append(events, event)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(ids) > 0 {
		if _, err := tx.Exec(ctx, `UPDATE outbox_events SET processed_at = now() WHERE id = ANY($1)`, ids); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return events, nil
}
