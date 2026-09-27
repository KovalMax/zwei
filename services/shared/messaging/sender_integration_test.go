package messaging

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestSenderRejectsClientMessageIDReuseAcrossConversations(t *testing.T) {
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

	senderID, firstRecipientID, secondRecipientID := uuid.New(), uuid.New(), uuid.New()
	firstConversationID, secondConversationID := uuid.New(), uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, 'integration', 'Sender'), ($3, $4, 'integration', 'First recipient'), ($5, $6, 'integration', 'Second recipient')`, senderID, senderID.String()+"@integration.test", firstRecipientID, firstRecipientID.String()+"@integration.test", secondRecipientID, secondRecipientID.String()+"@integration.test"); err != nil {
		t.Fatalf("insert users: %v", err)
	}
	defer func() {
		_, _ = db.Exec(context.Background(), `DELETE FROM users WHERE id = ANY($1)`, []uuid.UUID{senderID, firstRecipientID, secondRecipientID})
	}()
	insertConversation(t, ctx, db, firstConversationID, senderID, firstRecipientID)
	insertConversation(t, ctx, db, secondConversationID, senderID, secondRecipientID)

	sender := NewSender(db, "sender-idempotency-test-key")
	request := SendRequest{SenderID: senderID, ConversationID: firstConversationID, ClientMessageID: "uncertain-send", Body: "first message"}
	first, created, err := sender.Send(ctx, request)
	if err != nil || !created {
		t.Fatalf("first send = (%+v, %t, %v), want created message", first, created, err)
	}

	replayed, created, err := sender.Send(ctx, request)
	if err != nil || created || replayed.ID != first.ID {
		t.Fatalf("same-conversation retry = (%+v, %t, %v), want original message", replayed, created, err)
	}
	if _, err := db.Exec(ctx, `UPDATE messages SET expires_at = now() - interval '1 second' WHERE id = $1`, first.ID); err != nil {
		t.Fatalf("expire message: %v", err)
	}
	if expired, created, err := sender.Send(ctx, request); !errors.Is(err, ErrMessageExpired) || created || expired.Body != "" || expired.ID != uuid.Nil {
		t.Fatalf("expired same-conversation retry = (%+v, %t, %v), want empty result and %v", expired, created, err, ErrMessageExpired)
	}

	request.ConversationID = secondConversationID
	if _, created, err := sender.Send(ctx, request); !errors.Is(err, ErrClientMessageIDConflict) || created {
		t.Fatalf("cross-conversation reuse error = %v, created = %t, want %v and false", err, created, ErrClientMessageIDConflict)
	}
}

func TestDeliveryPendingExcludesInactiveAndPreVisibilityMessages(t *testing.T) {
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

	senderID, recipientID, conversationID, deviceID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, 'integration', 'Sender'), ($3, $4, 'integration', 'Recipient')`, senderID, senderID.String()+"@integration.test", recipientID, recipientID.String()+"@integration.test"); err != nil {
		t.Fatalf("insert users: %v", err)
	}
	defer func() {
		_, _ = db.Exec(context.Background(), `DELETE FROM users WHERE id = ANY($1)`, []uuid.UUID{senderID, recipientID})
	}()
	insertConversation(t, ctx, db, conversationID, senderID, recipientID)
	if _, err := db.Exec(ctx, `INSERT INTO devices (id, user_id, client_device_id) VALUES ($1, $2, 'delivery-device')`, deviceID, recipientID); err != nil {
		t.Fatalf("insert device: %v", err)
	}

	sender := NewSender(db, "delivery-visibility-test-key")
	first, created, err := sender.Send(ctx, SendRequest{SenderID: senderID, ConversationID: conversationID, ClientMessageID: "before-rejoin", Body: "first"})
	if err != nil || !created {
		t.Fatalf("send first = (%+v, %t, %v)", first, created, err)
	}
	second, created, err := sender.Send(ctx, SendRequest{SenderID: senderID, ConversationID: conversationID, ClientMessageID: "after-rejoin", Body: "second"})
	if err != nil || !created {
		t.Fatalf("send second = (%+v, %t, %v)", second, created, err)
	}
	if _, err := db.Exec(ctx, `UPDATE conversation_members SET visible_from_sequence = $3 WHERE conversation_id = $1 AND user_id = $2`, conversationID, recipientID, second.Sequence); err != nil {
		t.Fatalf("set visible sequence: %v", err)
	}

	delivery := NewDeliveryRepository(db, "delivery-visibility-test-key")
	pending, err := delivery.Pending(ctx, deviceID, 10)
	if err != nil || len(pending) != 1 || pending[0].ID != second.ID {
		t.Fatalf("visible pending = %#v, %v", pending, err)
	}
	if _, err := db.Exec(ctx, `UPDATE conversation_members SET active = false, left_at = now() WHERE conversation_id = $1 AND user_id = $2`, conversationID, recipientID); err != nil {
		t.Fatalf("deactivate member: %v", err)
	}
	pending, err = delivery.Pending(ctx, deviceID, 10)
	if err != nil || len(pending) != 0 {
		t.Fatalf("inactive pending = %#v, %v", pending, err)
	}
}

func insertConversation(t *testing.T, ctx context.Context, db *pgxpool.Pool, conversationID, firstUserID, secondUserID uuid.UUID) {
	t.Helper()
	lowID, highID := firstUserID, secondUserID
	if highID.String() < lowID.String() {
		lowID, highID = highID, lowID
	}
	if _, err := db.Exec(ctx, `INSERT INTO conversations (id, user_low_id, user_high_id, next_sequence) VALUES ($1, $2, $3, 1)`, conversationID, lowID, highID); err != nil {
		t.Fatalf("insert conversation: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2), ($1, $3)`, conversationID, firstUserID, secondUserID); err != nil {
		t.Fatalf("insert conversation members: %v", err)
	}
}
