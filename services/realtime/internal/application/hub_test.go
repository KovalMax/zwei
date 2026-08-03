package application

import (
	"context"
	"errors"
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
	hub := NewHub(nil, nil, nil, nil, nil)
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
	hub := NewHub(nil, nil, nil, nil, nil)
	err := hub.Handle(context.Background(), testClient{}, []byte(`{"version":2,"type":"presence.refresh","request_id":"request-1"}`))

	var requestError *RequestError
	if !errors.As(err, &requestError) || requestError.Error() != "unsupported protocol version" {
		t.Fatalf("error = %v", err)
	}
}

func TestHubRejectsRateLimitedMessage(t *testing.T) {
	hub := NewHub(nil, nil, rateLimitedCoordinator{}, nil, nil)
	err := hub.Handle(context.Background(), testClient{}, []byte(`{"version":1,"type":"message.send","request_id":"request-1","payload":{}}`))

	var requestError *RequestError
	if !errors.As(err, &requestError) {
		t.Fatalf("expected RequestError, got %v", err)
	}
	if requestError.Error() != "message rate limit exceeded" {
		t.Fatalf("error = %q", requestError.Error())
	}
}

func TestHubReplaysAndMarksPendingMessagesOnConnection(t *testing.T) {
	deviceID := uuid.New()
	messageID := uuid.New()
	delivery := &fakeDelivery{pending: []messaging.Message{{ID: messageID, ConversationID: uuid.New(), SenderID: uuid.New(), Body: "offline message"}}}
	client := &recordingClient{identity: sharedauth.Identity{UserID: uuid.New(), DeviceID: deviceID.String()}}
	hub := NewHub(nil, nil, nil, delivery, nil)

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

func TestHubPublishesAuthorizedReadCursorToPeer(t *testing.T) {
	conversationID := uuid.New()
	readerID := uuid.New()
	peerID := uuid.New()
	deviceID := uuid.New()
	cursors := &fakeReadCursors{sequence: 5}
	hub := NewHub(nil, authorizedPresence{recipientID: peerID}, nil, nil, cursors)
	peer := &recordingClient{identity: sharedauth.Identity{UserID: peerID, DeviceID: uuid.NewString()}}
	hub.Add(context.Background(), peer)
	peer.events = nil

	err := hub.Handle(context.Background(), &recordingClient{identity: sharedauth.Identity{UserID: readerID, DeviceID: deviceID.String()}}, []byte(`{"version":1,"type":"conversation.read","payload":{"conversation_id":"`+conversationID.String()+`","sequence":9}}`))
	if err != nil {
		t.Fatalf("Handle() error = %v", err)
	}
	if cursors.deviceID != deviceID || cursors.userID != readerID || cursors.conversationID != conversationID || cursors.requestedSequence != 9 {
		t.Fatalf("cursor advance = %+v", cursors)
	}
	if len(peer.events) != 1 {
		t.Fatalf("peer events = %d, want 1", len(peer.events))
	}
	event, ok := peer.events[0].(serverEvent)
	if !ok || event.Version != ProtocolVersion || event.Type != "conversation.read" {
		t.Fatalf("read event = %#v", peer.events[0])
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

type fakeReadCursors struct {
	deviceID          uuid.UUID
	userID            uuid.UUID
	conversationID    uuid.UUID
	requestedSequence int64
	sequence          int64
}

func (f *fakeReadCursors) Advance(_ context.Context, deviceID, userID, conversationID uuid.UUID, sequence int64) (int64, error) {
	f.deviceID = deviceID
	f.userID = userID
	f.conversationID = conversationID
	f.requestedSequence = sequence
	return f.sequence, nil
}
