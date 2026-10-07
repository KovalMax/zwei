package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestConversationOutboxClaimReleaseAndAcknowledge(t *testing.T) {
	databaseURL := os.Getenv("ZWEI_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set ZWEI_TEST_DATABASE_URL to run PostgreSQL integration tests")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Close()

	conversationID, userID := uuid.New(), uuid.New()
	payload, err := json.Marshal(ConversationCreatedEvent{ConversationID: conversationID, UserIDs: []uuid.UUID{userID}})
	if err != nil {
		t.Fatalf("marshal event: %v", err)
	}
	var eventID uuid.UUID
	if err := db.QueryRow(ctx, `INSERT INTO outbox_events (event_type, payload) VALUES ('conversation.created', $1) RETURNING id`, payload).Scan(&eventID); err != nil {
		t.Fatalf("insert event: %v", err)
	}
	defer func() { _, _ = db.Exec(context.Background(), `DELETE FROM outbox_events WHERE id = $1`, eventID) }()

	repository := NewOutboxRepository(db)
	claimed, err := claimEvent(ctx, repository, conversationID)
	if err != nil {
		t.Fatalf("initial claim: %v", err)
	}
	if claimed.ClaimToken == uuid.Nil {
		t.Fatalf("claimed event = %#v", claimed)
	}
	if err := repository.Release(ctx, claimed); err != nil {
		t.Fatalf("release claim: %v", err)
	}

	claimed, err = claimEvent(ctx, repository, conversationID)
	if err != nil {
		t.Fatalf("reclaim: %v", err)
	}
	if err := repository.MarkProcessed(ctx, claimed); err != nil {
		t.Fatalf("acknowledge claim: %v", err)
	}
	if claimed, err := claimEvent(ctx, repository, conversationID); err == nil || claimed.ID != uuid.Nil {
		t.Fatalf("claim after acknowledgement = %#v, %v", claimed, err)
	}
}

func claimEvent(ctx context.Context, repository *OutboxRepository, conversationID uuid.UUID) (ConversationCreatedEvent, error) {
	claimed, err := repository.ClaimConversationCreated(ctx, 100)
	if err != nil {
		return ConversationCreatedEvent{}, err
	}
	for _, event := range claimed {
		if event.ConversationID == conversationID {
			return event, nil
		}
		if err := repository.Release(ctx, event); err != nil {
			return ConversationCreatedEvent{}, err
		}
	}
	return ConversationCreatedEvent{}, errors.New("inserted event was not claimed")
}
