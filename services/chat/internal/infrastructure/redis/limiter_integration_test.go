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
	defer func() { _ = limiter.client.Del(ctx, key).Err() }()

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
}
