package redis

import (
	"context"
	"os"
	"sync"
	"testing"
	"time"
)

func TestWebSocketTicketConsumptionIsAtomicIntegration(t *testing.T) {
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

	ticket := "integration-ticket-" + time.Now().UTC().Format("20060102150405.000000000")
	defer func() { _ = coordinator.client.Del(ctx, websocketTicketKey(ticket)).Err() }()

	results := make(chan bool, 2)
	var group sync.WaitGroup
	group.Add(2)
	for range 2 {
		go func() {
			defer group.Done()
			consumed, consumeErr := coordinator.ConsumeWebSocketTicket(ctx, ticket)
			if consumeErr != nil {
				t.Errorf("consume websocket ticket: %v", consumeErr)
			}
			results <- consumed
		}()
	}
	group.Wait()
	close(results)

	consumedCount := 0
	for consumed := range results {
		if consumed {
			consumedCount++
		}
	}
	if consumedCount != 1 {
		t.Fatalf("successful ticket consumptions = %d, want exactly one", consumedCount)
	}
}
