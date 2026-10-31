package messaging

import (
	"bytes"
	"context"
	"errors"
	"os"
	"strings"
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
	request := SendRequest{SenderID: senderID, ConversationID: firstConversationID, ClientMessageID: "uncertain-send", Body: "first message", ContentType: "text"}
	first, created, err := sender.Send(ctx, request)
	if err != nil || !created {
		t.Fatalf("first send = (%+v, %t, %v), want created message", first, created, err)
	}
	if first.ContentType != "text" {
		t.Fatalf("content type = %q, want text", first.ContentType)
	}
	var intents int
	if err := db.QueryRow(ctx, `SELECT count(*) FROM message_push_outbox WHERE message_id = $1 AND recipient_id = $2 AND event_type = 'message.push'`, first.ID, firstRecipientID).Scan(&intents); err != nil {
		t.Fatalf("count recipient push intents: %v", err)
	}
	if intents != 1 {
		t.Fatalf("recipient push intents = %d, want one", intents)
	}

	replayed, created, err := sender.Send(ctx, request)
	if err != nil || created || replayed.ID != first.ID {
		t.Fatalf("same-conversation retry = (%+v, %t, %v), want original message", replayed, created, err)
	}
	if err := db.QueryRow(ctx, `SELECT count(*) FROM message_push_outbox WHERE message_id = $1 AND recipient_id = $2`, first.ID, firstRecipientID).Scan(&intents); err != nil {
		t.Fatalf("count push intents after idempotent retry: %v", err)
	}
	if intents != 1 {
		t.Fatalf("push intents after idempotent retry = %d, want one", intents)
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

func TestSenderRollsBackMessageDeliveryUnreadAndPushIntentTogether(t *testing.T) {
	databaseURL := os.Getenv("ZWEI_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set ZWEI_TEST_DATABASE_URL to run PostgreSQL integration tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	senderID, recipientID, conversationID, deviceID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO users(id,email,password_hash,display_name) VALUES($1,$2,'integration','Sender'),($3,$4,'integration','Recipient')`, senderID, senderID.String()+"@push-atomic.integration.test", recipientID, recipientID.String()+"@push-atomic.integration.test"); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_, _ = db.Exec(context.Background(), `DELETE FROM users WHERE id=ANY($1)`, []uuid.UUID{senderID, recipientID})
	}()
	insertConversation(t, ctx, db, conversationID, senderID, recipientID)
	if _, err := db.Exec(ctx, `INSERT INTO devices(id,user_id,client_device_id) VALUES($1,$2,'push-atomic-device')`, deviceID, recipientID); err != nil {
		t.Fatal(err)
	}
	triggerName := "reject_push_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	functionName := triggerName + "_fn"
	_, err = db.Exec(ctx, `CREATE FUNCTION `+functionName+`() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected intent failure'; END $$`)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		_, _ = db.Exec(context.Background(), `DROP TRIGGER IF EXISTS `+triggerName+` ON message_push_outbox`)
		_, _ = db.Exec(context.Background(), `DROP FUNCTION IF EXISTS `+functionName+`()`)
	}()
	triggerSQL := `CREATE TRIGGER ` + triggerName + ` BEFORE INSERT ON message_push_outbox FOR EACH ROW WHEN (NEW.sender_id = '` + senderID.String() + `'::uuid) EXECUTE FUNCTION ` + functionName + `()`
	if _, err = db.Exec(ctx, triggerSQL); err != nil {
		t.Fatal(err)
	}
	_, _, err = NewSender(db, "push-atomic-test-key").Send(ctx, SendRequest{SenderID: senderID, ConversationID: conversationID, ClientMessageID: "atomic-push-failure", Body: "private content", ContentType: "text"})
	if !errors.Is(err, ErrPersistence) {
		t.Fatalf("send error=%v, want persistence failure", err)
	}
	checks := []struct {
		label, query string
		args         []any
	}{
		{"message", `SELECT count(*) FROM messages WHERE sender_id=$1 AND client_message_id='atomic-push-failure'`, []any{senderID}},
		{"delivery", `SELECT count(*) FROM message_delivery WHERE device_id=$1`, []any{deviceID}},
		{"push intent", `SELECT count(*) FROM message_push_outbox WHERE sender_id=$1`, []any{senderID}},
		{"unread state", `SELECT count(*) FROM user_read_cursors WHERE user_id=$1 AND conversation_id=$2`, []any{recipientID, conversationID}},
	}
	for _, check := range checks {
		var count int
		if err := db.QueryRow(ctx, check.query, check.args...).Scan(&count); err != nil {
			t.Fatalf("count %s: %v", check.label, err)
		}
		if count != 0 {
			t.Errorf("%s rows after transactional failure=%d, want zero", check.label, count)
		}
	}
}

func TestHistoricalStickerReplaysForDeliveryAndNewWritesAreRejected(t *testing.T) {
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
	if _, err := db.Exec(ctx, `INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, 'integration', 'Sender'), ($3, $4, 'integration', 'Recipient')`, senderID, senderID.String()+"@sticker.integration.test", recipientID, recipientID.String()+"@sticker.integration.test"); err != nil {
		t.Fatalf("insert users: %v", err)
	}
	defer func() {
		_, _ = db.Exec(context.Background(), `DELETE FROM users WHERE id = ANY($1)`, []uuid.UUID{senderID, recipientID})
	}()
	insertConversation(t, ctx, db, conversationID, senderID, recipientID)
	if _, err := db.Exec(ctx, `INSERT INTO devices (id, user_id, client_device_id) VALUES ($1, $2, 'sticker-device')`, deviceID, recipientID); err != nil {
		t.Fatalf("insert device: %v", err)
	}
	sender := NewSender(db, "sticker-persistence-test-key")
	request := SendRequest{SenderID: senderID, ConversationID: conversationID, ClientMessageID: "sticker-send", Body: "heart", ContentType: "text"}
	createdMessage, created, err := sender.Send(ctx, request)
	if err != nil || !created {
		t.Fatalf("fixture text send = (%+v, %t, %v)", createdMessage, created, err)
	}
	if _, err := db.Exec(ctx, `UPDATE messages SET content_type = 'sticker' WHERE id = $1`, createdMessage.ID); err != nil {
		t.Fatal(err)
	}
	var storedType string
	if err := db.QueryRow(ctx, `SELECT content_type FROM messages WHERE id = $1`, createdMessage.ID).Scan(&storedType); err != nil || storedType != "sticker" {
		t.Fatalf("stored content type = %q, error = %v, want sticker", storedType, err)
	}
	request.ContentType = "sticker"
	if _, created, err := sender.Send(ctx, request); !errors.Is(err, ErrInvalidMessage) || created {
		t.Fatalf("sticker retry = (%t, %v), want invalid message", created, err)
	}
	pending, err := NewDeliveryRepository(db, "sticker-persistence-test-key").Pending(ctx, deviceID, 10)
	if err != nil || len(pending) != 1 || pending[0].ID != createdMessage.ID || pending[0].ContentType != "sticker" {
		t.Fatalf("pending sticker delivery = (%+v, %v), want sticker content type", pending, err)
	}

	for _, invalid := range []SendRequest{
		{SenderID: uuid.New(), ConversationID: uuid.New(), ClientMessageID: "missing-type", Body: "heart"},
		{SenderID: uuid.New(), ConversationID: uuid.New(), ClientMessageID: "bad-type", Body: "heart", ContentType: "image"},
		{SenderID: uuid.New(), ConversationID: uuid.New(), ClientMessageID: "bad-sticker", Body: "unknown", ContentType: "sticker"},
		{SenderID: uuid.New(), ConversationID: uuid.New(), ClientMessageID: "sticker-mention", Body: "heart", ContentType: "sticker", Mentions: []Mention{{UserID: uuid.New(), Start: 0, End: 1}}},
	} {
		if _, wasCreated, err := sender.Send(ctx, invalid); !errors.Is(err, ErrInvalidMessage) || wasCreated {
			t.Errorf("invalid sticker request error = %v, created = %t, want ErrInvalidMessage and false", err, wasCreated)
		}
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
	first, created, err := sender.Send(ctx, SendRequest{SenderID: senderID, ConversationID: conversationID, ClientMessageID: "before-rejoin", Body: "first", ContentType: "text"})
	if err != nil || !created {
		t.Fatalf("send first = (%+v, %t, %v)", first, created, err)
	}
	second, created, err := sender.Send(ctx, SendRequest{SenderID: senderID, ConversationID: conversationID, ClientMessageID: "after-rejoin", Body: "second", ContentType: "text"})
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

func TestSenderPersistsAuthorizedMentionsAndReturnsThemOnRetryAndDelivery(t *testing.T) {
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

	senderID, recipientID, outsiderID, conversationID, deviceID := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, 'integration', 'Sender'), ($3, $4, 'integration', 'Recipient'), ($5, $6, 'integration', 'Outsider')`, senderID, senderID.String()+"@integration.test", recipientID, recipientID.String()+"@integration.test", outsiderID, outsiderID.String()+"@integration.test"); err != nil {
		t.Fatalf("insert users: %v", err)
	}
	defer func() {
		_, _ = db.Exec(context.Background(), `DELETE FROM users WHERE id = ANY($1)`, []uuid.UUID{senderID, recipientID, outsiderID})
	}()
	insertConversation(t, ctx, db, conversationID, senderID, recipientID)
	if _, err := db.Exec(ctx, `INSERT INTO devices (id, user_id, client_device_id) VALUES ($1, $2, 'mention-device')`, deviceID, recipientID); err != nil {
		t.Fatalf("insert device: %v", err)
	}
	sender := NewSender(db, "mention-persistence-test-key")
	mentions := []Mention{{UserID: recipientID, Start: 0, End: 4}, {UserID: recipientID, Start: 5, End: 9}}
	request := SendRequest{SenderID: senderID, ConversationID: conversationID, ClientMessageID: "mention-send", Body: "@hey @hey", ContentType: "text", Mentions: mentions}
	created, wasCreated, err := sender.Send(ctx, request)
	if err != nil || !wasCreated || len(created.Mentions) != 2 {
		t.Fatalf("send = (%+v, %t, %v), want both mention spans", created, wasCreated, err)
	}
	var mentionCiphertext, mentionNonce []byte
	if err := db.QueryRow(ctx, `SELECT mentions_ciphertext, mentions_nonce FROM messages WHERE id = $1`, created.ID).Scan(&mentionCiphertext, &mentionNonce); err != nil {
		t.Fatalf("read encrypted mention storage: %v", err)
	}
	if len(mentionCiphertext) == 0 || len(mentionNonce) == 0 || bytes.Contains(mentionCiphertext, []byte(recipientID.String())) {
		t.Fatal("mention identity was not stored as encrypted metadata")
	}
	changedRetry := request
	changedRetry.Mentions = nil
	replayed, wasCreated, err := sender.Send(ctx, changedRetry)
	if err != nil || wasCreated || len(replayed.Mentions) != 2 || replayed.Mentions[1].Start != 5 {
		t.Fatalf("idempotent retry = (%+v, %t, %v), want original mention metadata", replayed, wasCreated, err)
	}
	request.ClientMessageID = "unauthorized-mention"
	request.Mentions = []Mention{{UserID: outsiderID, Start: 0, End: 4}}
	if _, wasCreated, err := sender.Send(ctx, request); !errors.Is(err, ErrInvalidMention) || wasCreated {
		t.Fatalf("unauthorized mention error = %v, created = %t", err, wasCreated)
	}
	pending, err := NewDeliveryRepository(db, "mention-persistence-test-key").Pending(ctx, deviceID, 10)
	if err != nil || len(pending) != 1 || len(pending[0].Mentions) != 2 {
		t.Fatalf("pending delivery = (%+v, %v), want stored mention spans", pending, err)
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
