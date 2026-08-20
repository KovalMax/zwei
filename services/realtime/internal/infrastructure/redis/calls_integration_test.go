package redis

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/KovalMax/zwei/services/realtime/internal/application"
)

func TestCallReservationIntegration(t *testing.T) {
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

	callerID, recipientID := uuid.New(), uuid.New()
	conversationID := uuid.New()
	callerDevice, recipientDevice := uuid.NewString(), uuid.NewString()
	firstCallID, secondCallID, thirdCallID := uuid.New(), uuid.New(), uuid.New()
	defer func() {
		_ = coordinator.client.Del(ctx,
			callKey(firstCallID), callKey(secondCallID), callKey(thirdCallID),
			callUserKey(callerID), callUserKey(recipientID),
			callDeviceKey(callerID, callerDevice), callDeviceKey(recipientID, recipientDevice),
		).Err()
		_ = coordinator.client.ZRem(ctx, callExpiryKey(), firstCallID.String(), secondCallID.String(), thirdCallID.String()).Err()
	}()

	first, err := coordinator.Start(ctx, application.Call{
		ID:             firstCallID,
		ConversationID: conversationID,
		CallerID:       callerID,
		RecipientID:    recipientID,
		CallerDeviceID: callerDevice,
	})
	if err != nil {
		t.Fatalf("start first call: %v", err)
	}
	if _, err := coordinator.Accept(ctx, first.ID, recipientID, recipientDevice); err != nil {
		t.Fatalf("accept first call: %v", err)
	}

	callerConnection := callerID.String() + ":" + callerDevice
	recipientConnection := recipientID.String() + ":" + recipientDevice
	if _, err := coordinator.Connect(ctx, callerID, callerConnection); err != nil {
		t.Fatalf("connect caller device: %v", err)
	}
	if _, err := coordinator.Connect(ctx, recipientID, recipientConnection); err != nil {
		t.Fatalf("connect recipient device: %v", err)
	}
	if _, err := coordinator.Start(ctx, application.Call{
		ID:             secondCallID,
		ConversationID: conversationID,
		CallerID:       callerID,
		RecipientID:    recipientID,
		CallerDeviceID: callerDevice,
	}); !errors.Is(err, application.ErrCallBusy) {
		t.Fatalf("start while active devices are present: err=%v, want busy", err)
	}
	if _, err := coordinator.Disconnect(ctx, callerID, callerConnection); err != nil {
		t.Fatalf("disconnect caller device: %v", err)
	}
	if _, err := coordinator.Disconnect(ctx, recipientID, recipientConnection); err != nil {
		t.Fatalf("disconnect recipient device: %v", err)
	}

	if _, err := coordinator.Start(ctx, application.Call{
		ID:             secondCallID,
		ConversationID: conversationID,
		CallerID:       callerID,
		RecipientID:    recipientID,
		CallerDeviceID: callerDevice,
	}); err != nil {
		t.Fatalf("recover abandoned active call: %v", err)
	}
	if _, err := coordinator.Accept(ctx, secondCallID, recipientID, recipientDevice); err != nil {
		t.Fatalf("accept recovered call: %v", err)
	}

	ended, err := coordinator.EndByDevice(ctx, callerID, callerDevice)
	if err != nil {
		t.Fatalf("end recovered call by device: %v", err)
	}
	if len(ended) != 1 || ended[0].ID != secondCallID {
		t.Fatalf("ended calls = %#v, want call %s", ended, secondCallID)
	}

	if _, err := coordinator.Start(ctx, application.Call{
		ID:             thirdCallID,
		ConversationID: conversationID,
		CallerID:       callerID,
		RecipientID:    recipientID,
		CallerDeviceID: callerDevice,
	}); err != nil {
		t.Fatalf("start call after device cleanup: %v", err)
	}
	ended, err = coordinator.EndByDevice(ctx, callerID, callerDevice)
	if err != nil || len(ended) != 1 || ended[0].ID != thirdCallID {
		t.Fatalf("end ringing call by device: calls=%#v err=%v", ended, err)
	}
}
