package main

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"

	"github.com/KovalMax/zwei/services/realtime/internal/application"
	postgresinfra "github.com/KovalMax/zwei/services/realtime/internal/infrastructure/postgres"
)

type projectionCutoffOutbox struct {
	event     postgresinfra.ConversationCreatedEvent
	released  int
	processed int
}

func (o *projectionCutoffOutbox) ClaimConversationCreated(context.Context, int) ([]postgresinfra.ConversationCreatedEvent, error) {
	if o.processed != 0 {
		return nil, nil
	}
	return []postgresinfra.ConversationCreatedEvent{o.event}, nil
}

func (o *projectionCutoffOutbox) MarkProcessed(_ context.Context, event postgresinfra.ConversationCreatedEvent) error {
	if event.ID != o.event.ID {
		return errors.New("wrong outbox event")
	}
	o.processed++
	return nil
}

func (o *projectionCutoffOutbox) Release(_ context.Context, event postgresinfra.ConversationCreatedEvent) error {
	if event.ID != o.event.ID {
		return errors.New("wrong outbox event")
	}
	o.released++
	return nil
}

type projectionCutoffCoordinator struct {
	application.PresenceCoordinator
	application.GroupRoomCoordinator
	room                application.GroupRoom
	evidence            *application.GroupRoom
	terminalAttempts    int
	projectionPublishes int
}

func (c *projectionCutoffCoordinator) GetGroupRoomForConversation(context.Context, uuid.UUID) (application.GroupRoom, error) {
	if c.room.Status == application.GroupRoomEnded {
		return application.GroupRoom{}, application.ErrCallNotFound
	}
	return c.room, nil
}

func (c *projectionCutoffCoordinator) GetGroupMembershipRetirement(context.Context, uuid.UUID, int64) (application.GroupRoom, error) {
	if c.evidence == nil {
		return application.GroupRoom{}, application.ErrCallNotFound
	}
	return *c.evidence, nil
}

func (c *projectionCutoffCoordinator) EndGroupRoomForMembershipChange(context.Context, uuid.UUID, uuid.UUID, int64, int64, int64) (application.GroupRoom, error) {
	c.room.Status = application.GroupRoomEnded
	c.room.StateRevision++
	c.evidence = &c.room
	return c.room, nil
}

func (c *projectionCutoffCoordinator) PublishGroupRoom(context.Context, application.GroupRoomChange) error {
	c.terminalAttempts++
	return errors.New("terminal fanout unavailable")
}

func (c *projectionCutoffCoordinator) PublishGroupProjection(context.Context, uuid.UUID, int64, bool, []uuid.UUID) error {
	c.projectionPublishes++
	return nil
}

func TestOutboxMarksProjectionAfterEphemeralTerminalCutoff(t *testing.T) {
	user, conversation, roomID := uuid.New(), uuid.New(), uuid.New()
	coord := &projectionCutoffCoordinator{room: application.GroupRoom{ID: roomID, ConversationID: conversation, MembershipRevision: 1, Generation: 1, StateRevision: 1, Status: application.GroupRoomActive, Participants: []application.GroupParticipant{{UserID: user, DeviceID: "device", ConnectionID: "socket"}}}}
	hub := application.NewHub(nil, nil, coord, nil, nil, nil, nil)
	outbox := &projectionCutoffOutbox{event: postgresinfra.ConversationCreatedEvent{ID: uuid.New(), EventType: "group.membership.changed", ConversationID: conversation, MembershipRevision: 2, UserIDs: []uuid.UUID{user}}}
	processConversationEvents(context.Background(), outbox, hub)
	if outbox.released != 1 || outbox.processed != 0 || coord.terminalAttempts != 1 || coord.projectionPublishes != 0 {
		t.Fatalf("before cutoff: outbox=%+v terminal=%d projection=%d", outbox, coord.terminalAttempts, coord.projectionPublishes)
	}
	// Retention expired: no terminal publication is fabricated or retried.
	coord.evidence = nil
	processConversationEvents(context.Background(), outbox, hub)
	if outbox.released != 1 || outbox.processed != 1 || coord.terminalAttempts != 1 || coord.projectionPublishes != 1 {
		t.Fatalf("after cutoff: outbox=%+v terminal=%d projection=%d", outbox, coord.terminalAttempts, coord.projectionPublishes)
	}
}
