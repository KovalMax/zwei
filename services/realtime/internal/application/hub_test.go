package application

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/KovalMax/zwei/services/realtime/internal/application/callpush"
	sharedauth "github.com/KovalMax/zwei/services/shared/auth"
	"github.com/KovalMax/zwei/services/shared/messaging"
)

type testClient struct{}

func (testClient) Identity() sharedauth.Identity { return sharedauth.Identity{} }
func (testClient) SendJSON(any) bool             { return true }
func (testClient) Close()                        {}

func TestHubHandlePreservesRequestIDForRejectedCommand(t *testing.T) {
	hub := NewHub(nil, nil, nil, nil, nil, nil, nil)
	err := hub.Handle(context.Background(), testClient{}, []byte(`{"version":3,"type":"unsupported","request_id":"request-1"}`))

	var requestError *RequestError
	if !errors.As(err, &requestError) {
		t.Fatalf("expected RequestError, got %v", err)
	}
	if requestError.RequestID != "request-1" {
		t.Fatalf("request ID = %q, want %q", requestError.RequestID, "request-1")
	}
}

func TestHubRejectsUnsupportedProtocolVersion(t *testing.T) {
	hub := NewHub(nil, nil, nil, nil, nil, nil, nil)
	err := hub.HandleVersion(context.Background(), testClient{}, 1, []byte(`{"version":1,"type":"presence.refresh","request_id":"request-1"}`))

	var requestError *RequestError
	if !errors.As(err, &requestError) || requestError.Error() != "unsupported protocol version" {
		t.Fatalf("error = %v", err)
	}
}

func TestCallRecoverProjectsOnlyRecipientRingingCall(t *testing.T) {
	userID := uuid.New()
	now := time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)
	call := Call{ID: uuid.New(), SupportRef: uuid.New(), ConversationID: uuid.New(), CallerID: uuid.New(), RecipientID: userID, CallerDeviceID: "caller-device-secret", AcceptedDeviceID: "accepted-device-secret", CallerConnectionID: "caller-connection-secret", AcceptedConnectionID: "accepted-connection-secret", Status: CallRinging, ExpiresAt: now.Add(time.Minute)}
	calls := &fakeCalls{call: call}
	client := &recordingClient{identity: sharedauth.Identity{UserID: userID, DeviceID: "notification-device"}}
	hub := NewHub(nil, authorizedPresence{}, onlinePresence{}, nil, nil, calls, nil)
	hub.now = func() time.Time { return now }

	err := hub.HandleVersion(context.Background(), client, 3, []byte(`{"version":3,"type":"call.recover","request_id":"recover-1","payload":{"call_id":"`+call.ID.String()+`"}}`))
	if err != nil {
		t.Fatalf("HandleVersion() error = %v", err)
	}
	if len(client.events) != 1 {
		t.Fatalf("events = %#v, want one recovery reply", client.events)
	}
	event, ok := client.events[0].(serverEvent)
	if !ok || event.Version != 3 || event.Type != "call.recovered" || event.RequestID != "recover-1" {
		t.Fatalf("event = %#v, want correlated v2 call.recovered", client.events[0])
	}
	payload := event.Payload.(CallRecovery)
	if payload.Status != CallRecoveryRinging || payload.Call == nil || payload.Call.CallID != call.ID || payload.Call.ConversationID != call.ConversationID || payload.Call.CallerID != call.CallerID || payload.Call.Status != CallRinging || !payload.Call.ExpiresAt.Equal(call.ExpiresAt) {
		t.Fatalf("recovery payload = %+v, want ringing projection for %s", payload, call.ID)
	}
	encoded, err := json.Marshal(payload.Call)
	if err != nil {
		t.Fatalf("marshal projection: %v", err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &fields); err != nil {
		t.Fatalf("decode projection fields: %v", err)
	}
	for _, key := range []string{"call_id", "conversation_id", "caller_id", "status", "expires_at"} {
		if _, ok := fields[key]; !ok {
			t.Errorf("projection omitted %q: %s", key, encoded)
		}
	}
	if len(fields) != 5 {
		t.Fatalf("projection fields = %v, want exactly the five public fields", fields)
	}
	for _, sensitive := range []string{"device_id", "connection_id", "support_ref", "ice_servers", "credential"} {
		if bytes.Contains(encoded, []byte(sensitive)) {
			t.Fatalf("recovery projection exposed %q: %s", sensitive, encoded)
		}
	}
	if calls.call != call {
		t.Fatalf("call state changed during recovery: got %+v, want unchanged %+v", calls.call, call)
	}
}

func TestCallRecoverReturnsSameMissedOutcomeForExpiredMissingAndUnauthorizedCalls(t *testing.T) {
	userID := uuid.New()
	now := time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)
	call := Call{ID: uuid.New(), RecipientID: userID, CallerID: uuid.New(), Status: CallRinging, ExpiresAt: now.Add(-time.Minute)}
	tests := []struct {
		name string
		call Call
		err  error
	}{
		{name: "expired", call: call},
		{name: "unauthorized", call: Call{ID: call.ID, RecipientID: uuid.New(), Status: CallRinging, ExpiresAt: now.Add(time.Minute)}},
		{name: "not ringing", call: Call{ID: call.ID, RecipientID: userID, Status: CallActive, ExpiresAt: now.Add(time.Minute)}},
		{name: "missing", err: ErrCallNotFound},
	}
	var missedResponse []byte
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			client := &recordingClient{identity: sharedauth.Identity{UserID: userID, DeviceID: "device"}}
			hub := NewHub(nil, authorizedPresence{}, onlinePresence{}, nil, nil, &fakeCalls{call: test.call, getErr: test.err}, nil)
			hub.now = func() time.Time { return now }
			request := []byte(`{"version":3,"type":"call.recover","request_id":"recover-safe","payload":{"call_id":"` + call.ID.String() + `"}}`)
			if err := hub.HandleVersion(context.Background(), client, 3, request); err != nil {
				t.Fatalf("HandleVersion() error = %v", err)
			}
			if len(client.events) != 1 {
				t.Fatalf("events = %#v, want one safe reply", client.events)
			}
			event := client.events[0].(serverEvent)
			payload := event.Payload.(CallRecovery)
			if event.Type != "call.recovered" || event.RequestID != "recover-safe" || payload.Status != CallRecoveryMissed || payload.Call != nil {
				t.Fatalf("reply = %+v, want correlated missed result without call details", event)
			}
			encoded, err := json.Marshal(event)
			if err != nil {
				t.Fatalf("marshal missed reply: %v", err)
			}
			if missedResponse == nil {
				missedResponse = encoded
			} else if !bytes.Equal(encoded, missedResponse) {
				t.Fatalf("missed response differs from other unavailable states: got %s, want %s", encoded, missedResponse)
			}
		})
	}
}

func TestHubReconcilesBoundedAuthorizedV2Conversation(t *testing.T) {
	userID := uuid.New()
	conversationID := uuid.New()
	reconciler := &fakeReconciler{result: Reconciliation{Messages: []messaging.Message{{ID: uuid.New(), Sequence: 5}}, NextAfterSequence: 5, HighWatermark: 8, HasMore: true, OwnReadSequence: 4, PeerReadSequence: 3}}
	client := &recordingClient{identity: sharedauth.Identity{UserID: userID, DeviceID: uuid.NewString()}}
	hub := NewHubWithReconciliationAndLogger(nil, nil, reconciliationRateCoordinator{allowed: true}, nil, nil, reconciler, nil, nil, slog.Default())

	err := hub.HandleVersion(context.Background(), client, 3, []byte(`{"version":3,"type":"conversation.reconcile","request_id":"reconcile-1","payload":{"conversation_id":"`+conversationID.String()+`","after_sequence":4}}`))

	if err != nil {
		t.Fatalf("HandleVersion() error = %v", err)
	}
	if reconciler.userID != userID || reconciler.conversationID != conversationID || reconciler.afterSequence != 4 || reconciler.limit != ReconciliationMessageLimit {
		t.Fatalf("reconciliation request = %+v", reconciler)
	}
	if len(client.events) != 1 {
		t.Fatalf("events = %#v", client.events)
	}
	event, ok := client.events[0].(serverEvent)
	if !ok || event.Version != 3 || event.Type != "conversation.reconciled" || event.RequestID != "reconcile-1" {
		t.Fatalf("event = %#v", client.events[0])
	}
	payload := event.Payload.(Reconciliation)
	if payload.ConversationID != conversationID || len(payload.Messages) != 1 || payload.NextAfterSequence != 5 || !payload.HasMore {
		t.Fatalf("reconciliation payload = %+v", payload)
	}
}

func TestHubReconciliationEmptyMessagesMarshalAsArray(t *testing.T) {
	userID := uuid.New()
	conversationID := uuid.New()
	client := &recordingClient{identity: sharedauth.Identity{UserID: userID, DeviceID: uuid.NewString()}}
	hub := NewHubWithReconciliationAndLogger(nil, nil, reconciliationRateCoordinator{allowed: true}, nil, nil, &fakeReconciler{}, nil, nil, slog.Default())

	err := hub.HandleVersion(context.Background(), client, 3, []byte(`{"version":3,"type":"conversation.reconcile","request_id":"reconcile-1","payload":{"conversation_id":"`+conversationID.String()+`","after_sequence":0}}`))
	if err != nil {
		t.Fatalf("HandleVersion() error = %v", err)
	}
	if len(client.events) != 1 {
		t.Fatalf("events = %#v", client.events)
	}
	encoded, err := json.Marshal(client.events[0])
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	if !bytes.Contains(encoded, []byte(`"messages":[]`)) {
		t.Fatalf("reconciliation event = %s", encoded)
	}
}

func TestHubRejectsReconciliationOnV1(t *testing.T) {
	hub := NewHubWithReconciliationAndLogger(nil, nil, nil, nil, nil, &fakeReconciler{}, nil, nil, slog.Default())
	err := hub.Handle(context.Background(), testClient{}, []byte(`{"version":1,"type":"conversation.reconcile","request_id":"reconcile-1"}`))

	if err == nil || err.Error() != "unsupported protocol version" {
		t.Fatalf("error = %v, want unsupported protocol version", err)
	}
}

func TestHubRejectsRateLimitedReconciliationBeforeRepository(t *testing.T) {
	for _, test := range []struct {
		name string
		err  error
	}{
		{name: "exhausted"},
		{name: "unavailable", err: errors.New("redis unavailable")},
	} {
		t.Run(test.name, func(t *testing.T) {
			reconciler := &fakeReconciler{}
			hub := NewHubWithReconciliationAndLogger(nil, nil, reconciliationRateCoordinator{err: test.err}, nil, nil, reconciler, nil, nil, slog.Default())
			err := hub.HandleVersion(context.Background(), &recordingClient{identity: sharedauth.Identity{UserID: uuid.New()}}, 3, []byte(`{"version":3,"type":"conversation.reconcile","request_id":"reconcile-1","payload":{"conversation_id":"`+uuid.NewString()+`","after_sequence":0}}`))

			var requestError *RequestError
			if !errors.As(err, &requestError) || requestError.Error() != "reconciliation rate limit exceeded" {
				t.Fatalf("error = %v, want reconciliation rate limit exceeded", err)
			}
			if reconciler.conversationID != uuid.Nil {
				t.Fatalf("Reconcile() was called with conversation %s", reconciler.conversationID)
			}
		})
	}
}

func TestHubRetainsConversationEventWhenPublicationFails(t *testing.T) {
	publishErr := errors.New("no subscribers")
	hub := NewHub(nil, nil, failingConversationCoordinator{err: publishErr}, nil, nil, nil, nil)

	err := hub.NotifyConversationCreated(context.Background(), uuid.New(), []uuid.UUID{uuid.New()})

	if !errors.Is(err, publishErr) {
		t.Fatalf("NotifyConversationCreated error = %v, want %v", err, publishErr)
	}
}

func TestHubRejectsCanceledConversationNotification(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	hub := NewHub(nil, nil, failingConversationCoordinator{err: context.Canceled}, nil, nil, nil, nil)

	err := hub.NotifyConversationCreated(ctx, uuid.New(), []uuid.UUID{uuid.New()})

	if !errors.Is(err, context.Canceled) {
		t.Fatalf("NotifyConversationCreated error = %v, want context.Canceled", err)
	}
}

func TestHubPropagatesCallerContextToConversationPublication(t *testing.T) {
	publicationErr := errors.New("publication failed")
	ctx := context.WithValue(context.Background(), conversationContextKey{}, "preserved")
	hub := NewHub(nil, nil, contextCheckingConversationCoordinator{failingConversationCoordinator: failingConversationCoordinator{err: publicationErr}}, nil, nil, nil, nil)

	err := hub.NotifyConversationCreated(ctx, uuid.New(), []uuid.UUID{uuid.New()})

	if !errors.Is(err, publicationErr) {
		t.Fatalf("NotifyConversationCreated error = %v, want %v", err, publicationErr)
	}
}

func TestHubRejectsRateLimitedMessage(t *testing.T) {
	hub := NewHub(nil, nil, rateLimitedCoordinator{}, nil, nil, nil, nil)
	client := &recordingClient{}
	err := hub.Handle(context.Background(), client, []byte(`{"version":3,"type":"message.send","request_id":"request-1","payload":{"content_type":"text"}}`))

	var requestError *RequestError
	if !errors.As(err, &requestError) {
		t.Fatalf("expected RequestError, got %v", err)
	}
	if requestError.Error() != "message rate limit exceeded" {
		t.Fatalf("error = %q", requestError.Error())
	}
	if requestError.RequestID != "request-1" {
		t.Fatalf("request ID = %q, want request-1", requestError.RequestID)
	}
	if len(client.events) != 0 {
		t.Fatalf("events after rejection = %#v", client.events)
	}
}

func TestHubRejectsMessageWithoutSharedRateCoordinator(t *testing.T) {
	client := &recordingClient{}
	hub := NewHub(nil, nil, nil, nil, nil, nil, nil)

	err := hub.Handle(context.Background(), client, []byte(`{"version":3,"type":"message.send","request_id":"request-1","payload":{"content_type":"text"}}`))

	var requestError *RequestError
	if !errors.As(err, &requestError) || requestError.Error() != "message rate limit exceeded" {
		t.Fatalf("error = %v, want correlated message rate limit rejection", err)
	}
	if requestError.RequestID != "request-1" {
		t.Fatalf("request ID = %q, want request-1", requestError.RequestID)
	}
	if len(client.events) != 0 {
		t.Fatalf("events after rejection = %#v", client.events)
	}
}

func TestHubRejectsV1Protocol(t *testing.T) {
	client := &recordingClient{}
	hub := NewHub(nil, nil, nil, nil, nil, nil, nil)
	err := hub.HandleVersion(context.Background(), client, 1, []byte(`{"version":1,"type":"message.send","request_id":"legacy-1","payload":{"content_type":"sticker","body":"heart"}}`))
	var requestError *RequestError
	if !errors.As(err, &requestError) || requestError.RequestID != "legacy-1" || requestError.Error() != "unsupported protocol version" {
		t.Fatalf("error = %v, want correlated unsupported protocol rejection", err)
	}
	if len(client.events) != 0 {
		t.Fatalf("events after rejection = %#v", client.events)
	}
}

func TestHubRejectsNonTextMessageWrites(t *testing.T) {
	for _, payload := range []string{`{}`, `{"content_type":"sticker"}`, `{"content_type":"image"}`} {
		client := &recordingClient{}
		hub := NewHub(nil, nil, nil, nil, nil, nil, nil)
		err := hub.Handle(context.Background(), client, []byte(`{"version":3,"type":"message.send","request_id":"invalid-type","payload":`+payload+`}`))
		var requestError *RequestError
		if !errors.As(err, &requestError) || requestError.RequestID != "invalid-type" || !errors.Is(err, messaging.ErrInvalidMessage) || len(client.events) != 0 {
			t.Fatalf("payload %s: error=%v events=%v", payload, err, client.events)
		}
	}
}

func TestHubRejectsMessageWhenSharedRateCoordinatorFails(t *testing.T) {
	client := &recordingClient{}
	hub := NewHub(nil, nil, messageRateCoordinator{err: errors.New("redis unavailable")}, nil, nil, nil, nil)

	err := hub.Handle(context.Background(), client, []byte(`{"version":3,"type":"message.send","request_id":"request-1","payload":{"content_type":"text"}}`))

	var requestError *RequestError
	if !errors.As(err, &requestError) || requestError.Error() != "message rate limit exceeded" {
		t.Fatalf("error = %v, want correlated message rate limit rejection", err)
	}
	if requestError.RequestID != "request-1" {
		t.Fatalf("request ID = %q, want request-1", requestError.RequestID)
	}
	if len(client.events) != 0 {
		t.Fatalf("events after rejection = %#v", client.events)
	}
}

func TestHubRejectsRateLimitedRealtimeCommands(t *testing.T) {
	tests := []struct {
		name    string
		payload string
		want    string
	}{
		{name: "presence refresh", payload: `{"version":3,"type":"presence.refresh"}`, want: "presence refresh rate limit exceeded"},
		{name: "read", payload: `{"version":3,"type":"conversation.read","request_id":"read-1","payload":{"sequence":1}}`, want: "read rate limit exceeded"},
		{name: "call", payload: `{"version":3,"type":"call.start","request_id":"call-1","payload":{}}`, want: "call rate limit exceeded"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := NewHub(nil, nil, rateLimitedCoordinator{}, nil, nil, nil, nil).Handle(context.Background(), testClient{}, []byte(test.payload))
			var requestError *RequestError
			if !errors.As(err, &requestError) || requestError.Error() != test.want {
				t.Fatalf("error = %v, want %q", err, test.want)
			}
		})
	}
}

func TestHubRejectsRealtimeCommandsWithoutSharedRateCoordinator(t *testing.T) {
	for _, test := range []struct {
		name      string
		request   string
		requestID string
		want      string
	}{
		{name: "call", request: `{"version":3,"type":"call.start","request_id":"call-missing","payload":{"conversation_id":"` + uuid.NewString() + `"}}`, requestID: "call-missing", want: "call rate limit exceeded"},
		{name: "presence", request: `{"version":3,"type":"presence.refresh","request_id":"presence-missing"}`, requestID: "presence-missing", want: "presence refresh rate limit exceeded"},
		{name: "read", request: `{"version":3,"type":"conversation.read","request_id":"read-missing","payload":{"conversation_id":"` + uuid.NewString() + `","sequence":2}}`, requestID: "read-missing", want: "read rate limit exceeded"},
	} {
		t.Run(test.name, func(t *testing.T) {
			userID := uuid.New()
			client := &recordingClient{identity: sharedauth.Identity{UserID: userID}}
			calls := &fakeCalls{}
			cursors := &fakeReadCursors{}
			var presence *snapshotProbePresence
			if test.name == "presence" {
				presence = &snapshotProbePresence{}
			}
			hub := NewHub(nil, presence, nil, nil, cursors, calls, nil)
			err := hub.Handle(context.Background(), client, []byte(test.request))
			var requestError *RequestError
			if !errors.As(err, &requestError) || requestError.Error() != test.want {
				t.Fatalf("error = %v, want %q", err, test.want)
			}
			if requestError.RequestID != test.requestID {
				t.Fatalf("request ID = %q, want %q", requestError.RequestID, test.requestID)
			}
			if calls.started.ID != uuid.Nil || cursors.userID != uuid.Nil || len(client.events) != 0 || (presence != nil && presence.peerIDsCalls != 0) {
				t.Fatalf("missing limiter reached protected work: started=%+v cursor=%+v presence=%+v events=%#v", calls.started, cursors, presence, client.events)
			}
		})
	}
}

type snapshotProbePresence struct{ peerIDsCalls int }

func (p *snapshotProbePresence) PeerIDs(context.Context, uuid.UUID) ([]uuid.UUID, error) {
	p.peerIDsCalls++
	return nil, nil
}
func (*snapshotProbePresence) RecipientID(context.Context, uuid.UUID, uuid.UUID) (uuid.UUID, error) {
	return uuid.Nil, nil
}

func TestHubRejectsRealtimeCommandsWhenSharedRateCoordinatorFails(t *testing.T) {
	for _, test := range []struct {
		name      string
		request   string
		requestID string
		want      string
	}{
		{name: "call", request: `{"version":3,"type":"call.start","request_id":"call-error","payload":{"conversation_id":"` + uuid.NewString() + `"}}`, requestID: "call-error", want: "call rate limit exceeded"},
		{name: "presence", request: `{"version":3,"type":"presence.refresh","request_id":"presence-error"}`, requestID: "presence-error", want: "presence refresh rate limit exceeded"},
		{name: "read", request: `{"version":3,"type":"conversation.read","request_id":"read-error","payload":{"conversation_id":"` + uuid.NewString() + `","sequence":2}}`, requestID: "read-error", want: "read rate limit exceeded"},
	} {
		t.Run(test.name, func(t *testing.T) {
			client := &recordingClient{identity: sharedauth.Identity{UserID: uuid.New()}}
			calls := &fakeCalls{}
			cursors := &fakeReadCursors{}
			var presence *snapshotProbePresence
			if test.name == "presence" {
				presence = &snapshotProbePresence{}
			}
			hub := NewHub(nil, presence, failingRealtimeRateCoordinator{err: errors.New("redis unavailable")}, nil, cursors, calls, nil)
			err := hub.Handle(context.Background(), client, []byte(test.request))
			var requestError *RequestError
			if !errors.As(err, &requestError) || requestError.Error() != test.want {
				t.Fatalf("error = %v, want %q", err, test.want)
			}
			if requestError.RequestID != test.requestID {
				t.Fatalf("request ID = %q, want %q", requestError.RequestID, test.requestID)
			}
			if calls.started.ID != uuid.Nil || cursors.userID != uuid.Nil || len(client.events) != 0 || (presence != nil && presence.peerIDsCalls != 0) {
				t.Fatalf("limiter failure reached protected work: started=%+v cursor=%+v presence=%+v events=%#v", calls.started, cursors, presence, client.events)
			}
		})
	}
}

type failingRealtimeRateCoordinator struct {
	rateLimitedCoordinator
	err error
}

func (c failingRealtimeRateCoordinator) AllowPresenceRefresh(context.Context, uuid.UUID) (bool, error) {
	return true, c.err
}
func (c failingRealtimeRateCoordinator) AllowRead(context.Context, uuid.UUID) (bool, error) {
	return true, c.err
}
func (c failingRealtimeRateCoordinator) AllowCall(context.Context, uuid.UUID) (bool, error) {
	return true, c.err
}
func (c failingRealtimeRateCoordinator) AllowSignal(context.Context, uuid.UUID) (bool, error) {
	return true, c.err
}

func TestHubReplaysAndMarksPendingMessagesOnConnection(t *testing.T) {
	deviceID := uuid.New()
	messageID := uuid.New()
	delivery := &fakeDelivery{pending: []messaging.Message{{ID: messageID, ConversationID: uuid.New(), SenderID: uuid.New(), Body: "offline message"}}}
	client := &recordingClient{identity: sharedauth.Identity{UserID: uuid.New(), DeviceID: deviceID.String()}}
	hub := NewHub(nil, nil, nil, delivery, nil, nil, nil)

	hub.Add(context.Background(), client)

	if len(client.events) != 2 {
		t.Fatalf("events = %d, want presence snapshot and replay", len(client.events))
	}
	event, ok := client.events[1].(serverEvent)
	if !ok || event.Version != ProtocolVersion || event.Type != "message.created" {
		t.Fatalf("replay event = %#v", client.events[1])
	}
	if delivery.markedDeviceID != deviceID || len(delivery.markedMessageIDs) != 1 || delivery.markedMessageIDs[0] != messageID {
		t.Fatalf("marked delivery = device %s messages %v", delivery.markedDeviceID, delivery.markedMessageIDs)
	}
}

func TestHubDoesNotMarkPendingMessageWhenSocketQueueRejects(t *testing.T) {
	deviceID := uuid.New()
	delivery := &fakeDelivery{pending: []messaging.Message{{ID: uuid.New(), ConversationID: uuid.New(), SenderID: uuid.New(), Body: "offline message"}}}
	client := &recordingClient{identity: sharedauth.Identity{UserID: uuid.New(), DeviceID: deviceID.String()}, sendFailure: true}
	hub := NewHub(nil, nil, nil, delivery, nil, nil, nil)

	hub.replayPending(context.Background(), client)

	if len(delivery.markedMessageIDs) != 0 {
		t.Fatalf("marked delivery after queue rejection = %v", delivery.markedMessageIDs)
	}
}

func TestHubMarksOnlyQueuedPrefixDuringReplay(t *testing.T) {
	deviceID := uuid.New()
	firstID, secondID := uuid.New(), uuid.New()
	delivery := &fakeDelivery{pending: []messaging.Message{
		{ID: firstID, ConversationID: uuid.New(), SenderID: uuid.New(), Body: "first"},
		{ID: secondID, ConversationID: uuid.New(), SenderID: uuid.New(), Body: "second"},
	}}
	client := &recordingClient{identity: sharedauth.Identity{UserID: uuid.New(), DeviceID: deviceID.String()}, sendLimit: 1}
	hub := NewHub(nil, nil, nil, delivery, nil, nil, nil)

	hub.replayPending(context.Background(), client)

	if len(delivery.markedMessageIDs) != 1 || delivery.markedMessageIDs[0] != firstID {
		t.Fatalf("marked delivery = %v, want only %s", delivery.markedMessageIDs, firstID)
	}
}

func TestHubRetainsLiveDeliveryWhenSocketQueueRejects(t *testing.T) {
	recipientID := uuid.New()
	delivery := &fakeDelivery{}
	client := &recordingClient{identity: sharedauth.Identity{UserID: recipientID, DeviceID: uuid.NewString()}, sendFailure: true}
	hub := NewHub(nil, nil, nil, delivery, nil, nil, nil)
	hub.Add(context.Background(), client)

	hub.DeliverMessageCreated(messaging.Message{ID: uuid.New(), RecipientID: recipientID})

	if len(delivery.markedMessageIDs) != 0 {
		t.Fatalf("marked live delivery after queue rejection = %v", delivery.markedMessageIDs)
	}
}

func TestHubDeliversPresenceChangeLocallyWhenPublishingSucceeds(t *testing.T) {
	userID := uuid.New()
	peerID := uuid.New()
	coord := &recordingPresenceCoordinator{}
	hub := NewHub(nil, peerPresence{peerIDs: []uuid.UUID{peerID}}, coord, nil, nil, nil, nil)
	peer := &recordingClient{identity: sharedauth.Identity{UserID: peerID, DeviceID: uuid.NewString()}}
	hub.Add(context.Background(), peer)
	peer.events = nil

	hub.publishPresenceChange(context.Background(), userID, true)

	if len(peer.events) != 1 {
		t.Fatalf("peer events = %d, want 1", len(peer.events))
	}
	event, ok := peer.events[0].(serverEvent)
	if !ok || event.Type != "presence.changed" {
		t.Fatalf("presence event = %#v", peer.events[0])
	}
	if coord.userID != userID || !coord.online {
		t.Fatalf("published presence = user %s online %t", coord.userID, coord.online)
	}
}

func TestHubDeliversTypingLocallyWhenPublishingSucceeds(t *testing.T) {
	conversationID := uuid.New()
	senderID := uuid.New()
	peerID := uuid.New()
	coord := &recordingPresenceCoordinator{}
	hub := NewHub(nil, authorizedPresence{recipientID: peerID}, coord, nil, nil, nil, nil)
	peer := &recordingClient{identity: sharedauth.Identity{UserID: peerID, DeviceID: uuid.NewString()}}
	hub.Add(context.Background(), peer)
	peer.events = nil

	err := hub.Handle(context.Background(), &recordingClient{identity: sharedauth.Identity{UserID: senderID, DeviceID: uuid.NewString()}}, []byte(`{"version":3,"type":"typing.start","payload":{"conversation_id":"`+conversationID.String()+`"}}`))

	if err != nil {
		t.Fatalf("Handle() error = %v", err)
	}
	if len(peer.events) != 1 {
		t.Fatalf("peer events = %d, want 1", len(peer.events))
	}
	event, ok := peer.events[0].(serverEvent)
	if !ok || event.Type != "typing.started" {
		t.Fatalf("typing event = %#v", peer.events[0])
	}
	if coord.typingConversationID != conversationID || coord.typingUserID != senderID || !coord.typingStarted {
		t.Fatalf("published typing = conversation %s user %s started %t", coord.typingConversationID, coord.typingUserID, coord.typingStarted)
	}
}

func TestHubFansOutGroupTypingOnlyToResolvedOtherMembers(t *testing.T) {
	conversationID, senderID := uuid.New(), uuid.New()
	activePeer, removedPeer, unrelatedPeer := uuid.New(), uuid.New(), uuid.New()
	presence := groupTypingPresence{authorizedPresence: authorizedPresence{recipientID: activePeer}, recipients: []uuid.UUID{senderID, activePeer}}
	hub := NewHub(nil, presence, nil, nil, nil, nil, nil)
	sender := &recordingClient{identity: sharedauth.Identity{UserID: senderID, DeviceID: "sender"}}
	active := &recordingClient{identity: sharedauth.Identity{UserID: activePeer, DeviceID: "active"}}
	removed := &recordingClient{identity: sharedauth.Identity{UserID: removedPeer, DeviceID: "removed"}}
	unrelated := &recordingClient{identity: sharedauth.Identity{UserID: unrelatedPeer, DeviceID: "unrelated"}}
	for _, client := range []*recordingClient{sender, active, removed, unrelated} {
		hub.Add(context.Background(), client)
		client.events = nil
	}

	request := []byte(`{"version":3,"type":"typing.stop","payload":{"conversation_id":"` + conversationID.String() + `"}}`)
	if err := hub.Handle(context.Background(), sender, request); err != nil {
		t.Fatalf("handle group typing.stop: %v", err)
	}

	if len(sender.events) != 0 || len(removed.events) != 0 || len(unrelated.events) != 0 {
		t.Fatalf("typing leaked: sender=%v removed=%v unrelated=%v", sender.events, removed.events, unrelated.events)
	}
	if len(active.events) != 1 {
		t.Fatalf("active peer events = %d, want one", len(active.events))
	}
	event, ok := active.events[0].(serverEvent)
	if !ok || event.Type != "typing.stopped" {
		t.Fatalf("active peer event = %#v", active.events[0])
	}
}

type groupTypingPresence struct {
	authorizedPresence
	recipients []uuid.UUID
}

func (p groupTypingPresence) ResolveTypingRecipients(context.Context, uuid.UUID, uuid.UUID) ([]uuid.UUID, error) {
	return p.recipients, nil
}

func TestHubPublishesAuthorizedReadCursorToPeer(t *testing.T) {
	conversationID := uuid.New()
	readerID := uuid.New()
	peerID := uuid.New()
	cursors := &fakeReadCursors{sequence: 5, visibleFromSequence: 3, recipientIDs: []uuid.UUID{peerID}}
	hub := NewHub(nil, authorizedPresence{recipientID: peerID}, onlinePresence{}, nil, cursors, nil, nil)
	peer := &recordingClient{identity: sharedauth.Identity{UserID: peerID, DeviceID: uuid.NewString()}}
	reader := &recordingClient{identity: sharedauth.Identity{UserID: readerID, DeviceID: uuid.NewString()}}
	hub.Add(context.Background(), peer)
	hub.Add(context.Background(), reader)
	peer.events = nil
	reader.events = nil

	err := hub.Handle(context.Background(), reader, []byte(`{"version":3,"type":"conversation.read","payload":{"conversation_id":"`+conversationID.String()+`","sequence":9}}`))
	if err != nil {
		t.Fatalf("Handle() error = %v", err)
	}
	if cursors.userID != readerID || cursors.conversationID != conversationID || cursors.requestedSequence != 9 {
		t.Fatalf("cursor advance = %+v", cursors)
	}
	if len(reader.events) != 1 {
		t.Fatalf("reader events = %d, want 1", len(reader.events))
	}
	if len(peer.events) != 1 {
		t.Fatalf("peer events = %d, want 1", len(peer.events))
	}
	event, ok := peer.events[0].(serverEvent)
	if !ok || event.Version != ProtocolVersion || event.Type != "conversation.read" {
		t.Fatalf("read event = %#v", peer.events[0])
	}
	payload := event.Payload.(struct {
		ConversationID      uuid.UUID `json:"conversation_id"`
		UserID              uuid.UUID `json:"user_id"`
		Sequence            int64     `json:"sequence"`
		VisibleFromSequence int64     `json:"visible_from_sequence"`
	})
	if payload.UserID != readerID || payload.Sequence != 5 || payload.VisibleFromSequence != 3 {
		t.Fatalf("read payload = %+v", payload)
	}
}

func TestHubReadCursorFansOutToGroupPeersOnceAndAuthorizesBeforeAdvance(t *testing.T) {
	readerID, firstPeerID, secondPeerID, conversationID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	cursors := &fakeReadCursors{sequence: 8}
	cursors.recipientIDs = []uuid.UUID{readerID, firstPeerID, secondPeerID}
	presence := &readRecipientsPresence{}
	hub := NewHub(nil, presence, onlinePresence{}, nil, cursors, nil, nil)
	reader := &recordingClient{identity: sharedauth.Identity{UserID: readerID, DeviceID: "reader"}}
	firstPeer := &recordingClient{identity: sharedauth.Identity{UserID: firstPeerID, DeviceID: "first"}}
	secondPeer := &recordingClient{identity: sharedauth.Identity{UserID: secondPeerID, DeviceID: "second"}}
	for _, client := range []*recordingClient{reader, firstPeer, secondPeer} {
		hub.Add(context.Background(), client)
		client.events = nil
	}
	request := []byte(`{"version":3,"type":"conversation.read","payload":{"conversation_id":"` + conversationID.String() + `","sequence":8}}`)
	if err := hub.Handle(context.Background(), reader, request); err != nil {
		t.Fatalf("group read: %v", err)
	}
	if cursors.userID != readerID || cursors.conversationID != conversationID {
		t.Fatalf("cursor inputs: %+v", cursors)
	}
	for name, client := range map[string]*recordingClient{"reader": reader, "first peer": firstPeer, "second peer": secondPeer} {
		if len(client.events) != 1 {
			t.Errorf("%s received %d read events, want one", name, len(client.events))
		}
	}

}

func TestHubStartsCallForOnlineConversationPeer(t *testing.T) {
	callerID := uuid.New()
	recipientID := uuid.New()
	conversationID := uuid.New()
	calls := &fakeCalls{}
	hub := NewHub(nil, authorizedPresence{recipientID: recipientID}, onlinePresence{}, nil, nil, calls, nil)
	caller := &recordingClient{identity: sharedauth.Identity{UserID: callerID, DeviceID: "caller-device"}}
	recipient := &recordingClient{identity: sharedauth.Identity{UserID: recipientID, DeviceID: "recipient-device"}}
	hub.Add(context.Background(), caller)
	hub.Add(context.Background(), recipient)
	caller.events = nil
	recipient.events = nil

	err := hub.Handle(context.Background(), caller, []byte(`{"version":3,"type":"call.start","request_id":"call-1","payload":{"conversation_id":"`+conversationID.String()+`"}}`))
	if err != nil {
		t.Fatalf("Handle() error = %v", err)
	}
	if len(recipient.events) != 1 || recipient.events[0].(serverEvent).Type != "call.incoming" {
		t.Fatalf("recipient events = %#v", recipient.events)
	}
	if len(caller.events) != 1 || caller.events[0].(serverEvent).Type != "call.ringing" {
		t.Fatalf("caller events = %#v", caller.events)
	}
	if calls.started.CallerID != callerID || calls.started.RecipientID != recipientID || calls.started.ConversationID != conversationID {
		t.Fatalf("started call = %+v", calls.started)
	}
	if calls.started.SupportRef == uuid.Nil {
		t.Fatal("successful call start has no server-generated support_ref")
	}
}

func TestHubStartsAuthorizedDirectCallWhileRecipientOfflineAndEnqueuesPush(t *testing.T) {
	callerID, recipientID, conversationID := uuid.New(), uuid.New(), uuid.New()
	calls := &fakeCalls{}
	hub := NewHub(nil, authorizedPresence{recipientID: recipientID}, offlineCallCoordinator{}, nil, nil, calls, nil)
	queue := &callPushRecorder{}
	hub.SetCallPushQueue(queue)
	caller := &recordingClient{identity: sharedauth.Identity{UserID: callerID, DeviceID: "caller-device"}, connectionID: "caller-socket"}
	request := []byte(`{"version":3,"type":"call.start","request_id":"offline-call","payload":{"conversation_id":"` + conversationID.String() + `"}}`)
	if err := hub.Handle(context.Background(), caller, request); err != nil {
		t.Fatalf("offline call start: %v", err)
	}
	if calls.started.RecipientID != recipientID || calls.started.Status != CallRinging {
		t.Fatalf("started call = %+v", calls.started)
	}
	if len(queue.jobs) != 1 || queue.jobs[0].CallID != calls.started.ID || queue.jobs[0].Recipients[0] != recipientID || queue.jobs[0].StarterID != callerID {
		t.Fatalf("queued call push = %+v", queue.jobs)
	}
}

type callPushRecorder struct{ jobs []callpush.Job }

func (r *callPushRecorder) Enqueue(job callpush.Job) bool { r.jobs = append(r.jobs, job); return false }

type offlineCallCoordinator struct{ onlinePresence }

func (offlineCallCoordinator) Online(_ context.Context, ids []uuid.UUID) (map[uuid.UUID]bool, error) {
	result := make(map[uuid.UUID]bool, len(ids))
	for _, id := range ids {
		result[id] = false
	}
	return result, nil
}

func TestHubGeneratesSupportRefBeforeDirectStartRejection(t *testing.T) {
	callerID, conversationID := uuid.New(), uuid.New()
	hub := NewHub(nil, authorizedPresence{recipientID: uuid.New()}, onlinePresence{}, nil, nil, nil, nil)
	client := &recordingClient{identity: sharedauth.Identity{UserID: callerID, DeviceID: "device"}, connectionID: "socket-1"}
	err := hub.Handle(context.Background(), client, []byte(`{"version":3,"type":"call.start","request_id":"start-rejected","payload":{"conversation_id":"`+conversationID.String()+`"}}`))
	var requestError *RequestError
	if !errors.As(err, &requestError) || requestError.SupportRef == uuid.Nil {
		t.Fatalf("rejected start error = %#v, want support_ref", err)
	}
}

func TestHubMalformedDirectCallStartsDoNotGenerateSupportRef(t *testing.T) {
	tests := []struct {
		name    string
		command string
	}{
		{
			name:    "invalid conversation UUID",
			command: `{"version":3,"type":"call.start","request_id":"invalid-uuid","payload":{"conversation_id":"not-a-uuid"}}`,
		},
		{
			name:    "missing conversation ID",
			command: `{"version":3,"type":"call.start","request_id":"missing-conversation","payload":{}}`,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			hub := NewHub(nil, authorizedPresence{recipientID: uuid.New()}, onlinePresence{}, nil, nil, nil, nil)
			client := &recordingClient{identity: sharedauth.Identity{UserID: uuid.New(), DeviceID: "device"}}
			err := hub.Handle(context.Background(), client, []byte(test.command))
			var requestError *RequestError
			if !errors.As(err, &requestError) {
				t.Fatalf("Handle() error = %#v, want rejected request", err)
			}
			if requestError.SupportRef != uuid.Nil {
				t.Fatalf("malformed start support_ref = %s, want none", requestError.SupportRef)
			}
		})
	}
}

func TestHubV2DirectCallStartSupportRef(t *testing.T) {
	t.Run("successful start includes exact reference in call event", func(t *testing.T) {
		callerID, recipientID, conversationID := uuid.New(), uuid.New(), uuid.New()
		calls := &fakeCalls{}
		hub := NewHub(nil, authorizedPresence{recipientID: recipientID}, onlinePresence{}, nil, nil, calls, nil)
		caller := &recordingClient{identity: sharedauth.Identity{UserID: callerID, DeviceID: "caller"}}
		recipient := &recordingClient{identity: sharedauth.Identity{UserID: recipientID, DeviceID: "recipient"}}
		hub.Add(context.Background(), caller)
		hub.Add(context.Background(), recipient)
		caller.events, recipient.events = nil, nil

		err := hub.HandleVersion(context.Background(), caller, 3, []byte(`{"version":3,"type":"call.start","request_id":"v2-start","payload":{"conversation_id":"`+conversationID.String()+`"}}`))
		if err != nil {
			t.Fatalf("HandleVersion() error = %v", err)
		}
		if calls.started.SupportRef == uuid.Nil {
			t.Fatal("successful v2 direct call start has no support_ref")
		}
		var got struct {
			SupportRef uuid.UUID `json:"support_ref"`
		}
		if len(caller.events) != 1 || caller.events[0].(serverEvent).Type != "call.ringing" {
			t.Fatalf("caller events = %#v, want call.ringing", caller.events)
		}
		payload, err := json.Marshal(caller.events[0].(serverEvent).Payload)
		if err != nil {
			t.Fatalf("marshal call.ringing payload: %v", err)
		}
		if err := json.Unmarshal(payload, &got); err != nil || got.SupportRef != calls.started.SupportRef {
			t.Fatalf("call.ringing support_ref = %s, want exact generated ref %s (err=%v)", got.SupportRef, calls.started.SupportRef, err)
		}
	})

	t.Run("rejected start error includes exact reference", func(t *testing.T) {
		callerID, conversationID := uuid.New(), uuid.New()
		hub := NewHub(nil, authorizedPresence{recipientID: uuid.New()}, onlinePresence{}, nil, nil, nil, nil)
		client := &recordingClient{identity: sharedauth.Identity{UserID: callerID, DeviceID: "device"}, connectionID: "socket-v2"}
		err := hub.HandleVersion(context.Background(), client, 3, []byte(`{"version":3,"type":"call.start","request_id":"v2-rejected","payload":{"conversation_id":"`+conversationID.String()+`"}}`))
		var requestError *RequestError
		if !errors.As(err, &requestError) || requestError.SupportRef == uuid.Nil {
			t.Fatalf("rejected v2 start error = %#v, want support_ref", err)
		}
		encoded, marshalErr := json.Marshal(struct {
			SupportRef uuid.UUID `json:"support_ref"`
		}{SupportRef: requestError.SupportRef})
		if marshalErr != nil {
			t.Fatalf("marshal rejected start error payload: %v", marshalErr)
		}
		var payload map[string]uuid.UUID
		if err := json.Unmarshal(encoded, &payload); err != nil || payload["support_ref"] != requestError.SupportRef {
			t.Fatalf("rejected error support_ref = %s, want exact generated ref %s (err=%v)", payload["support_ref"], requestError.SupportRef, err)
		}
	})
}

func TestHubCallStartLogsAreJSONStructuredAndContainNoSignalMaterial(t *testing.T) {
	callerID, recipientID, conversationID := uuid.New(), uuid.New(), uuid.New()
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	hub := NewHubWithLogger(nil, authorizedPresence{recipientID: recipientID}, onlinePresence{}, nil, nil, &fakeCalls{}, nil, logger)
	client := &recordingClient{identity: sharedauth.Identity{UserID: callerID, DeviceID: "device"}, connectionID: "opaque-current-socket"}
	request := `{"version":3,"type":"call.start","request_id":"json-start","payload":{"conversation_id":"` + conversationID.String() + `"}}`
	if err := hub.Handle(context.Background(), client, []byte(request)); err != nil {
		t.Fatalf("start call: %v", err)
	}
	lines := bytes.Split(bytes.TrimSpace(logs.Bytes()), []byte("\n"))
	var entry map[string]any
	if len(lines) == 0 || json.Unmarshal(lines[len(lines)-1], &entry) != nil {
		t.Fatalf("call log is not JSON: %s", logs.String())
	}
	if entry["support_ref"] == nil || entry["request_id"] != "json-start" || entry["connection_id"] != "opaque-current-socket" || entry["outcome"] != "accepted" {
		t.Fatalf("call log missing bounded correlation fields: %#v", entry)
	}
	for _, secret := range []string{"sdp-secret", "candidate-secret", "turn-secret"} {
		if bytes.Contains(logs.Bytes(), []byte(secret)) {
			t.Fatalf("call log leaked sensitive material %q: %s", secret, logs.String())
		}
	}
}

func TestHubRemoveLogsRoomCleanupWithoutClaimingEventDelivery(t *testing.T) {
	for _, test := range []struct {
		name    string
		status  string
		outcome string
	}{
		{name: "active participant departure", status: GroupRoomActive, outcome: "participant_removed"},
		{name: "ended room", status: GroupRoomEnded, outcome: "room_ended"},
	} {
		t.Run(test.name, func(t *testing.T) {
			var logs bytes.Buffer
			logger := slog.New(slog.NewJSONHandler(&logs, nil))
			room := GroupRoom{ID: uuid.New(), ConversationID: uuid.New(), Status: test.status}
			coord := &removeLogCoordinator{room: room}
			hub := NewHubWithLogger(nil, nil, coord, nil, nil, nil, nil, logger)
			client := &recordingClient{identity: sharedauth.Identity{UserID: uuid.New(), DeviceID: "device"}, connectionID: "socket"}
			hub.Add(context.Background(), client)

			ctx, cancel := context.WithCancel(context.Background())
			cancel() // Cleanup succeeds, but notifyGroupRoom cannot acquire its lock.
			hub.Remove(ctx, client)

			var cleanup map[string]any
			for _, line := range bytes.Split(bytes.TrimSpace(logs.Bytes()), []byte("\n")) {
				var entry map[string]any
				if err := json.Unmarshal(line, &entry); err != nil {
					t.Fatalf("invalid structured log %q: %v", line, err)
				}
				if entry["msg"] == "group call room cleanup after websocket disconnect" {
					cleanup = entry
				}
			}
			if cleanup == nil {
				t.Fatalf("cleanup log missing: %s", logs.String())
			}
			if cleanup["room_status"] != test.status || cleanup["outcome"] != test.outcome {
				t.Fatalf("cleanup log = %#v, want room_status=%q outcome=%q", cleanup, test.status, test.outcome)
			}
			if _, claimsEvent := cleanup["event"]; claimsEvent || cleanup["outcome"] == "emitted" {
				t.Fatalf("cleanup log claims event delivery: %#v", cleanup)
			}
			if !strings.Contains(logs.String(), `"msg":"group call event delivery failed"`) {
				t.Fatalf("expected delivery failure to be reported separately: %s", logs.String())
			}
		})
	}
}

type removeLogCoordinator struct {
	GroupRoomCoordinator
	room      GroupRoom
	published []GroupRoomChange
}

func (*removeLogCoordinator) Connect(context.Context, uuid.UUID, string) (bool, error) {
	return false, nil
}
func (*removeLogCoordinator) Disconnect(context.Context, uuid.UUID, string) (bool, error) {
	return false, nil
}
func (*removeLogCoordinator) Online(context.Context, []uuid.UUID) (map[uuid.UUID]bool, error) {
	return nil, nil
}
func (*removeLogCoordinator) Publish(context.Context, uuid.UUID, bool) error { return nil }
func (c *removeLogCoordinator) RemoveGroupConnection(context.Context, uuid.UUID, string, string) ([]GroupRoom, error) {
	return []GroupRoom{c.room}, nil
}
func (c *removeLogCoordinator) PublishGroupRoom(_ context.Context, change GroupRoomChange) error {
	c.published = append(c.published, change)
	return nil
}

func TestHubRemoveDeliversTerminalGroupRoomAndPreservesParticipantLeft(t *testing.T) {
	for _, test := range []struct {
		name       string
		status     string
		changeType string
	}{
		{name: "final participant disconnect", status: GroupRoomEnded, changeType: "ended"},
		{name: "active participant departure", status: GroupRoomActive, changeType: "participant.left"},
	} {
		t.Run(test.name, func(t *testing.T) {
			userID, peerID := uuid.New(), uuid.New()
			room := GroupRoom{ID: uuid.New(), ConversationID: uuid.New(), Generation: 1, MembershipRevision: 1, Status: test.status, Participants: []GroupParticipant{
				{UserID: userID, DeviceID: "device", ConnectionID: "departing"},
				{UserID: peerID, DeviceID: "peer-device", ConnectionID: "peer-socket"},
			}}
			coord := &removeLogCoordinator{room: room}
			hub := NewHub(nil, nil, coord, nil, nil, nil, nil)
			departing := &recordingClient{identity: sharedauth.Identity{UserID: userID, DeviceID: "device"}, connectionID: "departing"}
			peer := &recordingClient{identity: sharedauth.Identity{UserID: peerID, DeviceID: "peer-device"}, connectionID: "peer-socket"}
			hub.Add(context.Background(), departing)
			hub.Add(context.Background(), peer)
			hub.Remove(context.Background(), departing)

			if len(coord.published) != 1 || coord.published[0].Type != test.changeType {
				t.Fatalf("published room changes = %#v, want type %q", coord.published, test.changeType)
			}
			if test.status == GroupRoomEnded {
				found := false
				for _, raw := range peer.events {
					if event, ok := raw.(serverEvent); ok && event.Type == "group.call.ended" {
						found = true
					}
				}
				if !found {
					t.Fatalf("final disconnect did not deliver group.call.ended: %#v", peer.events)
				}
			}
		})
	}
}

func TestHubQueuesCallerRingingBeforeRecipientIncoming(t *testing.T) {
	callerID := uuid.New()
	recipientID := uuid.New()
	conversationID := uuid.New()
	calls := &fakeCalls{}
	hub := NewHub(nil, authorizedPresence{recipientID: recipientID}, onlinePresence{}, nil, nil, calls, nil)
	var deliveryOrder []string
	caller := &orderedRecordingClient{recordingClient: recordingClient{identity: sharedauth.Identity{UserID: callerID, DeviceID: "caller-device"}}, delivered: &deliveryOrder, name: "caller"}
	recipient := &orderedRecordingClient{recordingClient: recordingClient{identity: sharedauth.Identity{UserID: recipientID, DeviceID: "recipient-device"}}, delivered: &deliveryOrder, name: "recipient"}
	hub.Add(context.Background(), caller)
	hub.Add(context.Background(), recipient)
	deliveryOrder = nil

	if err := hub.Handle(context.Background(), caller, []byte(`{"version":3,"type":"call.start","request_id":"call-1","payload":{"conversation_id":"`+conversationID.String()+`"}}`)); err != nil {
		t.Fatalf("Handle() error = %v", err)
	}
	if got, want := deliveryOrder, []string{"caller:call.ringing", "recipient:call.incoming"}; !equalStrings(got, want) {
		t.Fatalf("delivery order = %v, want %v", got, want)
	}
}

func TestHubRoutesSignalOnlyToAcceptedDevice(t *testing.T) {
	callerID := uuid.New()
	recipientID := uuid.New()
	call := Call{ID: uuid.New(), ConversationID: uuid.New(), CallerID: callerID, RecipientID: recipientID, CallerDeviceID: "caller-device", AcceptedDeviceID: "accepted-device", CallerConnectionID: "caller-connection", AcceptedConnectionID: "accepted-connection", Status: CallActive}
	calls := &fakeCalls{call: call}
	var logs bytes.Buffer
	hub := NewHubWithLogger(nil, authorizedPresence{recipientID: recipientID}, onlinePresence{}, nil, nil, calls, nil, slog.New(slog.NewJSONHandler(&logs, nil)))
	caller := &recordingClient{identity: sharedauth.Identity{UserID: callerID, DeviceID: call.CallerDeviceID}, connectionID: call.CallerConnectionID}
	callerOtherTab := &recordingClient{identity: sharedauth.Identity{UserID: callerID, DeviceID: call.CallerDeviceID}, connectionID: "other-caller-connection"}
	accepted := &recordingClient{identity: sharedauth.Identity{UserID: recipientID, DeviceID: call.AcceptedDeviceID}, connectionID: call.AcceptedConnectionID}
	acceptedOtherTab := &recordingClient{identity: sharedauth.Identity{UserID: recipientID, DeviceID: call.AcceptedDeviceID}, connectionID: "other-connection"}
	otherDevice := &recordingClient{identity: sharedauth.Identity{UserID: recipientID, DeviceID: "other-device"}}
	hub.Add(context.Background(), caller)
	hub.Add(context.Background(), callerOtherTab)
	hub.Add(context.Background(), accepted)
	hub.Add(context.Background(), acceptedOtherTab)
	hub.Add(context.Background(), otherDevice)
	caller.events = nil
	callerOtherTab.events = nil
	accepted.events = nil
	acceptedOtherTab.events = nil
	otherDevice.events = nil

	err := hub.Handle(context.Background(), caller, []byte(`{"version":3,"type":"call.signal","request_id":"signal-1","payload":{"call_id":"`+call.ID.String()+`","signal":{"type":"offer","sdp":"private"}}}`))
	if err != nil {
		t.Fatalf("Handle() error = %v", err)
	}
	if len(accepted.events) != 1 || accepted.events[0].(serverEvent).Type != "call.signal" {
		t.Fatalf("accepted events = %#v", accepted.events)
	}
	if len(acceptedOtherTab.events) != 0 {
		t.Fatalf("accepted other-tab events = %#v", acceptedOtherTab.events)
	}
	if len(otherDevice.events) != 0 {
		t.Fatalf("other device events = %#v", otherDevice.events)
	}
	if strings.Contains(logs.String(), "call command accepted") {
		t.Fatalf("successful call.signal emitted lifecycle log: %s", logs.String())
	}
	if err := hub.Handle(context.Background(), callerOtherTab, []byte(`{"version":3,"type":"call.signal","request_id":"signal-2","payload":{"call_id":"`+call.ID.String()+`","signal":{"type":"offer","sdp":"forbidden"}}}`)); !errors.Is(err, ErrCallNotAllowed) {
		t.Fatalf("other caller tab signal error = %v, want not allowed", err)
	}
}

func TestHubRejectsUnsupportedCallSignal(t *testing.T) {
	callerID := uuid.New()
	recipientID := uuid.New()
	call := Call{ID: uuid.New(), ConversationID: uuid.New(), CallerID: callerID, RecipientID: recipientID, CallerDeviceID: "caller-device", AcceptedDeviceID: "accepted-device", Status: CallActive}
	hub := NewHub(nil, authorizedPresence{recipientID: recipientID}, onlinePresence{}, nil, nil, &fakeCalls{call: call}, nil)
	caller := &recordingClient{identity: sharedauth.Identity{UserID: callerID, DeviceID: call.CallerDeviceID}}

	err := hub.Handle(context.Background(), caller, []byte(`{"version":3,"type":"call.signal","request_id":"signal-1","payload":{"call_id":"`+call.ID.String()+`","signal":{"type":"unknown"}}}`))
	if err == nil || !strings.Contains(err.Error(), "unsupported call signal") {
		t.Fatalf("Handle() error = %v", err)
	}
}

func TestHubValidatesExactDirectCallSignalShapes(t *testing.T) {
	for _, test := range []struct {
		name   string
		signal string
		valid  bool
	}{
		{name: "offer", signal: `{"type":"offer","sdp":"private"}`, valid: true},
		{name: "answer", signal: `{"type":"answer","sdp":"private"}`, valid: true},
		{name: "direct offer rejects negotiation ID", signal: `{"type":"offer","sdp":"private","negotiation_id":"8c72dd14-fafe-4e2d-9735-e09c37358bf1"}`},
		{name: "candidate", signal: `{"type":"candidate","candidate":{"candidate":"ice"}}`, valid: true},
		{name: "direct opaque candidate", signal: `{"type":"candidate","candidate":{}}`, valid: true},
		{name: "marker", signal: `{"type":"screen-share-started"}`, valid: true},
		{name: "marker with sdp", signal: `{"type":"screen-share-started","sdp":"private"}`},
		{name: "marker with candidate", signal: `{"type":"screen-share-stopped","candidate":{}}`},
		{name: "offer with unknown field", signal: `{"type":"offer","sdp":"private","extra":true}`},
		{name: "candidate with unknown field", signal: `{"type":"candidate","candidate":{},"extra":true}`},
		{name: "candidate not object", signal: `{"type":"candidate","candidate":[]}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			callID := uuid.New()
			hub := NewHub(nil, nil, nil, nil, nil, nil, nil)
			client := &recordingClient{}
			request := `{"version":3,"type":"call.signal","request_id":"signal-shape","payload":{"call_id":"` + callID.String() + `","signal":` + test.signal + `}}`
			err := hub.Handle(context.Background(), client, []byte(request))
			if test.valid {
				var requestError *RequestError
				if !errors.As(err, &requestError) || requestError.Error() != "call rate limit exceeded" {
					t.Fatalf("Handle() error = %v, want validation success followed by rate-limit rejection", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), "unsupported call signal") {
				t.Fatalf("Handle() error = %v, want invalid signal rejection", err)
			}
		})
	}
	if validCallSignal(json.RawMessage(`{"type":"screen-share-stopped"}{}`)) {
		t.Fatal("validCallSignal accepted trailing JSON")
	}
}

func TestHubLogsAcceptedCallDeclineWithActorAndCallContext(t *testing.T) {
	callerID := uuid.New()
	recipientID := uuid.New()
	call := Call{ID: uuid.New(), ConversationID: uuid.New(), CallerID: callerID, RecipientID: recipientID, CallerDeviceID: "caller-device", Status: CallRinging}
	calls := &fakeCalls{call: call}
	var logs bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelInfo}))
	hub := NewHubWithLogger(nil, authorizedPresence{recipientID: recipientID}, onlinePresence{}, nil, nil, calls, nil, logger)
	client := &recordingClient{identity: sharedauth.Identity{UserID: recipientID, DeviceID: "recipient-device"}}

	err := hub.Handle(context.Background(), client, []byte(`{"version":3,"type":"call.decline","request_id":"decline-1","payload":{"call_id":"`+call.ID.String()+`"}}`))
	if err != nil {
		t.Fatalf("Handle() error = %v", err)
	}
	for _, expected := range []string{"call command accepted", "command=call.decline", "request_id=decline-1", "actor_user_id=" + recipientID.String(), "actor_device_id=recipient-device", "call_id=" + call.ID.String()} {
		if !strings.Contains(logs.String(), expected) {
			t.Fatalf("logs do not contain %q: %s", expected, logs.String())
		}
	}
}

type rateLimitedCoordinator struct{}

type messageRateCoordinator struct{ err error }

func (messageRateCoordinator) Connect(context.Context, uuid.UUID, string) (bool, error) {
	return false, nil
}
func (messageRateCoordinator) Disconnect(context.Context, uuid.UUID, string) (bool, error) {
	return false, nil
}
func (messageRateCoordinator) Online(context.Context, []uuid.UUID) (map[uuid.UUID]bool, error) {
	return nil, nil
}
func (messageRateCoordinator) Publish(context.Context, uuid.UUID, bool) error { return nil }
func (c messageRateCoordinator) AllowMessage(context.Context, uuid.UUID) (bool, error) {
	return true, c.err
}

type reconciliationRateCoordinator struct {
	allowed bool
	err     error
}

type failingConversationCoordinator struct{ err error }
type contextCheckingConversationCoordinator struct{ failingConversationCoordinator }
type conversationContextKey struct{}

func (c contextCheckingConversationCoordinator) PublishConversation(ctx context.Context, _ uuid.UUID, _ []uuid.UUID) error {
	if ctx.Value(conversationContextKey{}) != "preserved" {
		return errors.New("caller context was not propagated")
	}
	return c.err
}

func (failingConversationCoordinator) Connect(context.Context, uuid.UUID, string) (bool, error) {
	return false, nil
}
func (failingConversationCoordinator) Disconnect(context.Context, uuid.UUID, string) (bool, error) {
	return false, nil
}
func (failingConversationCoordinator) Online(context.Context, []uuid.UUID) (map[uuid.UUID]bool, error) {
	return nil, nil
}
func (failingConversationCoordinator) Publish(context.Context, uuid.UUID, bool) error { return nil }
func (c failingConversationCoordinator) PublishConversation(context.Context, uuid.UUID, []uuid.UUID) error {
	return c.err
}

func (rateLimitedCoordinator) Connect(context.Context, uuid.UUID, string) (bool, error) {
	return false, nil
}
func (rateLimitedCoordinator) Disconnect(context.Context, uuid.UUID, string) (bool, error) {
	return false, nil
}
func (rateLimitedCoordinator) Online(context.Context, []uuid.UUID) (map[uuid.UUID]bool, error) {
	return nil, nil
}
func (rateLimitedCoordinator) Publish(context.Context, uuid.UUID, bool) error { return nil }
func (rateLimitedCoordinator) AllowMessage(context.Context, uuid.UUID) (bool, error) {
	return false, nil
}
func (rateLimitedCoordinator) AllowPresenceRefresh(context.Context, uuid.UUID) (bool, error) {
	return false, nil
}
func (rateLimitedCoordinator) AllowRead(context.Context, uuid.UUID) (bool, error) {
	return false, nil
}
func (rateLimitedCoordinator) AllowCall(context.Context, uuid.UUID) (bool, error) {
	return false, nil
}
func (rateLimitedCoordinator) AllowSignal(context.Context, uuid.UUID) (bool, error) {
	return false, nil
}
func (reconciliationRateCoordinator) Connect(context.Context, uuid.UUID, string) (bool, error) {
	return false, nil
}
func (reconciliationRateCoordinator) Disconnect(context.Context, uuid.UUID, string) (bool, error) {
	return false, nil
}
func (reconciliationRateCoordinator) Online(context.Context, []uuid.UUID) (map[uuid.UUID]bool, error) {
	return nil, nil
}
func (reconciliationRateCoordinator) Publish(context.Context, uuid.UUID, bool) error { return nil }
func (c reconciliationRateCoordinator) AllowReconciliation(context.Context, uuid.UUID) (bool, error) {
	return c.allowed, c.err
}

type recordingClient struct {
	identity     sharedauth.Identity
	connectionID string
	events       []any
	sendFailure  bool
	sendLimit    int
}

type orderedRecordingClient struct {
	recordingClient
	delivered *[]string
	name      string
}

func (c *orderedRecordingClient) SendJSON(value any) bool {
	if event, ok := value.(serverEvent); ok {
		*c.delivered = append(*c.delivered, c.name+":"+event.Type)
	}
	return c.recordingClient.SendJSON(value)
}

func equalStrings(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for index := range got {
		if got[index] != want[index] {
			return false
		}
	}
	return true
}

func (c *recordingClient) Identity() sharedauth.Identity { return c.identity }
func (c *recordingClient) ConnectionID() string          { return c.connectionID }
func (c *recordingClient) SendJSON(event any) bool {
	if c.sendFailure || (c.sendLimit > 0 && len(c.events) >= c.sendLimit) {
		return false
	}
	c.events = append(c.events, event)
	return true
}
func (*recordingClient) Close() {}

type fakeDelivery struct {
	pending          []messaging.Message
	markedDeviceID   uuid.UUID
	markedMessageIDs []uuid.UUID
}

func (f *fakeDelivery) Pending(context.Context, uuid.UUID, int) ([]messaging.Message, error) {
	return f.pending, nil
}
func (f *fakeDelivery) MarkDelivered(_ context.Context, deviceID uuid.UUID, messageIDs []uuid.UUID) error {
	f.markedDeviceID = deviceID
	f.markedMessageIDs = messageIDs
	return nil
}

type authorizedPresence struct{ recipientID uuid.UUID }

func (authorizedPresence) PeerIDs(context.Context, uuid.UUID) ([]uuid.UUID, error) { return nil, nil }
func (p authorizedPresence) RecipientID(context.Context, uuid.UUID, uuid.UUID) (uuid.UUID, error) {
	return p.recipientID, nil
}
func (p authorizedPresence) ResolveTypingRecipients(context.Context, uuid.UUID, uuid.UUID) ([]uuid.UUID, error) {
	return []uuid.UUID{p.recipientID}, nil
}

type readRecipientsPresence struct {
	recipients     []uuid.UUID
	err            error
	readerID       uuid.UUID
	conversationID uuid.UUID
}

func (*readRecipientsPresence) PeerIDs(context.Context, uuid.UUID) ([]uuid.UUID, error) {
	return nil, nil
}
func (*readRecipientsPresence) RecipientID(context.Context, uuid.UUID, uuid.UUID) (uuid.UUID, error) {
	return uuid.Nil, errors.New("direct-only resolver should not be called")
}
func (p *readRecipientsPresence) ResolveReadRecipients(_ context.Context, readerID, conversationID uuid.UUID) ([]uuid.UUID, error) {
	p.readerID, p.conversationID = readerID, conversationID
	return p.recipients, p.err
}
func (p authorizedPresence) ResolveReadRecipients(context.Context, uuid.UUID, uuid.UUID) ([]uuid.UUID, error) {
	return []uuid.UUID{p.recipientID}, nil
}

type peerPresence struct{ peerIDs []uuid.UUID }

func (p peerPresence) PeerIDs(context.Context, uuid.UUID) ([]uuid.UUID, error) { return p.peerIDs, nil }
func (peerPresence) RecipientID(context.Context, uuid.UUID, uuid.UUID) (uuid.UUID, error) {
	return uuid.Nil, nil
}

type recordingPresenceCoordinator struct {
	userID               uuid.UUID
	online               bool
	typingConversationID uuid.UUID
	typingUserID         uuid.UUID
	typingStarted        bool
}

type onlinePresence struct{}

func (onlinePresence) AcquireCallAdmission(context.Context, []uuid.UUID) (string, error) {
	return uuid.NewString(), nil
}
func (onlinePresence) ReleaseCallAdmission(context.Context, []uuid.UUID, string) {}

func (onlinePresence) Connect(context.Context, uuid.UUID, string) (bool, error) { return false, nil }
func (onlinePresence) Disconnect(context.Context, uuid.UUID, string) (bool, error) {
	return false, nil
}
func (onlinePresence) Online(_ context.Context, userIDs []uuid.UUID) (map[uuid.UUID]bool, error) {
	online := make(map[uuid.UUID]bool, len(userIDs))
	for _, userID := range userIDs {
		online[userID] = true
	}
	return online, nil
}
func (onlinePresence) Publish(context.Context, uuid.UUID, bool) error { return nil }
func (onlinePresence) AllowPresenceRefresh(context.Context, uuid.UUID) (bool, error) {
	return true, nil
}
func (onlinePresence) AllowRead(context.Context, uuid.UUID) (bool, error) { return true, nil }
func (onlinePresence) AllowCall(context.Context, uuid.UUID) (bool, error) { return true, nil }
func (onlinePresence) AllowSignal(context.Context, uuid.UUID) (bool, error) {
	return true, nil
}

type fakeCalls struct {
	call    Call
	started Call
	getErr  error
}

func (f *fakeCalls) Start(_ context.Context, call Call, _ string) (Call, error) {
	call.Status = CallRinging
	if call.ExpiresAt.IsZero() {
		call.ExpiresAt = time.Now().Add(30 * time.Second)
	}
	f.started = call
	f.call = call
	return call, nil
}
func (f *fakeCalls) Accept(context.Context, uuid.UUID, uuid.UUID, string, string) (Call, error) {
	return f.call, nil
}
func (f *fakeCalls) Decline(context.Context, uuid.UUID, uuid.UUID, string, string) (Call, error) {
	f.call.Status = CallEnded
	return f.call, nil
}
func (f *fakeCalls) Cancel(context.Context, uuid.UUID, uuid.UUID, string, string) (Call, error) {
	return f.call, nil
}
func (f *fakeCalls) End(context.Context, uuid.UUID, uuid.UUID, string, string) (Call, error) {
	return f.call, nil
}
func (f *fakeCalls) EndByDevice(context.Context, uuid.UUID, string, string) ([]Call, error) {
	return nil, nil
}
func (f *fakeCalls) Get(context.Context, uuid.UUID) (Call, error) { return f.call, f.getErr }
func (*fakeCalls) PublishCall(context.Context, CallChange) error  { return nil }

func (*recordingPresenceCoordinator) Connect(context.Context, uuid.UUID, string) (bool, error) {
	return false, nil
}
func (*recordingPresenceCoordinator) Disconnect(context.Context, uuid.UUID, string) (bool, error) {
	return false, nil
}
func (*recordingPresenceCoordinator) Online(context.Context, []uuid.UUID) (map[uuid.UUID]bool, error) {
	return nil, nil
}
func (c *recordingPresenceCoordinator) Publish(_ context.Context, userID uuid.UUID, online bool) error {
	c.userID = userID
	c.online = online
	return nil
}
func (*recordingPresenceCoordinator) AllowPresenceRefresh(context.Context, uuid.UUID) (bool, error) {
	return true, nil
}
func (*recordingPresenceCoordinator) AllowRead(context.Context, uuid.UUID) (bool, error) {
	return true, nil
}
func (*recordingPresenceCoordinator) AllowCall(context.Context, uuid.UUID) (bool, error) {
	return true, nil
}
func (*recordingPresenceCoordinator) AllowSignal(context.Context, uuid.UUID) (bool, error) {
	return true, nil
}
func (c *recordingPresenceCoordinator) PublishTyping(_ context.Context, conversationID, userID uuid.UUID, started bool) error {
	c.typingConversationID = conversationID
	c.typingUserID = userID
	c.typingStarted = started
	return nil
}
func (*recordingPresenceCoordinator) AllowTypingStart(context.Context, uuid.UUID, uuid.UUID) (bool, error) {
	return true, nil
}

type fakeReadCursors struct {
	userID              uuid.UUID
	conversationID      uuid.UUID
	requestedSequence   int64
	sequence            int64
	visibleFromSequence int64
	recipientIDs        []uuid.UUID
	err                 error
}

type fakeReconciler struct {
	result         Reconciliation
	err            error
	userID         uuid.UUID
	conversationID uuid.UUID
	afterSequence  int64
	limit          int
}

func (f *fakeReconciler) Reconcile(_ context.Context, userID, conversationID uuid.UUID, afterSequence int64, limit int) (Reconciliation, error) {
	f.userID = userID
	f.conversationID = conversationID
	f.afterSequence = afterSequence
	f.limit = limit
	return f.result, f.err
}

func (f *fakeReadCursors) Advance(_ context.Context, userID, conversationID uuid.UUID, sequence int64) (ReadAdvance, error) {
	f.userID = userID
	f.conversationID = conversationID
	f.requestedSequence = sequence
	return ReadAdvance{Cursor: ReadCursor{Sequence: f.sequence, VisibleFromSequence: f.visibleFromSequence}, RecipientIDs: f.recipientIDs}, f.err
}
