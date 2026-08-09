package application

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
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

type CallLogger interface {
	InfoContext(context.Context, string, ...any)
	WarnContext(context.Context, string, ...any)
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
	calls     CallCoordinator
	turn      TURNCredentialIssuer
	logger    CallLogger
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

func NewHub(sender *messaging.Sender, presence PresenceRepository, coord PresenceCoordinator, delivery DeliveryRepository, cursors ReadCursorRepository, calls CallCoordinator, turn TURNCredentialIssuer) *Hub {
	return NewHubWithLogger(sender, presence, coord, delivery, cursors, calls, turn, slog.Default())
}

func NewHubWithLogger(sender *messaging.Sender, presence PresenceRepository, coord PresenceCoordinator, delivery DeliveryRepository, cursors ReadCursorRepository, calls CallCoordinator, turn TURNCredentialIssuer, logger CallLogger) *Hub {
	if logger == nil {
		logger = slog.Default()
	}
	return &Hub{sender: sender, presence: presence, coord: coord, delivery: delivery, cursors: cursors, calls: calls, turn: turn, logger: logger, clients: make(map[string]Client), typingAt: make(map[string]time.Time), messageAt: make(map[string]time.Time)}
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
	if h.calls != nil {
		calls, err := h.calls.EndByDevice(ctx, client.Identity().UserID, client.Identity().DeviceID)
		if err == nil {
			for _, call := range calls {
				h.logCallLifecycle(ctx, "call ended after websocket disconnect", call, "user_id", client.Identity().UserID, "device_id", client.Identity().DeviceID)
				h.publishCall(ctx, CallChange{Type: "ended", Call: call})
			}
		} else {
			h.logCallWarning(ctx, "could not end calls after websocket disconnect", err, "user_id", client.Identity().UserID, "device_id", client.Identity().DeviceID)
		}
	}
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
	h.publishPresence(h.peerIDs(ctx, userID), userID, online)
	if h.coord != nil {
		_ = h.coord.Publish(ctx, userID, online)
	}
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
			ConversationID  uuid.UUID       `json:"conversation_id"`
			ClientMessageID string          `json:"client_message_id"`
			Body            string          `json:"body"`
			Sequence        int64           `json:"sequence"`
			CallID          uuid.UUID       `json:"call_id"`
			Signal          json.RawMessage `json:"signal"`
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
	if len(request.Payload.Signal) > 16*1024 {
		return &RequestError{RequestID: request.RequestID, Err: errors.New("call signal is too large")}
	}
	if len(request.Payload.Signal) > 0 && !json.Valid(request.Payload.Signal) {
		return &RequestError{RequestID: request.RequestID, Err: errors.New("invalid call signal")}
	}
	if request.Type == "call.start" || request.Type == "call.accept" || request.Type == "call.decline" || request.Type == "call.cancel" || request.Type == "call.end" || request.Type == "call.signal" {
		if request.RequestID == "" {
			return &RequestError{Err: errors.New("call request ID is required")}
		}
		if request.Type != "call.start" && request.Payload.CallID == uuid.Nil {
			return &RequestError{RequestID: request.RequestID, Err: errors.New("call is required")}
		}
		if request.Type == "call.signal" && (len(bytes.TrimSpace(request.Payload.Signal)) == 0 || bytes.TrimSpace(request.Payload.Signal)[0] != '{') {
			return &RequestError{RequestID: request.RequestID, Err: errors.New("signal must be an object")}
		}
		return h.handleCall(ctx, client, request.RequestID, request.Type, request.Payload.ConversationID, request.Payload.CallID, request.Payload.Signal)
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
		h.DeliverTyping(eventType, request.Payload.ConversationID, client.Identity().UserID, recipientID)
		if coordinator, ok := h.coord.(TypingCoordinator); ok {
			_ = coordinator.PublishTyping(ctx, request.Payload.ConversationID, client.Identity().UserID, request.Type == "typing.start")
		}
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

func (h *Hub) handleCall(ctx context.Context, client Client, requestID, eventType string, conversationID, callID uuid.UUID, signal json.RawMessage) error {
	if h.calls == nil || h.presence == nil || h.coord == nil {
		return &RequestError{RequestID: requestID, Err: ErrCallUnavailable}
	}
	identity := client.Identity()
	var (
		call Call
		err  error
	)
	switch eventType {
	case "call.start":
		if conversationID == uuid.Nil {
			return &RequestError{RequestID: requestID, Err: errors.New("conversation is required")}
		}
		recipientID, recipientErr := h.presence.RecipientID(ctx, identity.UserID, conversationID)
		if recipientErr != nil {
			return &RequestError{RequestID: requestID, Err: errors.New("conversation not found")}
		}
		online, onlineErr := h.coord.Online(ctx, []uuid.UUID{recipientID})
		if onlineErr != nil || !online[recipientID] {
			return &RequestError{RequestID: requestID, Err: errors.New("recipient is offline")}
		}
		call, err = h.calls.Start(ctx, Call{ID: uuid.New(), ConversationID: conversationID, CallerID: identity.UserID, RecipientID: recipientID, CallerDeviceID: identity.DeviceID})
		if err == nil {
			h.publishCall(ctx, CallChange{Type: "started", Call: call})
		}
	case "call.accept":
		call, err = h.calls.Accept(ctx, callID, identity.UserID, identity.DeviceID)
		if err == nil {
			h.publishCall(ctx, CallChange{Type: "accepted", Call: call})
		}
	case "call.decline":
		call, err = h.calls.Decline(ctx, callID, identity.UserID, identity.DeviceID)
		if err == nil {
			h.publishCall(ctx, CallChange{Type: "declined", Call: call})
		}
	case "call.cancel":
		call, err = h.calls.Cancel(ctx, callID, identity.UserID, identity.DeviceID)
		if err == nil {
			h.publishCall(ctx, CallChange{Type: "ended", Call: call})
		}
	case "call.end":
		call, err = h.calls.End(ctx, callID, identity.UserID, identity.DeviceID)
		if err == nil {
			h.publishCall(ctx, CallChange{Type: "ended", Call: call})
		}
	case "call.signal":
		if callID == uuid.Nil || len(signal) == 0 {
			return &RequestError{RequestID: requestID, Err: errors.New("call and signal are required")}
		}
		call, err = h.calls.Get(ctx, callID)
		if err == nil && call.Status != CallActive {
			err = ErrCallNotAllowed
		}
		if err == nil {
			var toDeviceID string
			switch {
			case identity.UserID == call.CallerID && identity.DeviceID == call.CallerDeviceID && call.AcceptedDeviceID != "":
				toDeviceID = call.AcceptedDeviceID
			case identity.UserID == call.RecipientID && identity.DeviceID == call.AcceptedDeviceID:
				toDeviceID = call.CallerDeviceID
			default:
				err = ErrCallNotAllowed
			}
			if err == nil {
				h.publishCall(ctx, CallChange{Type: "signal", Call: call, FromDeviceID: identity.DeviceID, ToDeviceID: toDeviceID, Signal: signal})
			}
		}
	default:
		return &RequestError{RequestID: requestID, Err: errors.New("unsupported event")}
	}
	if err != nil {
		if eventType != "call.signal" {
			h.logCallWarning(ctx, "call command rejected", err, "command", eventType, "request_id", requestID, "call_id", callID, "actor_user_id", identity.UserID, "actor_device_id", identity.DeviceID)
		}
		return &RequestError{RequestID: requestID, Err: err}
	}
	if eventType != "call.signal" {
		h.logCallLifecycle(ctx, "call command accepted", call, "command", eventType, "request_id", requestID, "actor_user_id", identity.UserID, "actor_device_id", identity.DeviceID)
	}
	return nil
}

func (h *Hub) publishCall(ctx context.Context, change CallChange) {
	if change.Type != "signal" {
		h.logCallLifecycle(ctx, "call event emitted", change.Call, "event", change.Type, "source", change.Source)
	}
	h.DeliverCall(change)
	if h.calls != nil {
		if err := h.calls.PublishCall(ctx, change); err != nil {
			h.logCallWarning(ctx, "call event fanout failed", err, "event", change.Type, "source", change.Source)
		}
	}
}

func (h *Hub) logCallLifecycle(ctx context.Context, message string, call Call, args ...any) {
	if h.logger == nil {
		return
	}
	fields := []any{"call_id", call.ID, "conversation_id", call.ConversationID, "caller_id", call.CallerID, "recipient_id", call.RecipientID, "status", call.Status}
	h.logger.InfoContext(ctx, message, append(fields, args...)...)
}

func (h *Hub) logCallWarning(ctx context.Context, message string, err error, args ...any) {
	if h.logger == nil {
		return
	}
	fields := append([]any{"reason", callErrorReason(err)}, args...)
	h.logger.WarnContext(ctx, message, fields...)
}

func callErrorReason(err error) string {
	switch {
	case errors.Is(err, ErrCallUnavailable):
		return "unavailable"
	case errors.Is(err, ErrCallBusy):
		return "busy"
	case errors.Is(err, ErrCallNotFound):
		return "not_found"
	case errors.Is(err, ErrCallNotAllowed):
		return "not_allowed"
	case errors.Is(err, ErrCallTaken):
		return "already_taken"
	default:
		return "internal"
	}
}

// DeliverCall fans an already-authorized call event only to participating devices.
func (h *Hub) DeliverCall(change CallChange) {
	send := func(userID uuid.UUID, deviceID, eventType string, payload any) {
		for _, recipient := range h.recipients(userID) {
			if recipient.Identity().DeviceID == deviceID {
				recipient.SendJSON(serverEvent{Version: ProtocolVersion, Type: eventType, Payload: payload})
			}
		}
	}
	call := change.Call
	switch change.Type {
	case "started":
		for _, recipient := range h.recipients(call.RecipientID) {
			recipient.SendJSON(serverEvent{Version: ProtocolVersion, Type: "call.incoming", Payload: call})
		}
		send(call.CallerID, call.CallerDeviceID, "call.ringing", call)
	case "accepted":
		send(call.CallerID, call.CallerDeviceID, "call.accepted", h.callAcceptedPayload(call, call.CallerID))
		send(call.RecipientID, call.AcceptedDeviceID, "call.accepted", h.callAcceptedPayload(call, call.RecipientID))
	case "declined":
		send(call.CallerID, call.CallerDeviceID, "call.declined", call)
		for _, recipient := range h.recipients(call.RecipientID) {
			recipient.SendJSON(serverEvent{Version: ProtocolVersion, Type: "call.declined", Payload: call})
		}
	case "ended":
		send(call.CallerID, call.CallerDeviceID, "call.ended", call)
		if call.AcceptedDeviceID != "" {
			send(call.RecipientID, call.AcceptedDeviceID, "call.ended", call)
			return
		}
		for _, recipient := range h.recipients(call.RecipientID) {
			recipient.SendJSON(serverEvent{Version: ProtocolVersion, Type: "call.ended", Payload: call})
		}
	case "signal":
		userID := call.CallerID
		if change.ToDeviceID == call.AcceptedDeviceID {
			userID = call.RecipientID
		}
		send(userID, change.ToDeviceID, "call.signal", struct {
			CallID uuid.UUID       `json:"call_id"`
			Signal json.RawMessage `json:"signal"`
		}{CallID: call.ID, Signal: change.Signal})
	}
}

func (h *Hub) callAcceptedPayload(call Call, userID uuid.UUID) any {
	if h.turn == nil {
		return call
	}
	server, err := h.turn.Issue(call, userID)
	if err != nil {
		return call
	}
	return struct {
		Call
		ICEServers []ICEServer `json:"ice_servers"`
	}{Call: call, ICEServers: []ICEServer{server}}
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
