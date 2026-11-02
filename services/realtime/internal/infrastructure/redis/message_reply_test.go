package redis

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/KovalMax/zwei/services/shared/messaging"
	"github.com/google/uuid"
)

func TestMessageReplySurvivesRedisEnvelope(t *testing.T) {
	id := uuid.New()
	original := MessageChange{Message: messaging.Message{Body: "reply", ReplyToMessageID: &id}}
	encoded, err := json.Marshal(original)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &fields); err != nil {
		t.Fatal(err)
	}
	var message map[string]json.RawMessage
	if err := json.Unmarshal(fields["message"], &message); err != nil {
		t.Fatal(err)
	}
	var got MessageChange
	if err := json.Unmarshal(encoded, &got); err != nil {
		t.Fatal(err)
	}
	if got.Message.ReplyToMessageID == nil || *got.Message.ReplyToMessageID != id {
		t.Fatalf("reply lost: %s", encoded)
	}
	if _, ok := message["quoted_body"]; ok {
		t.Fatal("envelope contains quoted plaintext")
	}
}

func TestMessageReplyRedisPublishIntegration(t *testing.T) {
	url := os.Getenv("ZWEI_TEST_REDIS_URL")
	if url == "" {
		t.Skip("set ZWEI_TEST_REDIS_URL")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	coordinator, err := NewPresenceCoordinator(url)
	if err != nil {
		t.Fatal(err)
	}
	defer coordinator.Close()
	sub := coordinator.client.Subscribe(ctx, messageChannel)
	defer sub.Close()
	if _, err := sub.Receive(ctx); err != nil {
		t.Fatal(err)
	}
	id := uuid.New()
	if err := coordinator.PublishMessage(ctx, messaging.Message{ID: uuid.New(), ReplyToMessageID: &id}); err != nil {
		t.Fatal(err)
	}
	message, err := sub.ReceiveMessage(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var change MessageChange
	if err := json.Unmarshal([]byte(message.Payload), &change); err != nil || change.Message.ReplyToMessageID == nil || *change.Message.ReplyToMessageID != id {
		t.Fatalf("reply lost in published envelope: %s (%v)", message.Payload, err)
	}
}
