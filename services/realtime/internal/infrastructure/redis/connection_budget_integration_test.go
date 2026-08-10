package redis

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestConnectionBudgetIntegration(t *testing.T) {
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
	connections := make([]string, 0, connectionBudgetLimit+1)
	for index := 0; index < connectionBudgetLimit; index++ {
		connection := uuid.NewString()
		allowed, err := coordinator.AllowConnection(ctx, userID, connection)
		if err != nil || !allowed {
			t.Fatalf("connection %d allowed=%t err=%v", index, allowed, err)
		}
		connections = append(connections, connection)
	}
	denied, err := coordinator.AllowConnection(ctx, userID, uuid.NewString())
	if err != nil {
		t.Fatalf("overflow admission: %v", err)
	}
	if denied {
		t.Fatal("connection budget allowed an overflow connection")
	}
	if err := coordinator.ReleaseConnection(ctx, userID, connections[0]); err != nil {
		t.Fatalf("release connection: %v", err)
	}
	allowed, err := coordinator.AllowConnection(ctx, userID, uuid.NewString())
	if err != nil || !allowed {
		t.Fatalf("connection after release allowed=%t err=%v", allowed, err)
	}
	_ = coordinator.client.Del(ctx, connectionBudgetKey(userID)).Err()
}
