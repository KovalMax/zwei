package application

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"

	"github.com/google/uuid"

	sharedauth "github.com/KovalMax/zwei/services/shared/auth"
	"github.com/KovalMax/zwei/services/shared/messaging"
)

type testClient struct{}

func (testClient) Identity() sharedauth.Identity { return sharedauth.Identity{} }
func (testClient) SendJSON(any)                  {}
func (testClient) Close()                        {}

func TestHubHandlePreservesRequestIDForRejectedCommand(t *testing.T) {
	hub := NewHub(nil, nil, nil, nil, nil, nil, nil)
	err := hub.Handle(context.Background(), testClient{}, []byte(`{"version":1,"type":"unsupported","request_id":"request-1"}`))

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
	err := hub.Handle(context.Background(), testClient{}, []byte(`{"version":2,"type":"presence.refresh","request_id":"request-1"}`))

	var requestError *RequestError
	if !errors.As(err, &requestError) || requestError.Error() != "unsupported protocol version" {
		t.Fatalf("error = %v", err)
	}
}

func TestHubRejectsRateLimitedMessage(t *testing.T) {
	hub := NewHub(nil, nil, rateLimitedCoordinator{}, nil, nil, nil, nil)
	err := hub.Handle(context.Background(), testClient{}, []byte(`{"version":1,"type":"message.send","request_id":"request-1","payload":{}}`))

	var requestError *RequestError
	if !errors.As(err, &requestError) {
		t.Fatalf("expected RequestError, got %v", err)
	}
	if requestError.Error() != "message rate limit exceeded" {
		t.Fatalf("error = %q", requestError.Error())
	}
}

func TestHubRejectsRateLimitedRealtimeCommands(t *testing.T) {
	tests := []struct {
		name    string
		payload string
		want    string
	}{
		{name: "presence refresh", payload: `{"version":1,"type":"presence.refresh"}`, want: "presence refresh rate limit exceeded"},
		{name: "read", payload: `{"version":1,"type":"conversation.read","request_id":"read-1","payload":{"sequence":1}}`, want: "read rate limit exceeded"},
		{name: "call", payload: `{"version":1,"type":"call.start","request_id":"call-1","payload":{}}`, want: "call rate limit exceeded"},
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

	err := hub.Handle(context.Background(), &recordingClient{identity: sharedauth.Identity{UserID: senderID, DeviceID: uuid.NewString()}}, []byte(`{"version":1,"type":"typing.start","payload":{"conversation_id":"`+conversationID.String()+`"}}`))

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

func TestHubPublishesAuthorizedReadCursorToPeer(t *testing.T) {
	conversationID := uuid.New()
	readerID := uuid.New()
	peerID := uuid.New()
	cursors := &fakeReadCursors{sequence: 5}
	hub := NewHub(nil, authorizedPresence{recipientID: peerID}, nil, nil, cursors, nil, nil)
	peer := &recordingClient{identity: sharedauth.Identity{UserID: peerID, DeviceID: uuid.NewString()}}
	reader := &recordingClient{identity: sharedauth.Identity{UserID: readerID, DeviceID: uuid.NewString()}}
	hub.Add(context.Background(), peer)
	hub.Add(context.Background(), reader)
	peer.events = nil
	reader.events = nil

	err := hub.Handle(context.Background(), reader, []byte(`{"version":1,"type":"conversation.read","payload":{"conversation_id":"`+conversationID.String()+`","sequence":9}}`))
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
		ConversationID uuid.UUID `json:"conversation_id"`
		UserID         uuid.UUID `json:"user_id"`
		Sequence       int64     `json:"sequence"`
	})
	if payload.UserID != readerID || payload.Sequence != 5 {
		t.Fatalf("read payload = %+v", payload)
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

	err := hub.Handle(context.Background(), caller, []byte(`{"version":1,"type":"call.start","request_id":"call-1","payload":{"conversation_id":"`+conversationID.String()+`"}}`))
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
}

func TestHubRoutesSignalOnlyToAcceptedDevice(t *testing.T) {
	callerID := uuid.New()
	recipientID := uuid.New()
	call := Call{ID: uuid.New(), ConversationID: uuid.New(), CallerID: callerID, RecipientID: recipientID, CallerDeviceID: "caller-device", AcceptedDeviceID: "accepted-device", Status: CallActive}
	calls := &fakeCalls{call: call}
	hub := NewHub(nil, authorizedPresence{recipientID: recipientID}, onlinePresence{}, nil, nil, calls, nil)
	caller := &recordingClient{identity: sharedauth.Identity{UserID: callerID, DeviceID: call.CallerDeviceID}}
	accepted := &recordingClient{identity: sharedauth.Identity{UserID: recipientID, DeviceID: call.AcceptedDeviceID}}
	otherDevice := &recordingClient{identity: sharedauth.Identity{UserID: recipientID, DeviceID: "other-device"}}
	hub.Add(context.Background(), caller)
	hub.Add(context.Background(), accepted)
	hub.Add(context.Background(), otherDevice)
	caller.events = nil
	accepted.events = nil
	otherDevice.events = nil

	err := hub.Handle(context.Background(), caller, []byte(`{"version":1,"type":"call.signal","request_id":"signal-1","payload":{"call_id":"`+call.ID.String()+`","signal":{"type":"offer","sdp":"private"}}}`))
	if err != nil {
		t.Fatalf("Handle() error = %v", err)
	}
	if len(accepted.events) != 1 || accepted.events[0].(serverEvent).Type != "call.signal" {
		t.Fatalf("accepted events = %#v", accepted.events)
	}
	if len(otherDevice.events) != 0 {
		t.Fatalf("other device events = %#v", otherDevice.events)
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

	err := hub.Handle(context.Background(), client, []byte(`{"version":1,"type":"call.decline","request_id":"decline-1","payload":{"call_id":"`+call.ID.String()+`"}}`))
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

type recordingClient struct {
	identity sharedauth.Identity
	events   []any
}

func (c *recordingClient) Identity() sharedauth.Identity { return c.identity }
func (c *recordingClient) SendJSON(event any)            { c.events = append(c.events, event) }
func (*recordingClient) Close()                          {}

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

type fakeCalls struct {
	call    Call
	started Call
}

func (f *fakeCalls) Start(_ context.Context, call Call) (Call, error) {
	call.Status = CallRinging
	f.started = call
	f.call = call
	return call, nil
}
func (f *fakeCalls) Accept(context.Context, uuid.UUID, uuid.UUID, string) (Call, error) {
	return f.call, nil
}
func (f *fakeCalls) Decline(context.Context, uuid.UUID, uuid.UUID, string) (Call, error) {
	f.call.Status = CallEnded
	return f.call, nil
}
func (f *fakeCalls) Cancel(context.Context, uuid.UUID, uuid.UUID, string) (Call, error) {
	return f.call, nil
}
func (f *fakeCalls) End(context.Context, uuid.UUID, uuid.UUID, string) (Call, error) {
	return f.call, nil
}
func (f *fakeCalls) EndByDevice(context.Context, uuid.UUID, string) ([]Call, error) { return nil, nil }
func (f *fakeCalls) Get(context.Context, uuid.UUID) (Call, error)                   { return f.call, nil }
func (*fakeCalls) PublishCall(context.Context, CallChange) error                    { return nil }

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
func (c *recordingPresenceCoordinator) PublishTyping(_ context.Context, conversationID, userID uuid.UUID, started bool) error {
	c.typingConversationID = conversationID
	c.typingUserID = userID
	c.typingStarted = started
	return nil
}

type fakeReadCursors struct {
	userID            uuid.UUID
	conversationID    uuid.UUID
	requestedSequence int64
	sequence          int64
}

func (f *fakeReadCursors) Advance(_ context.Context, userID, conversationID uuid.UUID, sequence int64) (int64, error) {
	f.userID = userID
	f.conversationID = conversationID
	f.requestedSequence = sequence
	return f.sequence, nil
}
