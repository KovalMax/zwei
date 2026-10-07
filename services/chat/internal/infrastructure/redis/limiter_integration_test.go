package redis

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/KovalMax/zwei/services/chat/internal/application"
)

func TestRequestLimiterIntegration(t *testing.T) {
	rawURL := os.Getenv("ZWEI_TEST_REDIS_URL")
	if rawURL == "" {
		t.Skip("set ZWEI_TEST_REDIS_URL to run Redis integration tests")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	limiter, err := NewRequestLimiter(rawURL)
	if err != nil {
		t.Fatalf("create limiter: %v", err)
	}
	defer limiter.Close()
	userID := uuid.New()
	key := "zwei:rate:chat:" + application.RateBucketConversationCreate + ":" + userID.String()
	groupKey := "zwei:rate:chat:" + application.RateBucketGroupMutation + ":" + userID.String()
	groupListKey := "zwei:rate:chat:" + application.RateBucketGroupList + ":" + userID.String()
	groupGetKey := "zwei:rate:chat:" + application.RateBucketGroupGet + ":" + userID.String()
	messageKey := "zwei:rate:message:" + userID.String()
	legacyMessageKey := "zwei:rate:chat:" + application.RateBucketMessage + ":" + userID.String()
	defer func() {
		_ = limiter.client.Del(ctx, key, groupKey, groupListKey, groupGetKey, messageKey, legacyMessageKey).Err()
	}()

	for attempt := 0; attempt < policies[application.RateBucketConversationCreate].limit; attempt++ {
		allowed, err := limiter.Allow(ctx, userID, application.RateBucketConversationCreate)
		if err != nil || !allowed {
			t.Fatalf("attempt %d allowed=%t err=%v", attempt, allowed, err)
		}
	}
	allowed, err := limiter.Allow(ctx, userID, application.RateBucketConversationCreate)
	if err != nil {
		t.Fatalf("overflow attempt: %v", err)
	}
	if allowed {
		t.Fatal("request limiter allowed an overflow request")
	}
	for attempt := 0; attempt < policies[application.RateBucketMessage].limit; attempt++ {
		allowed, err := limiter.Allow(ctx, userID, application.RateBucketMessage)
		if err != nil || !allowed {
			t.Fatalf("message attempt %d allowed=%t err=%v", attempt, allowed, err)
		}
	}
	allowed, err = limiter.Allow(ctx, userID, application.RateBucketMessage)
	if err != nil {
		t.Fatalf("message overflow attempt: %v", err)
	}
	if allowed {
		t.Fatal("message limiter allowed an overflow request")
	}
	if count, err := limiter.client.Get(ctx, messageKey).Int(); err != nil || count != 61 {
		t.Fatalf("canonical message quota count = %d, err=%v; want 61 at key %q", count, err, messageKey)
	}
	if exists, err := limiter.client.Exists(ctx, legacyMessageKey).Result(); err != nil || exists != 0 {
		t.Fatalf("legacy chat message quota key exists=%d err=%v; want no legacy key", exists, err)
	}
	for attempt := 0; attempt < policies[application.RateBucketGroupMutation].limit; attempt++ {
		allowed, err := limiter.Allow(ctx, userID, application.RateBucketGroupMutation)
		if err != nil || !allowed {
			t.Fatalf("group mutation attempt %d allowed=%t err=%v", attempt, allowed, err)
		}
	}
	allowed, err = limiter.Allow(ctx, userID, application.RateBucketGroupMutation)
	if err != nil {
		t.Fatalf("group mutation overflow attempt: %v", err)
	}
	if allowed {
		t.Fatal("group mutation limiter allowed an overflow request")
	}
	for _, bucket := range []string{application.RateBucketGroupList, application.RateBucketGroupGet} {
		for attempt := 0; attempt < policies[bucket].limit; attempt++ {
			allowed, err := limiter.Allow(ctx, userID, bucket)
			if err != nil || !allowed {
				t.Fatalf("%s attempt %d allowed=%t err=%v", bucket, attempt, allowed, err)
			}
		}
		allowed, err := limiter.Allow(ctx, userID, bucket)
		if err != nil {
			t.Fatalf("%s overflow attempt: %v", bucket, err)
		}
		if allowed {
			t.Fatalf("%s limiter allowed an overflow request", bucket)
		}
	}
}
