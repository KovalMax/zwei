package application

import (
	"bytes"
	"context"
	"encoding/json"
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
func (testClient) SendJSON(any) bool             { return true }
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

func TestHubReconcilesBoundedAuthorizedV2Conversation(t *testing.T) {
	userID := uuid.New()
	conversationID := uuid.New()
	reconciler := &fakeReconciler{result: Reconciliation{Messages: []messaging.Message{{ID: uuid.New(), Sequence: 5}}, NextAfterSequence: 5, HighWatermark: 8, HasMore: true, OwnReadSequence: 4, PeerReadSequence: 3}}
	client := &recordingClient{identity: sharedauth.Identity{UserID: userID, DeviceID: uuid.NewString()}}
	hub := NewHubWithReconciliationAndLogger(nil, nil, reconciliationRateCoordinator{allowed: true}, nil, nil, reconciler, nil, nil, slog.Default())

	err := hub.HandleVersion(context.Background(), client, 2, []byte(`{"version":2,"type":"conversation.reconcile","request_id":"reconcile-1","payload":{"conversation_id":"`+conversationID.String()+`","after_sequence":4}}`))

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
	if !ok || event.Version != 2 || event.Type != "conversation.reconciled" || event.RequestID != "reconcile-1" {
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

	err := hub.HandleVersion(context.Background(), client, 2, []byte(`{"version":2,"type":"conversation.reconcile","request_id":"reconcile-1","payload":{"conversation_id":"`+conversationID.String()+`","after_sequence":0}}`))
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

	if err == nil || err.Error() != "unsupported event" {
		t.Fatalf("error = %v, want unsupported event", err)
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
			err := hub.HandleVersion(context.Background(), &recordingClient{identity: sharedauth.Identity{UserID: uuid.New()}}, 2, []byte(`{"version":2,"type":"conversation.reconcile","request_id":"reconcile-1","payload":{"conversation_id":"`+uuid.NewString()+`","after_sequence":0}}`))

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

	request := []byte(`{"version":1,"type":"typing.stop","payload":{"conversation_id":"` + conversationID.String() + `"}}`)
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
	hub := NewHub(nil, presence, nil, nil, cursors, nil, nil)
	reader := &recordingClient{identity: sharedauth.Identity{UserID: readerID, DeviceID: "reader"}}
	firstPeer := &recordingClient{identity: sharedauth.Identity{UserID: firstPeerID, DeviceID: "first"}}
	secondPeer := &recordingClient{identity: sharedauth.Identity{UserID: secondPeerID, DeviceID: "second"}}
	for _, client := range []*recordingClient{reader, firstPeer, secondPeer} {
		hub.Add(context.Background(), client)
		client.events = nil
	}
	request := []byte(`{"version":1,"type":"conversation.read","payload":{"conversation_id":"` + conversationID.String() + `","sequence":8}}`)
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

	if err := hub.Handle(context.Background(), caller, []byte(`{"version":1,"type":"call.start","request_id":"call-1","payload":{"conversation_id":"`+conversationID.String()+`"}}`)); err != nil {
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
	hub := NewHub(nil, authorizedPresence{recipientID: recipientID}, onlinePresence{}, nil, nil, calls, nil)
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

	err := hub.Handle(context.Background(), caller, []byte(`{"version":1,"type":"call.signal","request_id":"signal-1","payload":{"call_id":"`+call.ID.String()+`","signal":{"type":"offer","sdp":"private"}}}`))
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
	if err := hub.Handle(context.Background(), callerOtherTab, []byte(`{"version":1,"type":"call.signal","request_id":"signal-2","payload":{"call_id":"`+call.ID.String()+`","signal":{"type":"offer","sdp":"forbidden"}}}`)); !errors.Is(err, ErrCallNotAllowed) {
		t.Fatalf("other caller tab signal error = %v, want not allowed", err)
	}
}

func TestHubRejectsUnsupportedCallSignal(t *testing.T) {
	callerID := uuid.New()
	recipientID := uuid.New()
	call := Call{ID: uuid.New(), ConversationID: uuid.New(), CallerID: callerID, RecipientID: recipientID, CallerDeviceID: "caller-device", AcceptedDeviceID: "accepted-device", Status: CallActive}
	hub := NewHub(nil, authorizedPresence{recipientID: recipientID}, onlinePresence{}, nil, nil, &fakeCalls{call: call}, nil)
	caller := &recordingClient{identity: sharedauth.Identity{UserID: callerID, DeviceID: call.CallerDeviceID}}

	err := hub.Handle(context.Background(), caller, []byte(`{"version":1,"type":"call.signal","request_id":"signal-1","payload":{"call_id":"`+call.ID.String()+`","signal":{"type":"unknown"}}}`))
	if err == nil || !strings.Contains(err.Error(), "unsupported call signal") {
		t.Fatalf("Handle() error = %v", err)
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

type fakeCalls struct {
	call    Call
	started Call
}

func (f *fakeCalls) Start(_ context.Context, call Call, _ string) (Call, error) {
	call.Status = CallRinging
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
func (f *fakeCalls) Get(context.Context, uuid.UUID) (Call, error) { return f.call, nil }
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
