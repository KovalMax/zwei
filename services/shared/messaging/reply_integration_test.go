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

func TestReplyPersistenceAuthorizationAndReplay(t *testing.T) {
	url := os.Getenv("ZWEI_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set ZWEI_TEST_DATABASE_URL to run PostgreSQL integration tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	senderID, recipientID, outsiderID, conversationID, otherConversationID, deviceID := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	_, err = db.Exec(ctx, `INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,'test','Sender'),($3,$4,'test','Recipient'),($5,$6,'test','Outsider')`, senderID, senderID.String()+"@reply.test", recipientID, recipientID.String()+"@reply.test", outsiderID, outsiderID.String()+"@reply.test")
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		_, _ = db.Exec(context.Background(), `DELETE FROM users WHERE id=ANY($1)`, []uuid.UUID{senderID, recipientID, outsiderID})
	}()
	insertConversation(t, ctx, db, conversationID, senderID, recipientID)
	insertConversation(t, ctx, db, otherConversationID, senderID, outsiderID)
	if _, err = db.Exec(ctx, `INSERT INTO devices(id,user_id,client_device_id) VALUES($1,$2,'reply-test')`, deviceID, recipientID); err != nil {
		t.Fatal(err)
	}
	sender := NewSender(db, "reply-test-key")
	base := SendRequest{SenderID: senderID, ConversationID: conversationID, ClientMessageID: "target", Body: "target", ContentType: "text"}
	target, created, err := sender.Send(ctx, base)
	if err != nil || !created || target.ReplyToMessageID != nil {
		t.Fatalf("target: %+v %t %v", target, created, err)
	}
	other := base
	other.ConversationID = otherConversationID
	other.ClientMessageID = "other"
	otherMessage, _, err := sender.Send(ctx, other)
	if err != nil {
		t.Fatal(err)
	}
	reply := base
	reply.ClientMessageID = "reply"
	reply.ReplyToMessageID = &target.ID
	sent, created, err := sender.Send(ctx, reply)
	if err != nil || !created || sent.ReplyToMessageID == nil || *sent.ReplyToMessageID != target.ID {
		t.Fatalf("reply: %+v %t %v", sent, created, err)
	}
	pending, err := NewDeliveryRepository(db, "reply-test-key").Pending(ctx, deviceID, 10)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, message := range pending {
		if message.ID == sent.ID {
			found = message.ReplyToMessageID != nil && *message.ReplyToMessageID == target.ID
		}
	}
	if !found {
		t.Fatalf("reply missing from pending: %+v", pending)
	}
	invalidID := uuid.New()
	reply.ReplyToMessageID = &invalidID
	if _, created, err = sender.Send(ctx, reply); created || !errors.Is(err, ErrClientMessageIDConflict) {
		t.Fatalf("different target: created=%t err=%v", created, err)
	}
	ordinaryToReply := base
	ordinaryToReply.ReplyToMessageID = &target.ID
	if _, created, err = sender.Send(ctx, ordinaryToReply); created || !errors.Is(err, ErrClientMessageIDConflict) {
		t.Fatalf("ordinary to reply: created=%t err=%v", created, err)
	}
	reply.ReplyToMessageID = nil
	if _, created, err = sender.Send(ctx, reply); created || !errors.Is(err, ErrClientMessageIDConflict) {
		t.Fatalf("reply to ordinary: created=%t err=%v", created, err)
	}
	reply.ReplyToMessageID = &target.ID
	retried, created, err := sender.Send(ctx, reply)
	if err != nil || created || retried.ID != sent.ID {
		t.Fatalf("same target retry: %+v %t %v", retried, created, err)
	}
	reject := func(label string, id uuid.UUID) {
		t.Helper()
		request := base
		request.ClientMessageID = label
		request.ReplyToMessageID = &id
		_, created, err := sender.Send(ctx, request)
		if created || !errors.Is(err, ErrInvalidReply) {
			t.Errorf("%s: created=%t err=%v", label, created, err)
		}
	}
	reject("missing", invalidID)
	reject("other-conversation", otherMessage.ID)
	if _, err = db.Exec(ctx, `UPDATE conversation_members SET visible_from_sequence=$3 WHERE conversation_id=$1 AND user_id=$2`, conversationID, senderID, sent.Sequence); err != nil {
		t.Fatal(err)
	}
	reject("pre-visibility", target.ID)
	if _, err = db.Exec(ctx, `UPDATE conversation_members SET visible_from_sequence=1 WHERE conversation_id=$1 AND user_id=$2`, conversationID, senderID); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(ctx, `UPDATE messages SET kind='system' WHERE id=$1`, target.ID); err != nil {
		t.Fatal(err)
	}
	reject("system", target.ID)
	if _, err = db.Exec(ctx, `UPDATE messages SET kind='user', expires_at=now()-interval '1 second' WHERE id=$1`, target.ID); err != nil {
		t.Fatal(err)
	}
	reject("expired", target.ID)
	reply.ReplyToMessageID = &target.ID
	retried, created, err = sender.Send(ctx, reply)
	if err != nil || created || retried.ReplyToMessageID == nil || *retried.ReplyToMessageID != target.ID {
		t.Fatalf("retry after expiry: %+v %t %v", retried, created, err)
	}
	if _, err = db.Exec(ctx, `UPDATE conversation_members SET active=false,left_at=now() WHERE conversation_id=$1 AND user_id=$2`, conversationID, senderID); err != nil {
		t.Fatal(err)
	}
	reply.ClientMessageID = "inactive"
	if _, created, err = sender.Send(ctx, reply); created || !errors.Is(err, ErrConversationNotFound) {
		t.Fatalf("inactive: %t %v", created, err)
	}
}
