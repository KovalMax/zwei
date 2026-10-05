package redis

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestReconciliationRateLimitIntegration(t *testing.T) {
	rawURL := os.Getenv("ZWEI_TEST_REDIS_URL")
	if rawURL == "" {
		t.Skip("set ZWEI_TEST_REDIS_URL to run Redis integration tests")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	coordinator, err := NewPresenceCoordinator(rawURL)
	if err != nil {
		t.Fatalf("create coordinator: %v", err)
	}
	defer coordinator.Close()

	userID := uuid.New()
	key := commandRateKey("reconcile", userID)
	defer func() { _ = coordinator.client.Del(ctx, key).Err() }()
	for attempt := 0; attempt < reconciliationLimit; attempt++ {
		allowed, err := coordinator.AllowReconciliation(ctx, userID)
		if err != nil || !allowed {
			t.Fatalf("attempt %d allowed=%t err=%v", attempt, allowed, err)
		}
	}
	allowed, err := coordinator.AllowReconciliation(ctx, userID)
	if err != nil {
		t.Fatalf("overflow attempt: %v", err)
	}
	if allowed {
		t.Fatal("reconciliation limiter allowed an overflow request")
	}
}

func TestMessageRateLimitUsesCanonicalSharedKeyIntegration(t *testing.T) {
	rawURL := os.Getenv("ZWEI_TEST_REDIS_URL")
	if rawURL == "" {
		t.Skip("set ZWEI_TEST_REDIS_URL to run Redis integration tests")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	coordinator, err := NewPresenceCoordinator(rawURL)
	if err != nil {
		t.Fatalf("create coordinator: %v", err)
	}
	defer coordinator.Close()

	userID := uuid.New()
	key := messageRateKey(userID)
	defer func() { _ = coordinator.client.Del(ctx, key).Err() }()
	for attempt := 0; attempt < 60; attempt++ {
		allowed, err := coordinator.AllowMessage(ctx, userID)
		if err != nil || !allowed {
			t.Fatalf("message attempt %d allowed=%t err=%v", attempt, allowed, err)
		}
	}
	allowed, err := coordinator.AllowMessage(ctx, userID)
	if err != nil {
		t.Fatalf("message overflow attempt: %v", err)
	}
	if allowed {
		t.Fatal("message limiter allowed an overflow request")
	}
	if count, err := coordinator.client.Get(ctx, key).Int(); err != nil || count != 61 {
		t.Fatalf("canonical message quota count = %d, err=%v; want 61 at key %q", count, err, key)
	}
	if want := "zwei:rate:message:" + userID.String(); key != want {
		t.Fatalf("message quota key = %q, want canonical key %q", key, want)
	}
}
