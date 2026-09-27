package application

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	sharedauth "github.com/KovalMax/zwei/services/shared/auth"
	"github.com/KovalMax/zwei/services/shared/messaging"
)

type Client interface {
	Identity() sharedauth.Identity
	// SendJSON reports whether the event was accepted by the socket's send queue.
	// Delivery state must not advance when the queue rejects an event.
	SendJSON(any) bool
	Close()
}

type connectionIdentified interface {
	ConnectionID() string
}

type protocolIdentified interface {
	ProtocolVersion() int
}

type CallLogger interface {
	InfoContext(context.Context, string, ...any)
	WarnContext(context.Context, string, ...any)
}

const (
	ProtocolVersion            = 1
	ReconciliationMessageLimit = 100
	groupCallOperationTimeout  = 5 * time.Second
	groupCallStartTimeout      = 3 * time.Second
)

type PresenceRepository interface {
	PeerIDs(context.Context, uuid.UUID) ([]uuid.UUID, error)
	RecipientID(context.Context, uuid.UUID, uuid.UUID) (uuid.UUID, error)
}

// TypingRecipientResolver authorizes a conversation participant and returns
// only the other active members eligible for ephemeral typing events.
type TypingRecipientResolver interface {
	ResolveTypingRecipients(context.Context, uuid.UUID, uuid.UUID) ([]uuid.UUID, error)
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

// GroupProjectionCoordinator publishes an authorized projection invalidation.
// The client must refetch the projection; group details never travel in pub/sub.
type GroupProjectionCoordinator interface {
	PublishGroupProjection(context.Context, uuid.UUID, int64, bool, []uuid.UUID) error
}

type TypingCoordinator interface {
	PublishTyping(context.Context, uuid.UUID, uuid.UUID, bool) error
}

type MessageCoordinator interface {
	PublishMessage(context.Context, messaging.Message) error
}

type ReadCoordinator interface {
	PublishRead(context.Context, uuid.UUID, []uuid.UUID, uuid.UUID, int64, int64) error
}

// ReadRecipientResolver authorizes a reader and returns every peer eligible
// to receive that conversation's read cursor event.
type MessageRateCoordinator interface {
	AllowMessage(context.Context, uuid.UUID) (bool, error)
}

type TypingRateCoordinator interface {
	AllowTypingStart(context.Context, uuid.UUID, uuid.UUID) (bool, error)
}

type RealtimeRateCoordinator interface {
	AllowPresenceRefresh(context.Context, uuid.UUID) (bool, error)
	AllowRead(context.Context, uuid.UUID) (bool, error)
	AllowCall(context.Context, uuid.UUID) (bool, error)
	AllowSignal(context.Context, uuid.UUID) (bool, error)
}

// ReconciliationRateCoordinator admits bounded v2 recovery reads across replicas.
type ReconciliationRateCoordinator interface {
	AllowReconciliation(context.Context, uuid.UUID) (bool, error)
}

type ConnectionBudget interface {
	AllowConnection(context.Context, uuid.UUID, string) (bool, error)
	ReleaseConnection(context.Context, uuid.UUID, string) error
}

type DeliveryRepository interface {
	Pending(context.Context, uuid.UUID, int) ([]messaging.Message, error)
	MarkDelivered(context.Context, uuid.UUID, []uuid.UUID) error
}

type ReadCursorRepository interface {
	Advance(context.Context, uuid.UUID, uuid.UUID, int64) (ReadAdvance, error)
}

// ReadCursor is the persisted, membership-scoped cursor returned after an authorized update.
type ReadCursor struct {
	Sequence            int64
	VisibleFromSequence int64
}

// ReadAdvance couples the cursor mutation to the peer set authorized at its
// database linearization point.
type ReadAdvance struct {
	Cursor       ReadCursor
	RecipientIDs []uuid.UUID
}

// ReconciliationRepository reads the bounded durable state a reconnecting client needs.
type ReconciliationRepository interface {
	Reconcile(context.Context, uuid.UUID, uuid.UUID, int64, int) (Reconciliation, error)
}

type Reconciliation struct {
	ConversationID    uuid.UUID           `json:"conversation_id"`
	Messages          []messaging.Message `json:"messages"`
	NextAfterSequence int64               `json:"next_after_sequence"`
	HighWatermark     int64               `json:"high_watermark"`
	HasMore           bool                `json:"has_more"`
	OwnReadSequence   int64               `json:"own_read_sequence"`
	PeerReadSequence  int64               `json:"peer_read_sequence"`
	PeerReadCursors   []PeerReadCursor    `json:"peer_read_cursors,omitempty"`
}

// PeerReadCursor is an active other member's account-level conversation cursor.
type PeerReadCursor struct {
	UserID              uuid.UUID `json:"user_id"`
	Sequence            int64     `json:"sequence"`
	VisibleFromSequence int64     `json:"visible_from_sequence"`
}

type Hub struct {
	sender           *messaging.Sender
	presence         PresenceRepository
	typingRecipients TypingRecipientResolver
	groupCallAuth    GroupCallAuthorizer
	coord            PresenceCoordinator
	delivery         DeliveryRepository
	cursors          ReadCursorRepository
	reconcile        ReconciliationRepository
	calls            CallCoordinator
	turn             TURNCredentialIssuer
	logger           CallLogger
	mu               sync.RWMutex
	clients          map[string]Client
	messageMu        sync.Mutex
	messageAt        map[string]time.Time
	groupOrder       [64]chan struct{}
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
	return NewHubWithReconciliationAndLogger(sender, presence, coord, delivery, cursors, nil, calls, turn, logger)
}

func NewHubWithReconciliationAndLogger(sender *messaging.Sender, presence PresenceRepository, coord PresenceCoordinator, delivery DeliveryRepository, cursors ReadCursorRepository, reconcile ReconciliationRepository, calls CallCoordinator, turn TURNCredentialIssuer, logger CallLogger) *Hub {
	var authorizer GroupCallAuthorizer
	if candidate, ok := presence.(GroupCallAuthorizer); ok {
		authorizer = candidate
	}
	return NewHubWithGroupCallAuthorizer(sender, presence, authorizer, coord, delivery, cursors, reconcile, calls, turn, logger)
}

// NewHubWithGroupCallAuthorizer wires the membership lease separately from
// presence queries so the composition root makes the authorization capability explicit.
func NewHubWithGroupCallAuthorizer(sender *messaging.Sender, presence PresenceRepository, authorizer GroupCallAuthorizer, coord PresenceCoordinator, delivery DeliveryRepository, cursors ReadCursorRepository, reconcile ReconciliationRepository, calls CallCoordinator, turn TURNCredentialIssuer, logger CallLogger) *Hub {
	if logger == nil {
		logger = slog.Default()
	}
	var typingRecipients TypingRecipientResolver
	if resolver, ok := presence.(TypingRecipientResolver); ok {
		typingRecipients = resolver
	}
	hub := &Hub{sender: sender, presence: presence, typingRecipients: typingRecipients, groupCallAuth: authorizer, coord: coord, delivery: delivery, cursors: cursors, reconcile: reconcile, calls: calls, turn: turn, logger: logger, clients: make(map[string]Client), messageAt: make(map[string]time.Time)}
	for index := range hub.groupOrder {
		hub.groupOrder[index] = make(chan struct{}, 1)
	}
	return hub
}

func (h *Hub) Add(ctx context.Context, client Client) {
	clientKey := clientConnectionID(client)
	h.mu.Lock()
	wasOnline := h.userOnlineLocked(client.Identity().UserID)
	h.clients[clientKey] = client
	h.mu.Unlock()
	if h.coord != nil {
		becameOnline, err := h.coord.Connect(ctx, client.Identity().UserID, presenceConnectionID(client))
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
	clientKey := clientConnectionID(client)
	h.mu.Lock()
	if h.clients[clientKey] != client {
		h.mu.Unlock()
		return
	}
	delete(h.clients, clientKey)
	isOnline := h.userOnlineLocked(client.Identity().UserID)
	h.mu.Unlock()
	becameOffline := !isOnline
	if h.coord != nil {
		if transition, err := h.coord.Disconnect(ctx, client.Identity().UserID, presenceConnectionID(client)); err == nil {
			becameOffline = transition
		}
	}
	if h.calls != nil {
		calls, err := h.calls.EndByDevice(ctx, client.Identity().UserID, client.Identity().DeviceID, clientConnectionID(client))
		if err == nil {
			for _, call := range calls {
				h.logCallLifecycle(ctx, "call ended after websocket disconnect", call, "user_id", client.Identity().UserID, "device_id", client.Identity().DeviceID)
				h.publishCall(ctx, CallChange{Type: "ended", Call: call})
			}
		} else {
			h.logCallWarning(ctx, "could not end calls after websocket disconnect", err, "user_id", client.Identity().UserID, "device_id", client.Identity().DeviceID)
		}
	}
	if rooms, ok := h.coord.(GroupRoomCoordinator); ok {
		changed, err := rooms.RemoveGroupConnection(ctx, client.Identity().UserID, client.Identity().DeviceID, clientConnectionID(client))
		if err == nil {
			for _, room := range changed {
				h.notifyGroupRoom(ctx, GroupRoomChange{Type: "participant.left", Room: room, FromUserID: client.Identity().UserID, FromDeviceID: client.Identity().DeviceID})
			}
		} else {
			h.logCallWarning(ctx, "could not remove group room participant after websocket disconnect", err, "actor_user_id", client.Identity().UserID, "actor_device_id", client.Identity().DeviceID)
		}
	}
	if becameOffline {
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

func (h *Hub) NotifyConversationCreated(ctx context.Context, conversationID uuid.UUID, userIDs []uuid.UUID) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	// Deliver locally before publishing so a connected peer on this replica does
	// not depend on the Redis subscription loop being scheduled in time.
	if err := h.DeliverConversationCreated(ctx, conversationID, userIDs); err != nil {
		return err
	}
	if coordinator, ok := h.coord.(ConversationCoordinator); ok {
		return coordinator.PublishConversation(ctx, conversationID, userIDs)
	}
	return nil
}

func (h *Hub) DeliverConversationCreated(ctx context.Context, conversationID uuid.UUID, userIDs []uuid.UUID) error {
	for _, userID := range userIDs {
		if err := ctx.Err(); err != nil {
			return err
		}
		for _, recipient := range h.recipients(userID) {
			if err := ctx.Err(); err != nil {
				return err
			}
			recipient.SendJSON(serverEvent{Version: ProtocolVersion, Type: "conversation.created", Payload: struct {
				ConversationID uuid.UUID `json:"conversation_id"`
			}{ConversationID: conversationID}})
		}
	}
	return nil
}

func (h *Hub) NotifyGroupProjection(parentCtx context.Context, conversationID uuid.UUID, revision int64, deleted bool, userIDs []uuid.UUID) error {
	ctx, cancel := context.WithTimeout(parentCtx, groupCallOperationTimeout)
	defer cancel()
	if err := ctx.Err(); err != nil {
		return err
	}
	unlock, err := h.lockGroupConversation(ctx, conversationID)
	if err != nil {
		return err
	}
	defer unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	return h.notifyGroupProjectionLocked(ctx, conversationID, revision, deleted, userIDs)
}

func (h *Hub) notifyGroupProjectionLocked(ctx context.Context, conversationID uuid.UUID, revision int64, deleted bool, recipientUserIDs []uuid.UUID) error {
	if rooms, ok := h.coord.(GroupRoomCoordinator); ok {
		// Preserve the pre-terminal socket targets. Ending clears reservations, so
		// reading afterward would omit precisely the removed member that needs to
		// stop its peer connection.
		room, err := rooms.GetGroupRoomForConversation(ctx, conversationID)
		if err != nil && !errors.Is(err, ErrCallNotFound) {
			return err
		}
		if err == nil && room.Status != GroupRoomEnded && room.MembershipRevision < revision {
			terminalRoom, endErr := rooms.EndGroupRoomForMembershipChange(ctx, conversationID, room.ID, room.Generation, room.StateRevision, revision)
			err = endErr
			if err != nil && !errors.Is(err, ErrCallNotFound) {
				return err
			}
			if err == nil {
				// Keep the pre-terminal roster solely for routing to the exact sockets
				// that joined. The terminal revision comes from the atomic mutation.
				room.StateRevision = terminalRoom.StateRevision
				room.Status = GroupRoomEnded
				room.Presenter = nil
				change := GroupRoomChange{
					Type:                         "ended",
					Room:                         room,
					MembershipProjectionRevision: revision,
					MembershipProjectionDeleted:  deleted,
				}
				change.ParticipantConnectionIDs = groupParticipantConnectionIDs(room)
				h.deliverGroupRoomLockedContext(ctx, change)
				if err := h.publishGroupRoom(ctx, change); err != nil {
					return err
				}
			}
		}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	h.deliverGroupProjectionLocked(ctx, conversationID, revision, deleted, recipientUserIDs)
	if coordinator, ok := h.coord.(GroupProjectionCoordinator); ok {
		return coordinator.PublishGroupProjection(ctx, conversationID, revision, deleted, recipientUserIDs)
	}
	return ctx.Err()
}

// NotifyExpiredGroupRooms emits terminal events for rooms claimed by the
// coordinator's expiry sweep. The caller owns the sweep goroutine and passes
// its shutdown context, so no application goroutine is hidden in the hub.
func (h *Hub) NotifyExpiredGroupRooms(ctx context.Context, rooms []GroupRoom) {
	for _, room := range rooms {
		room.Status = GroupRoomEnded
		room.Presenter = nil
		h.notifyGroupRoom(ctx, GroupRoomChange{Type: "ended", Room: room})
	}
}

func (h *Hub) DeliverGroupProjection(ctx context.Context, conversationID uuid.UUID, revision int64, deleted bool, userIDs []uuid.UUID) {
	unlock, err := h.lockGroupConversation(ctx, conversationID)
	if err != nil {
		return
	}
	defer unlock()
	if ctx.Err() != nil {
		return
	}
	h.deliverGroupProjectionLocked(ctx, conversationID, revision, deleted, userIDs)
}

func (h *Hub) deliverGroupProjectionLocked(ctx context.Context, conversationID uuid.UUID, revision int64, deleted bool, userIDs []uuid.UUID) {
	for _, userID := range userIDs {
		if ctx.Err() != nil {
			return
		}
		for _, recipient := range h.recipients(userID) {
			if ctx.Err() != nil {
				return
			}
			if identified, ok := recipient.(protocolIdentified); ok && identified.ProtocolVersion() < 2 {
				continue
			}
			recipient.SendJSON(serverEvent{Version: 2, Type: "group.membership.changed", Payload: struct {
				ConversationID     uuid.UUID `json:"conversation_id"`
				MembershipRevision int64     `json:"membership_revision"`
				Deleted            bool      `json:"deleted"`
			}{ConversationID: conversationID, MembershipRevision: revision, Deleted: deleted}})
		}
	}
}

func (h *Hub) Handle(ctx context.Context, client Client, payload []byte) error {
	return h.HandleVersion(ctx, client, ProtocolVersion, payload)
}

func (h *Hub) HandleVersion(ctx context.Context, client Client, protocolVersion int, payload []byte) error {
	var request struct {
		Version   int    `json:"version"`
		Type      string `json:"type"`
		RequestID string `json:"request_id,omitempty"`
		Payload   struct {
			ConversationID  uuid.UUID       `json:"conversation_id"`
			ClientMessageID string          `json:"client_message_id"`
			Body            string          `json:"body"`
			Sequence        int64           `json:"sequence"`
			AfterSequence   int64           `json:"after_sequence"`
			CallID          uuid.UUID       `json:"call_id"`
			RoomID          uuid.UUID       `json:"room_id"`
			Generation      int64           `json:"generation"`
			TargetUserID    uuid.UUID       `json:"target_user_id"`
			TargetDeviceID  string          `json:"target_device_id"`
			Signal          json.RawMessage `json:"signal"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(payload, &request); err != nil {
		return &RequestError{Err: errors.New("unsupported event")}
	}
	if request.Version != protocolVersion {
		return &RequestError{RequestID: request.RequestID, Err: errors.New("unsupported protocol version")}
	}
	if protocolVersion == 2 && request.Type == "conversation.reconcile" {
		return h.handleReconcile(ctx, client, request.RequestID, request.Payload.ConversationID, request.Payload.AfterSequence)
	}
	if protocolVersion == 2 && strings.HasPrefix(request.Type, "group.call.") {
		if request.RequestID == "" {
			return &RequestError{Err: errors.New("group call request ID is required")}
		}
		if request.Type != "group.call.start" && request.Payload.Generation <= 0 {
			return &RequestError{RequestID: request.RequestID, Err: errors.New("positive group room generation is required")}
		}
		if len(request.Payload.Signal) > 16*1024 || (len(request.Payload.Signal) > 0 && (!json.Valid(request.Payload.Signal) || !validCallSignal(request.Payload.Signal))) {
			return &RequestError{RequestID: request.RequestID, Err: errors.New("invalid group call signal")}
		}
		timeout := groupCallOperationTimeout
		if request.Type == "group.call.start" {
			timeout = groupCallStartTimeout
		}
		operationCtx, cancel := context.WithTimeout(ctx, timeout)
		defer cancel()
		if limiter, ok := h.coord.(RealtimeRateCoordinator); ok {
			allowed, err := allowRealtimeCallCommand(operationCtx, limiter, client.Identity().UserID, request.Type)
			if err != nil || !allowed {
				if ctxErr := operationCtx.Err(); ctxErr != nil {
					return &RequestError{RequestID: request.RequestID, Err: ctxErr}
				}
				return &RequestError{RequestID: request.RequestID, Err: errors.New("call rate limit exceeded")}
			}
		}
		if request.Type == "group.call.sync" {
			return h.handleGroupRoomSync(operationCtx, client, request.RequestID, request.Payload.ConversationID, request.Payload.RoomID, request.Payload.Generation)
		}
		return h.handleGroupRoom(operationCtx, client, request.RequestID, request.Type, request.Payload.ConversationID, request.Payload.RoomID, request.Payload.Generation, request.Payload.TargetUserID, request.Payload.TargetDeviceID, request.Payload.Signal)
	}
	if request.Type == "presence.refresh" {
		if limiter, ok := h.coord.(RealtimeRateCoordinator); ok {
			allowed, err := limiter.AllowPresenceRefresh(ctx, client.Identity().UserID)
			if err != nil || !allowed {
				return &RequestError{RequestID: request.RequestID, Err: errors.New("presence refresh rate limit exceeded")}
			}
		}
		h.sendPresenceSnapshot(ctx, client)
		return nil
	}
	if len(request.Payload.Signal) > 16*1024 {
		return &RequestError{RequestID: request.RequestID, Err: errors.New("call signal is too large")}
	}
	if len(request.Payload.Signal) > 0 && !json.Valid(request.Payload.Signal) {
		return &RequestError{RequestID: request.RequestID, Err: errors.New("invalid call signal")}
	}
	if request.Type == "call.signal" && !validCallSignal(request.Payload.Signal) {
		return &RequestError{RequestID: request.RequestID, Err: errors.New("unsupported call signal")}
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
		if limiter, ok := h.coord.(RealtimeRateCoordinator); ok {
			allowed, err := allowRealtimeCallCommand(ctx, limiter, client.Identity().UserID, request.Type)
			if err != nil || !allowed {
				return &RequestError{RequestID: request.RequestID, Err: errors.New("call rate limit exceeded")}
			}
		}
		return h.handleCall(ctx, client, request.RequestID, request.Type, request.Payload.ConversationID, request.Payload.CallID, request.Payload.Signal)
	}
	if request.Type == "conversation.read" {
		if limiter, ok := h.coord.(RealtimeRateCoordinator); ok {
			allowed, err := limiter.AllowRead(ctx, client.Identity().UserID)
			if err != nil || !allowed {
				return &RequestError{RequestID: request.RequestID, Err: errors.New("read rate limit exceeded")}
			}
		}
		if h.cursors == nil || request.Payload.Sequence < 1 {
			return &RequestError{RequestID: request.RequestID, Err: errors.New("read cursor unavailable")}
		}
		advance, err := h.cursors.Advance(ctx, client.Identity().UserID, request.Payload.ConversationID, request.Payload.Sequence)
		if err != nil {
			return &RequestError{RequestID: request.RequestID, Err: errors.New("could not update read cursor")}
		}
		if coordinator, ok := h.coord.(ReadCoordinator); ok && coordinator.PublishRead(ctx, client.Identity().UserID, advance.RecipientIDs, request.Payload.ConversationID, advance.Cursor.Sequence, advance.Cursor.VisibleFromSequence) == nil {
			return nil
		}
		h.DeliverReadCursor(client.Identity().UserID, advance.RecipientIDs, request.Payload.ConversationID, advance.Cursor.Sequence, advance.Cursor.VisibleFromSequence)
		return nil
	}
	if request.Type == "typing.start" || request.Type == "typing.stop" {
		if h.typingRecipients == nil {
			return &RequestError{RequestID: request.RequestID, Err: errors.New("typing unavailable")}
		}
		if request.Type == "typing.start" {
			limiter, ok := h.coord.(TypingRateCoordinator)
			if !ok {
				return nil
			}
			allowed, err := limiter.AllowTypingStart(ctx, client.Identity().UserID, request.Payload.ConversationID)
			if err != nil || !allowed {
				return nil
			}
		}
		eventType := "typing.started"
		if request.Type == "typing.stop" {
			eventType = "typing.stopped"
		}
		if err := h.DeliverTypingToConversation(ctx, eventType, request.Payload.ConversationID, client.Identity().UserID); err != nil {
			return &RequestError{RequestID: request.RequestID, Err: errors.New("conversation not found")}
		}
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

func allowRealtimeCallCommand(ctx context.Context, limiter RealtimeRateCoordinator, userID uuid.UUID, eventType string) (bool, error) {
	if strings.HasSuffix(eventType, ".signal") {
		return limiter.AllowSignal(ctx, userID)
	}
	return limiter.AllowCall(ctx, userID)
}

func (h *Hub) handleGroupRoomSync(ctx context.Context, client Client, requestID string, conversationID, roomID uuid.UUID, generation int64) error {
	if requestID == "" || conversationID == uuid.Nil || roomID == uuid.Nil || generation <= 0 {
		return &RequestError{RequestID: requestID, Err: errors.New("invalid group call sync request")}
	}
	unlock, err := h.lockGroupConversation(ctx, conversationID)
	if err != nil {
		return &RequestError{RequestID: requestID, Err: err}
	}
	defer unlock()
	rooms, ok := h.coord.(GroupRoomCoordinator)
	if !ok || h.groupCallAuth == nil {
		return &RequestError{RequestID: requestID, Err: ErrCallUnavailable}
	}
	identity := client.Identity()
	participant := GroupParticipant{UserID: identity.UserID, DeviceID: identity.DeviceID, ConnectionID: clientConnectionID(client)}
	ended := func() {
		client.SendJSON(serverEvent{Version: 2, Type: "group.call.synced", RequestID: requestID, Payload: struct {
			RoomID     uuid.UUID `json:"room_id"`
			Generation int64     `json:"generation"`
			Status     string    `json:"status"`
		}{roomID, generation, GroupRoomEnded}})
	}
	lease, err := h.groupCallAuth.BeginGroupCall(ctx, conversationID, identity.UserID)
	if errors.Is(err, ErrCallNotAllowed) {
		ended()
		return nil
	}
	if err != nil {
		return &RequestError{RequestID: requestID, Err: ErrCallUnavailable}
	}
	defer func() {
		rollbackCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Second)
		defer cancel()
		_ = lease.Rollback(rollbackCtx)
	}()
	room, active, err := rooms.SyncGroupRoom(ctx, roomID, generation, participant)
	if err != nil {
		return &RequestError{RequestID: requestID, Err: ErrCallUnavailable}
	}
	if !active || room.ConversationID != conversationID || room.MembershipRevision != lease.MembershipRevision() {
		if active && room.MembershipRevision < lease.MembershipRevision() {
			// Projection fan-out may have been missed; the sync itself deliberately
			// returns no roster. Conditional cleanup cannot affect a newer room.
			if _, endErr := rooms.EndGroupRoomForMembershipChange(ctx, conversationID, room.ID, room.Generation, room.StateRevision, lease.MembershipRevision()); endErr != nil && !errors.Is(endErr, ErrCallNotFound) && !errors.Is(endErr, ErrCallNotAllowed) {
				h.logCallWarning(ctx, "stale group room cleanup failed", endErr, "request_id", requestID, "room_id", room.ID)
			}
		}
		ended()
		return nil
	}
	client.SendJSON(serverEvent{Version: 2, Type: "group.call.synced", RequestID: requestID, Payload: room})
	h.logCallLifecycle(ctx, "group call synchronized", Call{ID: room.ID, ConversationID: room.ConversationID, Status: room.Status}, "command", "group.call.sync", "request_id", requestID, "actor_user_id", identity.UserID, "actor_device_id", identity.DeviceID)
	return nil
}

func (h *Hub) handleReconcile(ctx context.Context, client Client, requestID string, conversationID uuid.UUID, afterSequence int64) error {
	if requestID == "" || conversationID == uuid.Nil || afterSequence < 0 || h.reconcile == nil {
		return &RequestError{RequestID: requestID, Err: errors.New("reconciliation unavailable")}
	}
	limiter, ok := h.coord.(ReconciliationRateCoordinator)
	if !ok {
		return &RequestError{RequestID: requestID, Err: errors.New("reconciliation rate limit exceeded")}
	}
	allowed, err := limiter.AllowReconciliation(ctx, client.Identity().UserID)
	if err != nil || !allowed {
		return &RequestError{RequestID: requestID, Err: errors.New("reconciliation rate limit exceeded")}
	}
	reconciliation, err := h.reconcile.Reconcile(ctx, client.Identity().UserID, conversationID, afterSequence, ReconciliationMessageLimit)
	if err != nil {
		return &RequestError{RequestID: requestID, Err: errors.New("conversation not found")}
	}
	reconciliation.ConversationID = conversationID
	if reconciliation.Messages == nil {
		reconciliation.Messages = []messaging.Message{}
	}
	client.SendJSON(serverEvent{Version: 2, Type: "conversation.reconciled", RequestID: requestID, Payload: reconciliation})
	return nil
}

func (h *Hub) DeliverMessageCreated(message messaging.Message) {
	userIDs := message.RecipientIDs
	if len(userIDs) == 0 && message.RecipientID != uuid.Nil {
		userIDs = []uuid.UUID{message.RecipientID}
	}
	for _, userID := range userIDs {
		for _, recipient := range h.recipients(userID) {
			if recipient.SendJSON(serverEvent{Version: ProtocolVersion, Type: "message.created", Payload: message}) {
				_ = h.markDelivered(context.Background(), recipient, []uuid.UUID{message.ID})
			}
		}
	}
}

func (h *Hub) DeliverReadCursor(readerID uuid.UUID, recipientIDs []uuid.UUID, conversationID uuid.UUID, sequence, visibleFromSequence int64) {
	userIDs := append([]uuid.UUID{readerID}, recipientIDs...)
	seen := make(map[uuid.UUID]struct{}, len(userIDs))
	for _, userID := range userIDs {
		if _, exists := seen[userID]; exists {
			continue
		}
		seen[userID] = struct{}{}
		for _, recipient := range h.recipients(userID) {
			version := ProtocolVersion
			if identified, ok := recipient.(protocolIdentified); ok && identified.ProtocolVersion() >= 2 {
				version = 2
			}
			recipient.SendJSON(serverEvent{Version: version, Type: "conversation.read", Payload: struct {
				ConversationID      uuid.UUID `json:"conversation_id"`
				UserID              uuid.UUID `json:"user_id"`
				Sequence            int64     `json:"sequence"`
				VisibleFromSequence int64     `json:"visible_from_sequence"`
			}{ConversationID: conversationID, UserID: readerID, Sequence: sequence, VisibleFromSequence: visibleFromSequence}})
		}
	}
}

func (h *Hub) handleGroupRoom(ctx context.Context, client Client, requestID, eventType string, conversationID, roomID uuid.UUID, generation int64, targetUserID uuid.UUID, targetDeviceID string, signal json.RawMessage) error {
	unlock, err := h.lockGroupConversation(ctx, conversationID)
	if err != nil {
		return &RequestError{RequestID: requestID, Err: err}
	}
	defer unlock()
	rooms, roomsOK := h.coord.(GroupRoomCoordinator)
	if !roomsOK || h.groupCallAuth == nil || h.coord == nil {
		return &RequestError{RequestID: requestID, Err: ErrCallUnavailable}
	}
	identity := client.Identity()
	var revision int64
	if err := ctx.Err(); err != nil {
		return &RequestError{RequestID: requestID, Err: err}
	}
	participant := GroupParticipant{UserID: identity.UserID, DeviceID: identity.DeviceID, ConnectionID: clientConnectionID(client)}
	var commandLease GroupCallLease
	commandLeaseDone := false
	var activeMemberIDs []uuid.UUID
	var localDelivery *GroupRoomChange
	if eventType != "group.call.start" {
		commandLease, err = h.groupCallAuth.BeginGroupCall(ctx, conversationID, identity.UserID)
		if err != nil {
			if ctxErr := ctx.Err(); ctxErr != nil {
				return &RequestError{RequestID: requestID, Err: ctxErr}
			}
			if errors.Is(err, ErrCallNotAllowed) {
				return &RequestError{RequestID: requestID, Err: ErrCallNotAllowed}
			}
			return &RequestError{RequestID: requestID, Err: ErrCallUnavailable}
		}
		defer func() {
			if !commandLeaseDone {
				rollbackCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Second)
				defer cancel()
				if rollbackErr := commandLease.Rollback(rollbackCtx); rollbackErr != nil {
					h.logCallWarning(ctx, "group call authorization lease rollback failed", rollbackErr, "request_id", requestID, "conversation_id", conversationID)
				}
			}
		}()
		revision = commandLease.MembershipRevision()
		activeMemberIDs = commandLease.ActiveMemberIDs()
	}
	var room GroupRoom
	switch eventType {
	case "group.call.start":
		if conversationID == uuid.Nil {
			return &RequestError{RequestID: requestID, Err: errors.New("conversation is required")}
		}
		if h.groupCallAuth == nil {
			return &RequestError{RequestID: requestID, Err: ErrCallUnavailable}
		}
		admission, admissionOK := h.coord.(CallAdmissionCoordinator)
		if !admissionOK {
			return &RequestError{RequestID: requestID, Err: ErrCallUnavailable}
		}
		token, admissionErr := admission.AcquireCallAdmission(ctx, []uuid.UUID{identity.UserID})
		if token != "" {
			defer func() {
				releaseCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Second)
				defer cancel()
				admission.ReleaseCallAdmission(releaseCtx, []uuid.UUID{identity.UserID}, token)
			}()
		}
		if admissionErr != nil {
			if ctxErr := ctx.Err(); ctxErr != nil {
				return &RequestError{RequestID: requestID, Err: ctxErr}
			}
			return &RequestError{RequestID: requestID, Err: ErrCallUnavailable}
		}
		if token == "" {
			return &RequestError{RequestID: requestID, Err: ErrCallUnavailable}
		}
		lease, leaseErr := h.groupCallAuth.BeginGroupCall(ctx, conversationID, identity.UserID)
		if leaseErr != nil {
			if ctxErr := ctx.Err(); ctxErr != nil {
				return &RequestError{RequestID: requestID, Err: ctxErr}
			}
			if errors.Is(leaseErr, ErrCallNotAllowed) {
				return &RequestError{RequestID: requestID, Err: ErrCallNotAllowed}
			}
			return &RequestError{RequestID: requestID, Err: ErrCallUnavailable}
		}
		leaseDone := false
		defer func() {
			if !leaseDone {
				rollbackCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Second)
				defer cancel()
				if rollbackErr := lease.Rollback(rollbackCtx); rollbackErr != nil {
					h.logCallWarning(ctx, "group call start lease rollback failed", rollbackErr, "request_id", requestID, "conversation_id", conversationID)
				}
			}
		}()
		revision = lease.MembershipRevision()
		memberIDs := lease.ActiveMemberIDs()
		attemptedRoom := GroupRoom{ID: uuid.New(), ConversationID: conversationID, MembershipRevision: revision, Generation: 1, Participants: []GroupParticipant{participant}}
		cleanupAttempt := func(operation string) {
			cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Second)
			cleanupErr := rooms.AbortGroupRoomStart(cleanupCtx, attemptedRoom.ID, attemptedRoom.Generation, participant)
			cancel()
			if cleanupErr != nil && !errors.Is(cleanupErr, ErrCallNotFound) && !errors.Is(cleanupErr, ErrCallNotAllowed) {
				err = errors.Join(err, fmt.Errorf("group room cleanup after %s: %w", operation, cleanupErr))
			}
		}
		if err = ctx.Err(); err == nil {
			room, err = rooms.StartGroupRoom(ctx, attemptedRoom, token)
		}
		if err != nil {
			cleanupAttempt("start failure")
		} else {
			err = ctx.Err()
			if err == nil && ctx.Err() == nil {
				change := GroupRoomChange{Type: "started", Room: room, FromUserID: identity.UserID, FromDeviceID: identity.DeviceID, RecipientUserIDs: memberIDs}
				change.ParticipantConnectionIDs = groupParticipantConnectionIDs(change.Room)
				err = h.publishGroupRoom(ctx, change)
				if err == nil {
					localDelivery = &change
				}
			} else if err == nil {
				err = ctx.Err()
			}
			if err == nil {
				err = lease.Commit(ctx)
			}
			leaseDone = err == nil
			if err != nil {
				cleanupAttempt("lease commit or fanout failure")
			}
		}
	case "group.call.join":
		admission, admissionOK := h.coord.(CallAdmissionCoordinator)
		if !admissionOK {
			err = ErrCallUnavailable
			break
		}
		room, err = rooms.GetGroupRoom(ctx, roomID)
		if err == nil && (room.ConversationID != conversationID || room.Generation != generation || room.MembershipRevision != revision) {
			err = ErrCallNotAllowed
		}
		if err == nil {
			if err = ctx.Err(); err != nil {
				break
			}
			var token string
			token, err = admission.AcquireCallAdmission(ctx, []uuid.UUID{identity.UserID})
			if err == nil {
				defer func() {
					releaseCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Second)
					defer cancel()
					admission.ReleaseCallAdmission(releaseCtx, []uuid.UUID{identity.UserID}, token)
				}()
				if err = ctx.Err(); err == nil {
					room, err = rooms.JoinGroupRoom(ctx, roomID, participant, revision, token)
				}
			}
		}
		if err == nil {
			if err = ctx.Err(); err == nil {
				change := GroupRoomChange{Type: "participant.joined", Room: room, FromUserID: identity.UserID, FromDeviceID: identity.DeviceID}
				change.ParticipantConnectionIDs = groupParticipantConnectionIDs(change.Room)
				localDelivery, err = h.publishGroupRoomAfterMutation(ctx, change)
			}
		}
	case "group.call.leave":
		room, err = rooms.GetGroupRoom(ctx, roomID)
		if err == nil && (room.ConversationID != conversationID || room.Generation != generation || room.MembershipRevision != revision || !groupParticipantOwns(room, participant)) {
			err = ErrCallNotAllowed
		}
		if err == nil {
			if err = ctx.Err(); err != nil {
				break
			}
			room, err = rooms.LeaveGroupRoom(ctx, roomID, participant)
		}
		if err == nil {
			if err = ctx.Err(); err == nil {
				change := GroupRoomChange{Type: "participant.left", Room: room, FromUserID: identity.UserID, FromDeviceID: identity.DeviceID}
				change.ParticipantConnectionIDs = groupParticipantConnectionIDs(change.Room)
				localDelivery, err = h.publishGroupRoomAfterMutation(ctx, change)
			}
		}
	case "group.call.end":
		// Redis clears participant reservations atomically when ending a room. Keep
		// the pre-end socket ownership only in this internal fan-out envelope so
		// every participant receives the terminal snapshot.
		terminalRoom, getErr := rooms.GetGroupRoom(ctx, roomID)
		if getErr != nil {
			err = getErr
			break
		}
		if terminalRoom.ConversationID != conversationID || terminalRoom.Generation != generation || terminalRoom.MembershipRevision != revision || !groupParticipantOwns(terminalRoom, participant) {
			err = ErrCallNotAllowed
			break
		}
		if err = ctx.Err(); err != nil {
			break
		}
		room, err = rooms.EndGroupRoom(ctx, roomID, participant)
		if err == nil {
			if err = ctx.Err(); err == nil {
				// Keep the pre-end participant roster for routing, but use the
				// revision from the atomic post-end mutation result.
				terminalRoom.StateRevision = room.StateRevision
				terminalRoom.Status = GroupRoomEnded
				terminalRoom.Presenter = nil
				change := GroupRoomChange{Type: "ended", Room: terminalRoom, FromUserID: identity.UserID, FromDeviceID: identity.DeviceID}
				change.ParticipantConnectionIDs = groupParticipantConnectionIDs(change.Room)
				localDelivery, err = h.publishGroupRoomAfterMutation(ctx, change)
			}
		}
	case "group.call.presenter.start", "group.call.presenter.stop":
		room, err = rooms.GetGroupRoom(ctx, roomID)
		if err == nil && (room.ConversationID != conversationID || room.Generation != generation || room.MembershipRevision != revision || !groupParticipantOwns(room, participant)) {
			err = ErrCallNotAllowed
		}
		if err == nil {
			if err = ctx.Err(); err != nil {
				break
			}
			room, err = rooms.SetGroupPresenter(ctx, roomID, participant, eventType == "group.call.presenter.start")
		}
		if err == nil {
			if err = ctx.Err(); err == nil {
				change := GroupRoomChange{Type: strings.TrimPrefix(eventType, "group.call."), Room: room, FromUserID: identity.UserID, FromDeviceID: identity.DeviceID}
				change.ParticipantConnectionIDs = groupParticipantConnectionIDs(change.Room)
				localDelivery, err = h.publishGroupRoomAfterMutation(ctx, change)
			}
		}
	case "group.call.signal":
		if roomID == uuid.Nil || targetUserID == uuid.Nil || targetDeviceID == "" || len(signal) == 0 {
			return &RequestError{RequestID: requestID, Err: errors.New("room, target, and signal are required")}
		}
		room, err = rooms.GetGroupRoom(ctx, roomID)
		if err == nil && (room.ConversationID != conversationID || room.Generation != generation || room.MembershipRevision != revision || room.Status != GroupRoomActive) {
			err = ErrCallNotAllowed
		}
		if err == nil && !groupParticipantOwns(room, participant) {
			err = ErrCallNotAllowed
		}
		if err == nil {
			if err = ctx.Err(); err != nil {
				break
			}
			if !containsUUID(activeMemberIDs, targetUserID) || !groupParticipantExists(room, targetUserID, targetDeviceID) {
				err = ErrCallNotAllowed
			}
		}
		if err == nil {
			if err = ctx.Err(); err == nil {
				change := GroupRoomChange{Type: "signal", Room: room, FromUserID: identity.UserID, FromDeviceID: identity.DeviceID, ToUserID: targetUserID, ToDeviceID: targetDeviceID, ConnectionID: participant.ConnectionID, Signal: signal}
				change.ParticipantConnectionIDs = groupParticipantConnectionIDs(change.Room)
				err = h.publishGroupRoom(ctx, change)
				if err == nil {
					localDelivery = &change
				}
			}
		}
	default:
		return &RequestError{RequestID: requestID, Err: errors.New("unsupported group call event")}
	}
	if err == nil {
		err = ctx.Err()
	}
	if err == nil && commandLease != nil {
		err = commandLease.Commit(ctx)
		commandLeaseDone = err == nil
	}
	if err == nil && localDelivery != nil {
		h.deliverGroupRoomLockedContext(ctx, *localDelivery)
	}
	if err != nil {
		h.logCallWarning(ctx, "group call command rejected", err, "command", eventType, "request_id", requestID, "room_id", roomID, "actor_user_id", identity.UserID, "actor_device_id", identity.DeviceID)
		return &RequestError{RequestID: requestID, Err: err}
	}
	h.logCallLifecycle(ctx, "group call command accepted", Call{ID: room.ID, ConversationID: room.ConversationID, Status: room.Status}, "command", eventType, "request_id", requestID, "actor_user_id", identity.UserID, "actor_device_id", identity.DeviceID)
	return nil
}

func groupParticipantOwns(room GroupRoom, participant GroupParticipant) bool {
	for _, current := range room.Participants {
		if current.UserID == participant.UserID && current.DeviceID == participant.DeviceID && current.ConnectionID == participant.ConnectionID {
			return true
		}
	}
	return false
}

func groupParticipantExists(room GroupRoom, userID uuid.UUID, deviceID string) bool {
	for _, current := range room.Participants {
		if current.UserID == userID && current.DeviceID == deviceID {
			return true
		}
	}
	return false
}

func containsUUID(values []uuid.UUID, target uuid.UUID) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func (h *Hub) publishGroupRoom(ctx context.Context, change GroupRoomChange) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	change.ParticipantConnectionIDs = groupParticipantConnectionIDs(change.Room)
	if rooms, ok := h.coord.(GroupRoomCoordinator); ok && ctx.Err() == nil {
		if err := rooms.PublishGroupRoom(ctx, change); err != nil {
			h.logCallWarning(ctx, "group call event fanout failed", err, "event", change.Type, "room_id", change.Room.ID)
			return err
		}
	}
	return ctx.Err()
}

// publishGroupRoomAfterMutation lets Redis remain authoritative when its
// mutation succeeded but best-effort Pub/Sub fan-out did not. The returned
// snapshot is delivered locally only after the membership lease commits.
func (h *Hub) publishGroupRoomAfterMutation(ctx context.Context, change GroupRoomChange) (*GroupRoomChange, error) {
	if err := h.publishGroupRoom(ctx, change); err == nil {
		return &change, nil
	} else if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	return &change, nil
}

// notifyGroupRoom is for room changes without a membership lease. Commands
// authorized by a lease defer local socket enqueue until that lease commits.
func (h *Hub) notifyGroupRoom(ctx context.Context, change GroupRoomChange) {
	unlock, err := h.lockGroupConversation(ctx, change.Room.ConversationID)
	if err != nil {
		return
	}
	defer unlock()
	change.ParticipantConnectionIDs = groupParticipantConnectionIDs(change.Room)
	h.deliverGroupRoomLockedContext(ctx, change)
	_ = h.publishGroupRoom(ctx, change)
}

// DeliverGroupRoom sends a neutral lifecycle snapshot or a single targeted signal.
func (h *Hub) DeliverGroupRoom(ctx context.Context, change GroupRoomChange) {
	unlock, err := h.lockGroupConversation(ctx, change.Room.ConversationID)
	if err != nil {
		return
	}
	defer unlock()
	if ctx.Err() != nil {
		return
	}
	if !h.groupRoomChangeCurrent(change) {
		return
	}
	h.deliverGroupRoomLockedContext(ctx, change)
}

func (h *Hub) deliverGroupRoomLockedContext(ctx context.Context, change GroupRoomChange) {
	change.Room = withGroupParticipantConnections(change.Room, change.ParticipantConnectionIDs)
	if change.Type == "signal" {
		for _, recipient := range h.recipients(change.ToUserID) {
			if identified, ok := recipient.(protocolIdentified); ok && identified.ProtocolVersion() < 2 {
				continue
			}
			if recipient.Identity().DeviceID == change.ToDeviceID && groupParticipantOwns(change.Room, GroupParticipant{UserID: change.ToUserID, DeviceID: change.ToDeviceID, ConnectionID: clientConnectionID(recipient)}) {
				lease, leaseCtx, cancel := h.beginGroupDeliveryLease(ctx, change, recipient)
				if leaseCtx.Err() != nil {
					if lease != nil {
						h.finishGroupDeliveryLease(lease, leaseCtx, cancel)
					} else {
						cancel()
					}
					continue
				}
				if lease == nil {
					cancel()
					continue
				}
				room, authorized := authorizedGroupRoom(change, lease, recipient.Identity().UserID, false)
				if authorized {
					recipient.SendJSON(serverEvent{Version: 2, Type: "group.call.signal", Payload: struct {
						RoomID       uuid.UUID       `json:"room_id"`
						Generation   int64           `json:"generation"`
						FromUserID   uuid.UUID       `json:"from_user_id"`
						FromDeviceID string          `json:"from_device_id"`
						Signal       json.RawMessage `json:"signal"`
					}{room.ID, room.Generation, change.FromUserID, change.FromDeviceID, change.Signal}})
				}
				h.finishGroupDeliveryLease(lease, leaseCtx, cancel)
			}
		}
		return
	}
	recipients := make(map[string]Client)
	orderedRecipients := make([]Client, 0, len(change.Room.Participants)+len(change.RecipientUserIDs))
	addRecipient := func(recipient Client) {
		connectionID := clientConnectionID(recipient)
		if _, exists := recipients[connectionID]; exists {
			return
		}
		recipients[connectionID] = recipient
		orderedRecipients = append(orderedRecipients, recipient)
	}
	// The initiator needs the room ID before a member can react to the start
	// notification. Sending it first preserves that causal ordering even though
	// the remaining recipients are collected from maps.
	if change.Type == "started" {
		for _, participant := range change.Room.Participants {
			if participant.UserID != change.FromUserID || participant.DeviceID != change.FromDeviceID {
				continue
			}
			for _, recipient := range h.recipients(participant.UserID) {
				if clientConnectionID(recipient) == participant.ConnectionID {
					addRecipient(recipient)
				}
			}
		}
	}
	for _, participant := range change.Room.Participants {
		for _, recipient := range h.recipients(participant.UserID) {
			if recipient.Identity().DeviceID == participant.DeviceID && clientConnectionID(recipient) == participant.ConnectionID {
				addRecipient(recipient)
			}
		}
	}
	for _, userID := range change.RecipientUserIDs {
		for _, recipient := range h.recipients(userID) {
			addRecipient(recipient)
		}
	}
	for _, recipient := range orderedRecipients {
		if ctx.Err() != nil {
			return
		}
		if identified, ok := recipient.(protocolIdentified); ok && identified.ProtocolVersion() < 2 {
			continue
		}
		lease, leaseCtx, cancel := h.beginGroupDeliveryLease(ctx, change, recipient)
		if leaseCtx.Err() != nil {
			if lease != nil {
				h.finishGroupDeliveryLease(lease, leaseCtx, cancel)
			} else {
				cancel()
			}
			continue
		}
		if change.Type == "ended" {
			// A deletion projection has no membership row to authorize against.
			// All other terminal payloads require a fresh lease held through enqueue.
			if change.MembershipProjectionDeleted || lease == nil {
				recipient.SendJSON(serverEvent{Version: 2, Type: "group.call.ended", Payload: struct {
					RoomID        uuid.UUID `json:"room_id"`
					Generation    int64     `json:"generation"`
					Status        string    `json:"status"`
					StateRevision int64     `json:"state_revision"`
				}{change.Room.ID, change.Room.Generation, GroupRoomEnded, change.Room.StateRevision}})
				if lease != nil {
					h.finishGroupDeliveryLease(lease, leaseCtx, cancel)
				} else {
					cancel()
				}
				continue
			}
			room, authorized := authorizedGroupRoom(change, lease, recipient.Identity().UserID, true)
			if authorized {
				h.sendFullGroupRoom(ctx, change, room, recipient)
			} else {
				recipient.SendJSON(serverEvent{Version: 2, Type: "group.call.ended", Payload: struct {
					RoomID        uuid.UUID `json:"room_id"`
					Generation    int64     `json:"generation"`
					Status        string    `json:"status"`
					StateRevision int64     `json:"state_revision"`
				}{change.Room.ID, change.Room.Generation, GroupRoomEnded, change.Room.StateRevision}})
			}
			h.finishGroupDeliveryLease(lease, leaseCtx, cancel)
			continue
		}
		if lease == nil {
			cancel()
			continue
		}
		room, authorized := authorizedGroupRoom(change, lease, recipient.Identity().UserID, false)
		if authorized {
			h.sendFullGroupRoom(ctx, change, room, recipient)
		}
		h.finishGroupDeliveryLease(lease, leaseCtx, cancel)
	}
}

// beginGroupDeliveryLease bounds how long fan-out can hold the authoritative
// membership lock while a recipient's socket queue is admitted.
func (h *Hub) beginGroupDeliveryLease(parent context.Context, change GroupRoomChange, recipient Client) (GroupCallLease, context.Context, context.CancelFunc) {
	ctx, cancel := context.WithTimeout(parent, groupCallOperationTimeout)
	if h.groupCallAuth == nil || ctx.Err() != nil {
		return nil, ctx, cancel
	}
	lease, err := h.groupCallAuth.BeginGroupCall(ctx, change.Room.ConversationID, recipient.Identity().UserID)
	if err != nil || lease == nil || ctx.Err() != nil {
		if lease != nil {
			h.finishGroupDeliveryLease(lease, ctx, cancel)
			return nil, ctx, func() {}
		}
		return nil, ctx, cancel
	}
	return lease, ctx, cancel
}

func (h *Hub) finishGroupDeliveryLease(lease GroupCallLease, ctx context.Context, cancel context.CancelFunc) {
	rollbackCtx, rollbackCancel := context.WithTimeout(context.WithoutCancel(ctx), time.Second)
	_ = lease.Rollback(rollbackCtx)
	rollbackCancel()
	cancel()
}

func authorizedGroupRoom(change GroupRoomChange, lease GroupCallLease, recipientID uuid.UUID, terminal bool) (GroupRoom, bool) {
	if lease == nil {
		return GroupRoom{}, false
	}
	revision := lease.MembershipRevision()
	if terminal {
		minimumRevision := change.MembershipProjectionRevision
		if minimumRevision == 0 {
			minimumRevision = change.Room.MembershipRevision
		}
		if revision < minimumRevision {
			return GroupRoom{}, false
		}
	} else if revision != change.Room.MembershipRevision {
		return GroupRoom{}, false
	}
	memberIDs := lease.ActiveMemberIDs()
	activeMembers := make(map[uuid.UUID]struct{}, len(memberIDs))
	for _, userID := range memberIDs {
		activeMembers[userID] = struct{}{}
	}
	if _, active := activeMembers[recipientID]; !active {
		return GroupRoom{}, false
	}
	room := change.Room
	room.Participants = make([]GroupParticipant, 0, len(change.Room.Participants))
	connections := make(map[string]string, len(change.ParticipantConnectionIDs))
	for _, participant := range change.Room.Participants {
		if _, active := activeMembers[participant.UserID]; !active {
			continue
		}
		room.Participants = append(room.Participants, participant)
		key := groupParticipantKey(participant.UserID, participant.DeviceID)
		if connectionID := change.ParticipantConnectionIDs[key]; connectionID != "" {
			connections[key] = connectionID
		}
	}
	if room.Presenter != nil {
		if _, active := activeMembers[room.Presenter.UserID]; !active {
			room.Presenter = nil
		} else if connectionID := connections[groupParticipantKey(room.Presenter.UserID, room.Presenter.DeviceID)]; connectionID != "" {
			room.Presenter.ConnectionID = connectionID
		}
	}
	room = withGroupParticipantConnections(room, connections)
	return room, true
}

func (h *Hub) sendFullGroupRoom(ctx context.Context, change GroupRoomChange, room GroupRoom, recipient Client) {
	var iceServers []ICEServer
	if room.Status == GroupRoomActive && h.turn != nil {
		server, err := h.turn.Issue(Call{ID: room.ID, ConversationID: room.ConversationID, Status: room.Status, ExpiresAt: room.ExpiresAt}, recipient.Identity().UserID)
		if err != nil {
			h.logCallWarning(ctx, "group TURN credential issuance failed", err, "event", change.Type, "room_id", room.ID, "participant_user_id", recipient.Identity().UserID)
			return
		}
		iceServers = []ICEServer{server}
	}
	recipient.SendJSON(serverEvent{Version: 2, Type: "group.call." + change.Type, Payload: struct {
		GroupRoom
		ICEServers []ICEServer `json:"ice_servers,omitempty"`
	}{GroupRoom: room, ICEServers: iceServers}})
}

func (h *Hub) lockGroupConversation(ctx context.Context, conversationID uuid.UUID) (func(), error) {
	// Fixed stripes bound synchronization state independently of conversation
	// cardinality. Hash collisions only serialize unrelated conversations.
	var hash uint64 = 14695981039346656037
	for _, b := range conversationID {
		hash ^= uint64(b)
		hash *= 1099511628211
	}
	lock := h.groupOrder[hash%uint64(len(h.groupOrder))]
	select {
	case lock <- struct{}{}:
		if err := ctx.Err(); err != nil {
			<-lock
			return nil, err
		}
		return func() { <-lock }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// groupRoomChangeCurrent rejects delayed pub/sub room snapshots after a
// membership revision has advanced. BeginGroupCall is a short read lease
// that also proves the event actor is still an active member.
func (h *Hub) groupRoomChangeCurrent(change GroupRoomChange) bool {
	if h.groupCallAuth == nil || change.Room.MembershipRevision <= 0 {
		return false
	}
	if change.Type == "ended" && change.MembershipProjectionRevision > change.Room.MembershipRevision {
		if change.MembershipProjectionDeleted {
			// A deletion projection comes from the trusted PostgreSQL outbox; the
			// group row is intentionally no longer available to query remotely.
			return true
		}
		verifier, ok := h.groupCallAuth.(GroupProjectionVerifier)
		if !ok {
			return false
		}
		ctx, cancel := context.WithTimeout(context.Background(), groupCallOperationTimeout)
		defer cancel()
		revision, err := verifier.GroupMembershipRevision(ctx, change.Room.ConversationID)
		return err == nil && revision >= change.MembershipProjectionRevision
	}
	actorID := change.FromUserID
	if actorID == uuid.Nil && len(change.Room.Participants) > 0 {
		actorID = change.Room.Participants[0].UserID
	}
	if actorID == uuid.Nil {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), groupCallOperationTimeout)
	defer cancel()
	lease, err := h.groupCallAuth.BeginGroupCall(ctx, change.Room.ConversationID, actorID)
	if err != nil {
		return false
	}
	defer func() {
		rollbackCtx, rollbackCancel := context.WithTimeout(context.Background(), time.Second)
		defer rollbackCancel()
		_ = lease.Rollback(rollbackCtx)
	}()
	return lease.MembershipRevision() == change.Room.MembershipRevision
}

func groupParticipantConnectionIDs(room GroupRoom) map[string]string {
	connections := make(map[string]string, len(room.Participants))
	for _, participant := range room.Participants {
		if participant.ConnectionID != "" {
			connections[groupParticipantKey(participant.UserID, participant.DeviceID)] = participant.ConnectionID
		}
	}
	return connections
}

func withGroupParticipantConnections(room GroupRoom, connections map[string]string) GroupRoom {
	for index := range room.Participants {
		room.Participants[index].ConnectionID = connections[groupParticipantKey(room.Participants[index].UserID, room.Participants[index].DeviceID)]
	}
	if room.Presenter != nil {
		room.Presenter.ConnectionID = connections[groupParticipantKey(room.Presenter.UserID, room.Presenter.DeviceID)]
	}
	return room
}

func groupParticipantKey(userID uuid.UUID, deviceID string) string {
	return userID.String() + ":" + deviceID
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
		admission, admissionOK := h.coord.(CallAdmissionCoordinator)
		if !admissionOK {
			err = ErrCallUnavailable
		}
		var token string
		if err == nil {
			token, err = admission.AcquireCallAdmission(ctx, []uuid.UUID{identity.UserID, recipientID})
		}
		if token != "" {
			defer func() {
				releaseCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Second)
				defer cancel()
				admission.ReleaseCallAdmission(releaseCtx, []uuid.UUID{identity.UserID, recipientID}, token)
			}()
		}
		if err == nil {
			call, err = h.calls.Start(ctx, Call{ID: uuid.New(), ConversationID: conversationID, CallerID: identity.UserID, RecipientID: recipientID, CallerDeviceID: identity.DeviceID, CallerConnectionID: clientConnectionID(client)}, token)
		}
		if err == nil {
			h.publishCall(ctx, CallChange{Type: "started", Call: call})
		}
	case "call.accept":
		call, err = h.calls.Accept(ctx, callID, identity.UserID, identity.DeviceID, clientConnectionID(client))
		if err == nil {
			if credentialErr := h.validateCallCredentials(call); credentialErr != nil {
				ended, endErr := h.calls.End(ctx, call.ID, identity.UserID, identity.DeviceID, clientConnectionID(client))
				if endErr == nil {
					h.publishCall(ctx, CallChange{Type: "ended", Call: ended})
				} else {
					h.logCallWarning(ctx, "could not release call after credential failure", endErr, "call_id", call.ID)
				}
				err = credentialErr
			} else {
				h.publishCall(ctx, CallChange{Type: "accepted", Call: call})
			}
		}
	case "call.decline":
		call, err = h.calls.Decline(ctx, callID, identity.UserID, identity.DeviceID, clientConnectionID(client))
		if err == nil {
			h.publishCall(ctx, CallChange{Type: "declined", Call: call})
		}
	case "call.cancel":
		call, err = h.calls.Cancel(ctx, callID, identity.UserID, identity.DeviceID, clientConnectionID(client))
		if err == nil {
			h.publishCall(ctx, CallChange{Type: "ended", Call: call})
		}
	case "call.end":
		call, err = h.calls.End(ctx, callID, identity.UserID, identity.DeviceID, clientConnectionID(client))
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
			var toConnectionID string
			switch {
			case identity.UserID == call.CallerID && identity.DeviceID == call.CallerDeviceID && (call.CallerConnectionID == "" || clientConnectionID(client) == call.CallerConnectionID) && call.AcceptedDeviceID != "":
				toDeviceID = call.AcceptedDeviceID
				toConnectionID = call.AcceptedConnectionID
			case identity.UserID == call.RecipientID && identity.DeviceID == call.AcceptedDeviceID && (call.AcceptedConnectionID == "" || clientConnectionID(client) == call.AcceptedConnectionID):
				toDeviceID = call.CallerDeviceID
				toConnectionID = call.CallerConnectionID
			default:
				err = ErrCallNotAllowed
			}
			if err == nil {
				h.publishCall(ctx, CallChange{Type: "signal", Call: call, FromDeviceID: identity.DeviceID, ToDeviceID: toDeviceID, FromConnectionID: clientConnectionID(client), ToConnectionID: toConnectionID, Signal: signal})
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
	change.CallerConnectionID = change.Call.CallerConnectionID
	change.AcceptedConnectionID = change.Call.AcceptedConnectionID
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
	call := change.Call
	if call.CallerConnectionID == "" {
		call.CallerConnectionID = change.CallerConnectionID
	}
	if call.AcceptedConnectionID == "" {
		call.AcceptedConnectionID = change.AcceptedConnectionID
	}
	send := func(userID uuid.UUID, deviceID, connectionID, eventType string, payload any) {
		for _, recipient := range h.recipients(userID) {
			if recipient.Identity().DeviceID == deviceID && (connectionID == "" || clientConnectionID(recipient) == connectionID) {
				recipient.SendJSON(serverEvent{Version: ProtocolVersion, Type: eventType, Payload: payload})
			}
		}
	}
	switch change.Type {
	case "started":
		// A recipient can accept as soon as its incoming event is enqueued. Queue
		// the caller's ring first, otherwise a fast accept may overtake it and the
		// caller cannot correlate the accepted event to a call ID yet.
		send(call.CallerID, call.CallerDeviceID, call.CallerConnectionID, "call.ringing", call)
		for _, recipient := range h.recipients(call.RecipientID) {
			recipient.SendJSON(serverEvent{Version: ProtocolVersion, Type: "call.incoming", Payload: call})
		}
	case "accepted":
		callerPayload := h.callAcceptedPayload(call, call.CallerID)
		recipientPayload := h.callAcceptedPayload(call, call.RecipientID)
		if callerPayload == nil || recipientPayload == nil {
			return
		}
		send(call.CallerID, call.CallerDeviceID, call.CallerConnectionID, "call.accepted", callerPayload)
		send(call.RecipientID, call.AcceptedDeviceID, call.AcceptedConnectionID, "call.accepted", recipientPayload)
	case "declined":
		send(call.CallerID, call.CallerDeviceID, call.CallerConnectionID, "call.declined", call)
		for _, recipient := range h.recipients(call.RecipientID) {
			recipient.SendJSON(serverEvent{Version: ProtocolVersion, Type: "call.declined", Payload: call})
		}
	case "ended":
		send(call.CallerID, call.CallerDeviceID, call.CallerConnectionID, "call.ended", call)
		if call.AcceptedDeviceID != "" {
			send(call.RecipientID, call.AcceptedDeviceID, call.AcceptedConnectionID, "call.ended", call)
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
		send(userID, change.ToDeviceID, change.ToConnectionID, "call.signal", struct {
			CallID uuid.UUID       `json:"call_id"`
			Signal json.RawMessage `json:"signal"`
		}{CallID: call.ID, Signal: change.Signal})
	}
}

func (h *Hub) callAcceptedPayload(call Call, userID uuid.UUID) any {
	if h.turn == nil {
		return nil
	}
	server, err := h.turn.Issue(call, userID)
	if err != nil {
		return nil
	}
	return struct {
		Call
		ICEServers []ICEServer `json:"ice_servers"`
	}{Call: call, ICEServers: []ICEServer{server}}
}

func (h *Hub) validateCallCredentials(call Call) error {
	if h.turn == nil {
		return ErrCallUnavailable
	}
	if _, err := h.turn.Issue(call, call.CallerID); err != nil {
		return ErrCallUnavailable
	}
	if _, err := h.turn.Issue(call, call.RecipientID); err != nil {
		return ErrCallUnavailable
	}
	return nil
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
			if !client.SendJSON(serverEvent{Version: ProtocolVersion, Type: "message.created", Payload: message}) {
				if len(messageIDs) > 0 {
					if err := h.markDelivered(ctx, client, messageIDs); err != nil {
						return
					}
				}
				return
			}
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

func validCallSignal(signal json.RawMessage) bool {
	var value struct {
		Type      string          `json:"type"`
		SDP       string          `json:"sdp"`
		Candidate json.RawMessage `json:"candidate"`
	}
	if err := json.Unmarshal(signal, &value); err != nil {
		return false
	}
	switch value.Type {
	case "offer", "answer":
		return value.SDP != ""
	case "candidate":
		candidate := bytes.TrimSpace(value.Candidate)
		return len(candidate) > 0 && candidate[0] == '{'
	case "screen-share-started", "screen-share-stopped":
		return true
	default:
		return false
	}
}

func (h *Hub) DeliverTyping(eventType string, conversationID, userID uuid.UUID, recipientIDs []uuid.UUID) {
	for _, recipientID := range recipientIDs {
		if recipientID == userID {
			continue
		}
		for _, recipient := range h.recipients(recipientID) {
			recipient.SendJSON(serverEvent{Version: ProtocolVersion, Type: eventType, Payload: struct {
				ConversationID uuid.UUID `json:"conversation_id"`
				UserID         uuid.UUID `json:"user_id"`
			}{ConversationID: conversationID, UserID: userID}})
		}
	}
}

// DeliverTypingToConversation is the application boundary used by both local
// commands and Redis pub/sub delivery. It always re-authorizes recipients from
// current conversation membership instead of trusting transport-supplied IDs.
func (h *Hub) DeliverTypingToConversation(ctx context.Context, eventType string, conversationID, userID uuid.UUID) error {
	if h.typingRecipients == nil {
		return errors.New("typing recipients unavailable")
	}
	recipientIDs, err := h.typingRecipients.ResolveTypingRecipients(ctx, userID, conversationID)
	if err != nil {
		return err
	}
	h.DeliverTyping(eventType, conversationID, userID, recipientIDs)
	return nil
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

func clientConnectionID(client Client) string {
	if identified, ok := client.(connectionIdentified); ok && identified.ConnectionID() != "" {
		return identified.ConnectionID()
	}
	return key(client.Identity())
}

func presenceConnectionID(client Client) string {
	connectionID := clientConnectionID(client)
	if connectionID == key(client.Identity()) {
		return connectionID
	}
	return client.Identity().DeviceID + ":" + connectionID
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
