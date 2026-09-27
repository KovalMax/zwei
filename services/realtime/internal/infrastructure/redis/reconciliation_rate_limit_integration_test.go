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
