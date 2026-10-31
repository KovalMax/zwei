package application

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
)

func (h *Hub) handleGroupStartAttempt(ctx context.Context, client Client, requestID, command string, conversationID, attemptID uuid.UUID) error {
	if conversationID == uuid.Nil || (command == "group.call.cancel_start" && attemptID == uuid.Nil) {
		return &RequestError{RequestID: requestID, Err: errors.New("conversation and attempt are required")}
	}
	attempts, ok := h.coord.(GroupStartAttemptCoordinator)
	if !ok || h.groupCallAuth == nil {
		return &RequestError{RequestID: requestID, Err: ErrCallUnavailable}
	}
	unlock, err := h.lockGroupConversation(ctx, conversationID)
	if err != nil {
		return &RequestError{RequestID: requestID, Err: err}
	}
	defer unlock()
	identity := client.Identity()
	owner := GroupParticipant{UserID: identity.UserID, DeviceID: identity.DeviceID, ConnectionID: clientConnectionID(client)}
	lease, err := h.groupCallAuth.BeginGroupCall(ctx, conversationID, identity.UserID)
	if err != nil {
		return &RequestError{RequestID: requestID, Err: err}
	}
	committed := false
	defer func() {
		if !committed {
			cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Second)
			defer cancel()
			_ = lease.Rollback(cleanup)
		}
	}()
	if command == "group.call.prepare_start" {
		id, expires, err := attempts.PrepareGroupRoomStart(ctx, conversationID, owner)
		if err == nil {
			err = lease.Commit(ctx)
			committed = err == nil
		}
		if err != nil {
			return &RequestError{RequestID: requestID, Err: err}
		}
		if !client.SendJSON(serverEvent{Version: ProtocolVersion, Type: "group.call.start_prepared", RequestID: requestID, Payload: struct {
			ConversationID uuid.UUID `json:"conversation_id"`
			AttemptID      uuid.UUID `json:"attempt_id"`
			ExpiresAt      time.Time `json:"expires_at"`
		}{conversationID, id, expires}}) {
			return &RequestError{RequestID: requestID, Err: ErrCallUnavailable}
		}
		return nil
	}
	room, outcome, err := attempts.CancelGroupRoomStart(ctx, conversationID, owner, attemptID)
	if err != nil {
		return &RequestError{RequestID: requestID, Err: err}
	}
	var change *GroupRoomChange
	var publishErr error
	if outcome == "retired" {
		c := GroupRoomChange{Type: "ended", Room: room, FromUserID: identity.UserID, FromDeviceID: identity.DeviceID, RecipientUserIDs: lease.ActiveMemberIDs(), Source: "start_cancelled"}
		c.ParticipantConnectionIDs = groupParticipantConnectionIDs(room)
		// Redis is authoritative once mutation succeeds. Retry publication even
		// if the request timed out; a repeated cancel can republish the tombstone.
		publishCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Second)
		publishErr = h.publishGroupRoom(publishCtx, c)
		cancel()
		change = &c
	}
	err = lease.Commit(ctx)
	committed = err == nil
	if change != nil {
		// Delivery obtains fresh membership leases and must not run while ours is held.
		if !committed {
			cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Second)
			_ = lease.Rollback(cleanup)
			cancel()
			committed = true
		}
		deliveryCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Second)
		h.deliverGroupRoomLockedContext(deliveryCtx, *change)
		cancel()
	}
	if err != nil {
		return &RequestError{RequestID: requestID, Err: err}
	}
	if publishErr != nil {
		return &RequestError{RequestID: requestID, Err: ErrCallUnavailable}
	}
	if !client.SendJSON(serverEvent{Version: ProtocolVersion, Type: "group.call.start_cancelled", RequestID: requestID, Payload: struct {
		ConversationID uuid.UUID `json:"conversation_id"`
		AttemptID      uuid.UUID `json:"attempt_id"`
		Outcome        string    `json:"outcome"`
	}{conversationID, attemptID, outcome}}) {
		return &RequestError{RequestID: requestID, Err: ErrCallUnavailable}
	}
	return nil
}
