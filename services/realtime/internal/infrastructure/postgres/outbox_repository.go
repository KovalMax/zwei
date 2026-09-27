package postgres

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type ConversationCreatedEvent struct {
	ID                 uuid.UUID   `json:"-"`
	ClaimToken         uuid.UUID   `json:"-"`
	EventType          string      `json:"-"`
	ConversationID     uuid.UUID   `json:"conversation_id"`
	UserIDs            []uuid.UUID `json:"user_ids"`
	AuthorizedUserIDs  []uuid.UUID `json:"authorized_user_ids,omitempty"`
	MembershipRevision int64       `json:"membership_revision,omitempty"`
	Deleted            bool        `json:"deleted,omitempty"`
}

type OutboxRepository struct{ db *pgxpool.Pool }

func NewOutboxRepository(db *pgxpool.Pool) *OutboxRepository { return &OutboxRepository{db: db} }

func (r *OutboxRepository) ClaimConversationCreated(ctx context.Context, limit int) ([]ConversationCreatedEvent, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	claimToken := uuid.New()
	rows, err := tx.Query(ctx, `WITH claimable AS (
		SELECT id FROM outbox_events
		WHERE event_type IN ('conversation.created', 'group.membership.changed')
			AND processed_at IS NULL
			AND (claim_expires_at IS NULL OR claim_expires_at <= now())
		ORDER BY created_at, id
		FOR UPDATE SKIP LOCKED
		LIMIT $1
	)
	UPDATE outbox_events event
	SET claim_token = $2, claim_expires_at = now() + interval '30 seconds'
	FROM claimable
	WHERE event.id = claimable.id
		RETURNING event.id, event.event_type, event.payload`, limit, claimToken)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	events := make([]ConversationCreatedEvent, 0)
	for rows.Next() {
		var id uuid.UUID
		var eventType string
		var payload []byte
		if err := rows.Scan(&id, &eventType, &payload); err != nil {
			return nil, err
		}
		var event ConversationCreatedEvent
		if err := json.Unmarshal(payload, &event); err != nil {
			return nil, err
		}
		event.ID = id
		event.EventType = eventType
		event.ClaimToken = claimToken
		events = append(events, event)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return events, nil
}

func (r *OutboxRepository) MarkProcessed(ctx context.Context, event ConversationCreatedEvent) error {
	_, err := r.db.Exec(ctx, `UPDATE outbox_events
		SET processed_at = now(), claim_token = NULL, claim_expires_at = NULL
		WHERE id = $1 AND claim_token = $2 AND processed_at IS NULL`, event.ID, event.ClaimToken)
	return err
}

func (r *OutboxRepository) Release(ctx context.Context, event ConversationCreatedEvent) error {
	_, err := r.db.Exec(ctx, `UPDATE outbox_events
		SET claim_token = NULL, claim_expires_at = NULL
		WHERE id = $1 AND claim_token = $2 AND processed_at IS NULL`, event.ID, event.ClaimToken)
	return err
}
