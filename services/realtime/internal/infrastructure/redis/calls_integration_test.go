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

func startAdmittedCall(ctx context.Context, coordinator *PresenceCoordinator, call application.Call) (application.Call, error) {
	userIDs := []uuid.UUID{call.CallerID, call.RecipientID}
	token, err := coordinator.AcquireCallAdmission(ctx, userIDs)
	if err != nil {
		return application.Call{}, err
	}
	defer coordinator.ReleaseCallAdmission(ctx, userIDs, token)
	return coordinator.Start(ctx, call, token)
}

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
	replica, err := NewPresenceCoordinator(rawURL)
	if err != nil {
		t.Fatalf("create second coordinator: %v", err)
	}
	defer replica.Close()

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

	callerConnection := callerID.String() + ":" + callerDevice
	recipientConnection := recipientID.String() + ":" + recipientDevice
	if _, err := coordinator.Connect(ctx, callerID, callerConnection); err != nil {
		t.Fatalf("connect caller device: %v", err)
	}
	if _, err := coordinator.Connect(ctx, recipientID, recipientConnection); err != nil {
		t.Fatalf("connect recipient device: %v", err)
	}

	first, err := startAdmittedCall(ctx, coordinator, application.Call{
		ID:                 firstCallID,
		SupportRef:         uuid.New(),
		ConversationID:     conversationID,
		CallerID:           callerID,
		RecipientID:        recipientID,
		CallerDeviceID:     callerDevice,
		CallerConnectionID: callerConnection,
	})
	if err != nil {
		t.Fatalf("start first call: %v", err)
	}
	fromRedis, err := replica.Get(ctx, firstCallID)
	if err != nil || fromRedis.SupportRef != first.SupportRef || fromRedis.SupportRef == uuid.Nil {
		t.Fatalf("call support_ref from shared state = %s, start=%s, err=%v", fromRedis.SupportRef, first.SupportRef, err)
	}
	if _, err := coordinator.Accept(ctx, first.ID, recipientID, recipientDevice, recipientConnection); err != nil {
		t.Fatalf("accept first call: %v", err)
	}

	if _, err := startAdmittedCall(ctx, coordinator, application.Call{
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
	replacementCallerConnection := callerConnection + "-replacement"
	replacementRecipientConnection := recipientConnection + "-replacement"
	if _, err := coordinator.Connect(ctx, callerID, replacementCallerConnection); err != nil {
		t.Fatalf("reconnect caller device: %v", err)
	}
	if _, err := coordinator.Connect(ctx, recipientID, replacementRecipientConnection); err != nil {
		t.Fatalf("reconnect recipient device: %v", err)
	}

	if _, err := startAdmittedCall(ctx, coordinator, application.Call{
		ID:                 secondCallID,
		ConversationID:     conversationID,
		CallerID:           callerID,
		RecipientID:        recipientID,
		CallerDeviceID:     callerDevice,
		CallerConnectionID: replacementCallerConnection,
	}); err != nil {
		t.Fatalf("recover abandoned active call: %v", err)
	}
	if _, err := coordinator.Accept(ctx, secondCallID, recipientID, recipientDevice, replacementRecipientConnection); err != nil {
		t.Fatalf("accept recovered call: %v", err)
	}

	ended, err := coordinator.EndByDevice(ctx, callerID, callerDevice, replacementCallerConnection)
	if err != nil {
		t.Fatalf("end recovered call by device: %v", err)
	}
	if len(ended) != 1 || ended[0].ID != secondCallID {
		t.Fatalf("ended calls = %#v, want call %s", ended, secondCallID)
	}
	_, _ = coordinator.Disconnect(ctx, callerID, replacementCallerConnection)
	_, _ = coordinator.Disconnect(ctx, recipientID, replacementRecipientConnection)
	if _, err := coordinator.Connect(ctx, callerID, callerConnection); err != nil {
		t.Fatalf("reconnect caller device: %v", err)
	}
	if _, err := coordinator.Connect(ctx, recipientID, recipientConnection); err != nil {
		t.Fatalf("reconnect recipient device: %v", err)
	}

	if _, err := startAdmittedCall(ctx, coordinator, application.Call{
		ID:                 thirdCallID,
		ConversationID:     conversationID,
		CallerID:           callerID,
		RecipientID:        recipientID,
		CallerDeviceID:     callerDevice,
		CallerConnectionID: callerConnection,
	}); err != nil {
		t.Fatalf("start call after device cleanup: %v", err)
	}
	ended, err = coordinator.EndByDevice(ctx, callerID, callerDevice, callerConnection)
	if err != nil || len(ended) != 1 || ended[0].ID != thirdCallID {
		t.Fatalf("end ringing call by device: calls=%#v err=%v", ended, err)
	}
}

func TestRingingReservationRecoversAfterRecipientDisconnect(t *testing.T) {
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
	callerDevice, recipientDevice := uuid.NewString(), uuid.NewString()
	firstCallID, retryCallID := uuid.New(), uuid.New()
	callerConnection := callerID.String() + ":" + callerDevice
	recipientConnection := recipientID.String() + ":" + recipientDevice
	defer func() {
		_ = coordinator.client.Del(ctx, callKey(firstCallID), callKey(retryCallID), callUserKey(callerID), callUserKey(recipientID), callDeviceKey(callerID, callerDevice), callDeviceKey(recipientID, recipientDevice)).Err()
		_ = coordinator.client.ZRem(ctx, callExpiryKey(), firstCallID.String(), retryCallID.String()).Err()
		_, _ = coordinator.Disconnect(ctx, callerID, callerConnection)
		_, _ = coordinator.Disconnect(ctx, recipientID, recipientConnection)
	}()

	if _, err := coordinator.Connect(ctx, callerID, callerConnection); err != nil {
		t.Fatalf("connect caller: %v", err)
	}
	if _, err := coordinator.Connect(ctx, recipientID, recipientConnection); err != nil {
		t.Fatalf("connect recipient: %v", err)
	}
	if _, err := startAdmittedCall(ctx, coordinator, application.Call{ID: firstCallID, ConversationID: uuid.New(), CallerID: callerID, RecipientID: recipientID, CallerDeviceID: callerDevice, CallerConnectionID: callerConnection}); err != nil {
		t.Fatalf("start ringing call: %v", err)
	}
	if _, err := coordinator.Disconnect(ctx, recipientID, recipientConnection); err != nil {
		t.Fatalf("disconnect recipient: %v", err)
	}
	ended, err := coordinator.EndByDevice(ctx, recipientID, recipientDevice, recipientConnection)
	if err != nil {
		t.Fatalf("end ringing call after recipient disconnect: %v", err)
	}
	if len(ended) != 1 || ended[0].ID != firstCallID {
		t.Fatalf("ended calls = %#v, want call %s", ended, firstCallID)
	}

	if _, err := startAdmittedCall(ctx, coordinator, application.Call{ID: retryCallID, ConversationID: uuid.New(), CallerID: callerID, RecipientID: recipientID, CallerDeviceID: callerDevice, CallerConnectionID: callerConnection}); err != nil {
		t.Fatalf("start call while recipient is offline: %v", err)
	}
	call, err := coordinator.Get(ctx, retryCallID)
	if err != nil || call.Status != "ringing" {
		t.Fatalf("offline recipient call = status %q, err=%v; want ringing", call.Status, err)
	}
}

func TestOfflineRecipientDoesNotRecoverLiveRingingReservation(t *testing.T) {
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
	callerDevice, recipientDevice := uuid.NewString(), uuid.NewString()
	callerConnection := callerID.String() + ":" + callerDevice
	recipientConnection := recipientID.String() + ":" + recipientDevice
	firstCallID, retryCallID := uuid.New(), uuid.New()
	defer func() {
		_ = coordinator.client.Del(ctx, callKey(firstCallID), callKey(retryCallID), callUserKey(callerID), callUserKey(recipientID), callDeviceKey(callerID, callerDevice), callDeviceKey(recipientID, recipientDevice)).Err()
		_ = coordinator.client.ZRem(ctx, callExpiryKey(), firstCallID.String(), retryCallID.String()).Err()
		_, _ = coordinator.Disconnect(ctx, callerID, callerConnection)
		_, _ = coordinator.Disconnect(ctx, recipientID, recipientConnection)
	}()
	if _, err := coordinator.Connect(ctx, callerID, callerConnection); err != nil {
		t.Fatalf("connect caller: %v", err)
	}
	if _, err := coordinator.Connect(ctx, recipientID, recipientConnection); err != nil {
		t.Fatalf("connect recipient: %v", err)
	}
	started, err := startAdmittedCall(ctx, coordinator, application.Call{ID: firstCallID, ConversationID: uuid.New(), CallerID: callerID, RecipientID: recipientID, CallerDeviceID: callerDevice, CallerConnectionID: callerConnection})
	if err != nil {
		t.Fatalf("start initial ringing call: %v", err)
	}
	if _, err := coordinator.Disconnect(ctx, recipientID, recipientConnection); err != nil {
		t.Fatalf("disconnect recipient: %v", err)
	}
	if _, err := startAdmittedCall(ctx, coordinator, application.Call{ID: retryCallID, ConversationID: uuid.New(), CallerID: callerID, RecipientID: recipientID, CallerDeviceID: callerDevice, CallerConnectionID: callerConnection}); !errors.Is(err, application.ErrCallBusy) {
		t.Fatalf("retry with live caller and offline recipient: err=%v, want busy", err)
	}
	current, err := coordinator.Get(ctx, firstCallID)
	if err != nil || current.Status != "ringing" || !current.ExpiresAt.Equal(started.ExpiresAt) {
		t.Fatalf("original ringing reservation = status %q expiry %s err=%v; want unchanged ringing expiry %s", current.Status, current.ExpiresAt, err, started.ExpiresAt)
	}
}
