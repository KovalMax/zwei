package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
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
	adminConfig, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatalf("parse database configuration: %v", err)
	}
	adminDB, err := pgxpool.NewWithConfig(ctx, adminConfig)
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer adminDB.Close()

	schemaName := "outbox_test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, err := adminDB.Exec(ctx, "CREATE SCHEMA "+schemaName); err != nil {
		t.Fatalf("create isolated schema: %v", err)
	}
	defer func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cleanupCancel()
		_, _ = adminDB.Exec(cleanupCtx, "DROP SCHEMA IF EXISTS "+schemaName+" CASCADE")
	}()

	isolatedConfig, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatalf("parse isolated database configuration: %v", err)
	}
	isolatedConfig.ConnConfig.RuntimeParams["search_path"] = schemaName
	db, err := pgxpool.NewWithConfig(ctx, isolatedConfig)
	if err != nil {
		t.Fatalf("open isolated database: %v", err)
	}
	defer db.Close()
	if _, err := db.Exec(ctx, `CREATE TABLE outbox_events (
		id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
		event_type text NOT NULL,
		payload jsonb NOT NULL,
		created_at timestamptz NOT NULL DEFAULT now(),
		processed_at timestamptz,
		claim_token uuid,
		claim_expires_at timestamptz
	)`); err != nil {
		t.Fatalf("create isolated outbox table: %v", err)
	}

	conversationID, userID := uuid.New(), uuid.New()
	payload, err := json.Marshal(ConversationCreatedEvent{ConversationID: conversationID, UserIDs: []uuid.UUID{userID}})
	if err != nil {
		t.Fatalf("marshal event: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO outbox_events (event_type, payload) VALUES ('conversation.created', $1)`, payload); err != nil {
		t.Fatalf("insert event: %v", err)
	}

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
	claimed, err := repository.ClaimConversationCreated(ctx, 1)
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
