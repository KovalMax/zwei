package postgres

import (
	"context"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/KovalMax/zwei/services/shared/messaging"
)

func TestUnreadCountRemainsExactDuringConcurrentSendAndRead(t *testing.T) {
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
	if err := db.Ping(ctx); err != nil {
		t.Fatalf("ping database: %v", err)
	}

	ownerID := uuid.New()
	recipientID := uuid.New()
	conversationID := uuid.New()
	lowID, highID := orderedIDs(ownerID, recipientID)
	if _, err := db.Exec(ctx, `INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, 'integration', 'Integration owner'), ($3, $4, 'integration', 'Integration recipient')`, ownerID, ownerID.String()+"@integration.test", recipientID, recipientID.String()+"@integration.test"); err != nil {
		t.Fatalf("insert users: %v", err)
	}
	defer func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = db.Exec(cleanupCtx, `DELETE FROM users WHERE id = ANY($1)`, []uuid.UUID{ownerID, recipientID})
	}()
	if _, err := db.Exec(ctx, `INSERT INTO conversations (id, user_low_id, user_high_id, next_sequence) VALUES ($1, $2, $3, 1)`, conversationID, lowID, highID); err != nil {
		t.Fatalf("insert conversation: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2), ($1, $3)`, conversationID, ownerID, recipientID); err != nil {
		t.Fatalf("insert conversation members: %v", err)
	}

	if _, err := db.Exec(ctx, `INSERT INTO user_read_cursors (user_id, conversation_id, last_read_sequence, unread_count) VALUES ($1, $2, 0, 0) ON CONFLICT (user_id, conversation_id) DO UPDATE SET last_read_sequence = 0, unread_count = 0`, recipientID, conversationID); err != nil {
		t.Fatalf("initialize read cursor: %v", err)
	}

	sender := messaging.NewSender(db, "integration-message-encryption-key")
	cursors := NewReadCursorRepository(db)
	for sequence := int64(1); sequence <= 16; sequence++ {
		start := make(chan struct{})
		var group sync.WaitGroup
		var sendErr, readErr error
		group.Add(2)
		go func() {
			defer group.Done()
			<-start
			_, _, sendErr = sender.Send(ctx, messaging.SendRequest{SenderID: ownerID, ConversationID: conversationID, ClientMessageID: fmt.Sprintf("integration-%d", sequence), Body: "concurrent message"})
		}()
		go func() {
			defer group.Done()
			<-start
			_, readErr = cursors.Advance(ctx, recipientID, conversationID, sequence)
		}()
		close(start)
		group.Wait()
		if sendErr != nil || readErr != nil {
			t.Fatalf("concurrent sequence %d: send=%v read=%v", sequence, sendErr, readErr)
		}
	}

	var cursor, unread int64
	if err := db.QueryRow(ctx, `SELECT last_read_sequence, unread_count FROM user_read_cursors WHERE user_id = $1 AND conversation_id = $2`, recipientID, conversationID).Scan(&cursor, &unread); err != nil {
		t.Fatalf("read final cursor: %v", err)
	}
	var expected int64
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM messages WHERE conversation_id = $1 AND sender_id <> $2 AND sequence > $3`, conversationID, recipientID, cursor).Scan(&expected); err != nil {
		t.Fatalf("count final unread messages: %v", err)
	}
	if unread != expected {
		t.Fatalf("unread_count = %d, expected exact count %d at cursor %d", unread, expected, cursor)
	}
}

func orderedIDs(first, second uuid.UUID) (uuid.UUID, uuid.UUID) {
	if first.String() < second.String() {
		return first, second
	}
	return second, first
}
