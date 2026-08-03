package application

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/google/uuid"

	sharedauth "github.com/KovalMax/zwei/services/shared/auth"
	"github.com/KovalMax/zwei/services/shared/messaging"
)

type Client interface {
	Identity() sharedauth.Identity
	SendJSON(any)
	Close()
}

const ProtocolVersion = 1

type PresenceRepository interface {
	PeerIDs(context.Context, uuid.UUID) ([]uuid.UUID, error)
	RecipientID(context.Context, uuid.UUID, uuid.UUID) (uuid.UUID, error)
}

type PresenceCoordinator interface {
	Connect(context.Context, uuid.UUID, string) (bool, error)
	Disconnect(context.Context, uuid.UUID, string) (bool, error)
	Online(context.Context, []uuid.UUID) (map[uuid.UUID]bool, error)
	Publish(context.Context, uuid.UUID, bool) error
}

type ConversationCoordinator interface {
	PublishConversation(context.Context, uuid.UUID, []uuid.UUID) error
}

type TypingCoordinator interface {
	PublishTyping(context.Context, uuid.UUID, uuid.UUID, bool) error
}

type MessageCoordinator interface {
	PublishMessage(context.Context, messaging.Message) error
}

type MessageRateCoordinator interface {
	AllowMessage(context.Context, uuid.UUID) (bool, error)
}

type TypingRateCoordinator interface {
	AllowTypingStart(context.Context, uuid.UUID, uuid.UUID) (bool, error)
}

type DeliveryRepository interface {
	Pending(context.Context, uuid.UUID, int) ([]messaging.Message, error)
	MarkDelivered(context.Context, uuid.UUID, []uuid.UUID) error
}

type ReadCursorRepository interface {
	Advance(context.Context, uuid.UUID, uuid.UUID, uuid.UUID, int64) (int64, error)
}

type Hub struct {
	sender    *messaging.Sender
	presence  PresenceRepository
	coord     PresenceCoordinator
	delivery  DeliveryRepository
	cursors   ReadCursorRepository
	mu        sync.RWMutex
	clients   map[string]Client
	typingMu  sync.Mutex
	typingAt  map[string]time.Time
	messageMu sync.Mutex
	messageAt map[string]time.Time
}

// RequestError preserves client correlation data when a command is rejected.
type RequestError struct {
	RequestID string
	Err       error
}

func (e *RequestError) Error() string { return e.Err.Error() }
func (e *RequestError) Unwrap() error { return e.Err }

func NewHub(sender *messaging.Sender, presence PresenceRepository, coord PresenceCoordinator, delivery DeliveryRepository, cursors ReadCursorRepository) *Hub {
	return &Hub{sender: sender, presence: presence, coord: coord, delivery: delivery, cursors: cursors, clients: make(map[string]Client), typingAt: make(map[string]time.Time), messageAt: make(map[string]time.Time)}
}

func (h *Hub) Add(ctx context.Context, client Client) {
	h.mu.Lock()
	wasOnline := h.userOnlineLocked(client.Identity().UserID)
	h.clients[key(client.Identity())] = client
	h.mu.Unlock()
	if h.coord != nil {
		becameOnline, err := h.coord.Connect(ctx, client.Identity().UserID, key(client.Identity()))
		if err == nil {
			wasOnline = !becameOnline
		}
	}

	h.sendPresenceSnapshot(ctx, client)
	h.replayPending(ctx, client)
	if !wasOnline {
		h.publishPresenceChange(ctx, client.Identity().UserID, true)
	}
}

func (h *Hub) sendPresenceSnapshot(ctx context.Context, client Client) {
	peers := h.peerIDs(ctx, client.Identity().UserID)
	if h.coord != nil {
		online, err := h.coord.Online(ctx, peers)
		if err == nil {
			h.sendPresenceSnapshotForPeers(client, peers, online)
			return
		}
	}
	h.mu.RLock()
	online := h.onlineUsersLocked()
	h.mu.RUnlock()
	h.sendPresenceSnapshotForPeers(client, peers, online)
}

func (h *Hub) sendPresenceSnapshotForPeers(client Client, peers []uuid.UUID, online map[uuid.UUID]bool) {
	visible := make([]uuid.UUID, 0, len(peers))
	for _, peerID := range peers {
		if online[peerID] {
			visible = append(visible, peerID)
		}
	}
	client.SendJSON(serverEvent{Version: ProtocolVersion, Type: "presence.snapshot", Payload: struct {
		UserIDs []uuid.UUID `json:"user_ids"`
	}{UserIDs: visible}})
}
func (h *Hub) Remove(ctx context.Context, client Client) {
	h.mu.Lock()
	if h.clients[key(client.Identity())] != client {
		h.mu.Unlock()
		return
	}
	delete(h.clients, key(client.Identity()))
	isOnline := h.userOnlineLocked(client.Identity().UserID)
	h.mu.Unlock()
	if !isOnline {
		if h.coord != nil {
			becameOffline, err := h.coord.Disconnect(ctx, client.Identity().UserID, key(client.Identity()))
			if err == nil && !becameOffline {
				return
			}
		}
		h.publishPresenceChange(ctx, client.Identity().UserID, false)
	}
}

func (h *Hub) peerIDs(ctx context.Context, userID uuid.UUID) []uuid.UUID {
	if h.presence == nil {
		return nil
	}
	peers, err := h.presence.PeerIDs(ctx, userID)
	if err != nil {
		return nil
	}
	return peers
}

func (h *Hub) publishPresence(peers []uuid.UUID, userID uuid.UUID, online bool) {
	for _, peerID := range peers {
		for _, recipient := range h.recipients(peerID) {
			recipient.SendJSON(serverEvent{Version: ProtocolVersion, Type: "presence.changed", Payload: struct {
				UserID uuid.UUID `json:"user_id"`
				Online bool      `json:"online"`
			}{UserID: userID, Online: online}})
		}
	}
}

func (h *Hub) publishPresenceChange(ctx context.Context, userID uuid.UUID, online bool) {
	if h.coord != nil && h.coord.Publish(ctx, userID, online) == nil {
		return
	}
	h.publishPresence(h.peerIDs(ctx, userID), userID, online)
}

func (h *Hub) NotifyPresenceChanged(ctx context.Context, userID uuid.UUID, online bool) {
	h.publishPresence(h.peerIDs(ctx, userID), userID, online)
}

func (h *Hub) NotifyConversationCreated(conversationID uuid.UUID, userIDs []uuid.UUID) {
	if coordinator, ok := h.coord.(ConversationCoordinator); ok && coordinator.PublishConversation(context.Background(), conversationID, userIDs) == nil {
		return
	}
	h.DeliverConversationCreated(conversationID, userIDs)
}

func (h *Hub) DeliverConversationCreated(conversationID uuid.UUID, userIDs []uuid.UUID) {
	for _, userID := range userIDs {
		for _, recipient := range h.recipients(userID) {
			recipient.SendJSON(serverEvent{Version: ProtocolVersion, Type: "conversation.created", Payload: struct {
				ConversationID uuid.UUID `json:"conversation_id"`
			}{ConversationID: conversationID}})
		}
	}
}

func (h *Hub) Handle(ctx context.Context, client Client, payload []byte) error {
	var request struct {
		Version   int    `json:"version"`
		Type      string `json:"type"`
		RequestID string `json:"request_id,omitempty"`
		Payload   struct {
			ConversationID  uuid.UUID `json:"conversation_id"`
			ClientMessageID string    `json:"client_message_id"`
			Body            string    `json:"body"`
			Sequence        int64     `json:"sequence"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(payload, &request); err != nil {
		return &RequestError{Err: errors.New("unsupported event")}
	}
	if request.Version != ProtocolVersion {
		return &RequestError{RequestID: request.RequestID, Err: errors.New("unsupported protocol version")}
	}
	if request.Type == "presence.refresh" {
		h.sendPresenceSnapshot(ctx, client)
		return nil
	}
	if request.Type == "conversation.read" {
		if h.cursors == nil || h.presence == nil || request.Payload.Sequence < 1 {
			return &RequestError{RequestID: request.RequestID, Err: errors.New("read cursor unavailable")}
		}
		deviceID, err := uuid.Parse(client.Identity().DeviceID)
		if err != nil {
			return &RequestError{RequestID: request.RequestID, Err: errors.New("read cursor unavailable")}
		}
		recipientID, err := h.presence.RecipientID(ctx, client.Identity().UserID, request.Payload.ConversationID)
		if err != nil {
			return &RequestError{RequestID: request.RequestID, Err: errors.New("conversation not found")}
		}
		sequence, err := h.cursors.Advance(ctx, deviceID, client.Identity().UserID, request.Payload.ConversationID, request.Payload.Sequence)
		if err != nil {
			return &RequestError{RequestID: request.RequestID, Err: errors.New("could not update read cursor")}
		}
		h.DeliverReadCursor(recipientID, request.Payload.ConversationID, sequence)
		return nil
	}
	if request.Type == "typing.start" || request.Type == "typing.stop" {
		if h.presence == nil {
			return &RequestError{RequestID: request.RequestID, Err: errors.New("typing unavailable")}
		}
		recipientID, err := h.presence.RecipientID(ctx, client.Identity().UserID, request.Payload.ConversationID)
		if err != nil {
			return &RequestError{RequestID: request.RequestID, Err: errors.New("conversation not found")}
		}
		if request.Type == "typing.start" {
			if limiter, ok := h.coord.(TypingRateCoordinator); ok {
				allowed, err := limiter.AllowTypingStart(ctx, client.Identity().UserID, request.Payload.ConversationID)
				if err != nil || !allowed {
					return nil
				}
			} else if !h.allowTypingStart(client.Identity().UserID, request.Payload.ConversationID) {
				return nil
			}
		}
		eventType := "typing.started"
		if request.Type == "typing.stop" {
			eventType = "typing.stopped"
		}
		if coordinator, ok := h.coord.(TypingCoordinator); ok && coordinator.PublishTyping(ctx, request.Payload.ConversationID, client.Identity().UserID, request.Type == "typing.start") == nil {
			return nil
		}
		h.DeliverTyping(eventType, request.Payload.ConversationID, client.Identity().UserID, recipientID)
		return nil
	}
	if request.Type != "message.send" {
		return &RequestError{RequestID: request.RequestID, Err: errors.New("unsupported event")}
	}
	if limiter, ok := h.coord.(MessageRateCoordinator); ok {
		allowed, err := limiter.AllowMessage(ctx, client.Identity().UserID)
		if err != nil || !allowed {
			return &RequestError{RequestID: request.RequestID, Err: errors.New("message rate limit exceeded")}
		}
	} else if !h.allowMessage(client.Identity()) {
		return &RequestError{RequestID: request.RequestID, Err: errors.New("message rate limit exceeded")}
	}
	message, created, err := h.sender.Send(ctx, messaging.SendRequest{SenderID: client.Identity().UserID, ConversationID: request.Payload.ConversationID, ClientMessageID: request.Payload.ClientMessageID, Body: request.Payload.Body})
	if err != nil {
		return &RequestError{RequestID: request.RequestID, Err: err}
	}
	client.SendJSON(serverEvent{Version: ProtocolVersion, Type: "message.accepted", RequestID: request.RequestID, Payload: message})
	if created {
		if coordinator, ok := h.coord.(MessageCoordinator); ok && coordinator.PublishMessage(ctx, message) == nil {
			return nil
		}
		h.DeliverMessageCreated(message)
	}
	return nil
}

func (h *Hub) DeliverMessageCreated(message messaging.Message) {
	for _, recipient := range h.recipients(message.RecipientID) {
		recipient.SendJSON(serverEvent{Version: ProtocolVersion, Type: "message.created", Payload: message})
		_ = h.markDelivered(context.Background(), recipient, []uuid.UUID{message.ID})
	}
}

func (h *Hub) DeliverReadCursor(recipientID, conversationID uuid.UUID, sequence int64) {
	for _, recipient := range h.recipients(recipientID) {
		recipient.SendJSON(serverEvent{Version: ProtocolVersion, Type: "conversation.read", Payload: struct {
			ConversationID uuid.UUID `json:"conversation_id"`
			Sequence       int64     `json:"sequence"`
		}{ConversationID: conversationID, Sequence: sequence}})
	}
}

func (h *Hub) replayPending(ctx context.Context, client Client) {
	if h.delivery == nil {
		return
	}
	deviceID, err := uuid.Parse(client.Identity().DeviceID)
	if err != nil {
		return
	}
	for {
		messages, err := h.delivery.Pending(ctx, deviceID, 100)
		if err != nil || len(messages) == 0 {
			return
		}
		messageIDs := make([]uuid.UUID, 0, len(messages))
		for _, message := range messages {
			client.SendJSON(serverEvent{Version: ProtocolVersion, Type: "message.created", Payload: message})
			messageIDs = append(messageIDs, message.ID)
		}
		if h.markDelivered(ctx, client, messageIDs) != nil || len(messages) < 100 {
			return
		}
	}
}

func (h *Hub) markDelivered(ctx context.Context, client Client, messageIDs []uuid.UUID) error {
	if h.delivery == nil {
		return nil
	}
	deviceID, err := uuid.Parse(client.Identity().DeviceID)
	if err != nil {
		return err
	}
	return h.delivery.MarkDelivered(ctx, deviceID, messageIDs)
}

func (h *Hub) allowTypingStart(userID, conversationID uuid.UUID) bool {
	key := userID.String() + ":" + conversationID.String()
	h.typingMu.Lock()
	defer h.typingMu.Unlock()
	now := time.Now()
	if last, ok := h.typingAt[key]; ok && now.Sub(last) < 500*time.Millisecond {
		return false
	}
	h.typingAt[key] = now
	return true
}

func (h *Hub) allowMessage(identity sharedauth.Identity) bool {
	h.messageMu.Lock()
	defer h.messageMu.Unlock()
	key := key(identity)
	now := time.Now()
	if last, ok := h.messageAt[key]; ok && now.Sub(last) < 200*time.Millisecond {
		return false
	}
	h.messageAt[key] = now
	return true
}

func (h *Hub) DeliverTyping(eventType string, conversationID, userID, recipientID uuid.UUID) {
	for _, recipient := range h.recipients(recipientID) {
		recipient.SendJSON(serverEvent{Version: ProtocolVersion, Type: eventType, Payload: struct {
			ConversationID uuid.UUID `json:"conversation_id"`
			UserID         uuid.UUID `json:"user_id"`
		}{ConversationID: conversationID, UserID: userID}})
	}
}

type serverEvent struct {
	Version   int    `json:"version"`
	Type      string `json:"type"`
	RequestID string `json:"request_id,omitempty"`
	Payload   any    `json:"payload,omitempty"`
}

func (h *Hub) recipients(userID uuid.UUID) []Client {
	h.mu.RLock()
	defer h.mu.RUnlock()
	recipients := make([]Client, 0)
	for _, client := range h.clients {
		if client.Identity().UserID == userID {
			recipients = append(recipients, client)
		}
	}
	return recipients
}
func key(identity sharedauth.Identity) string {
	return identity.UserID.String() + ":" + identity.DeviceID
}

func (h *Hub) userOnlineLocked(userID uuid.UUID) bool {
	for _, client := range h.clients {
		if client.Identity().UserID == userID {
			return true
		}
	}
	return false
}

func (h *Hub) onlineUsersLocked() map[uuid.UUID]bool {
	users := make(map[uuid.UUID]bool)
	for _, client := range h.clients {
		users[client.Identity().UserID] = true
	}
	return users
}
