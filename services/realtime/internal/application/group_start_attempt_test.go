package application

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	sharedauth "github.com/KovalMax/zwei/services/shared/auth"
	"github.com/google/uuid"
)

type fencedTestRooms struct {
	groupTestRooms
	id           uuid.UUID
	conversation uuid.UUID
	owner        GroupParticipant
	state        string
}

type retryStartRooms struct {
	fencedTestRooms
	failPublication bool
}

func (r *retryStartRooms) PublishGroupRoom(ctx context.Context, change GroupRoomChange) error {
	if r.failPublication && change.Type == "ended" {
		r.failPublication = false
		return errors.New("publication failed")
	}
	return r.groupTestRooms.PublishGroupRoom(ctx, change)
}

func TestGroupStartCancellationRetriesTerminalPublication(t *testing.T) {
	for _, failure := range []string{"publication", "acknowledgement"} {
		t.Run(failure, func(t *testing.T) {
			user, conversation, id := uuid.New(), uuid.New(), uuid.New()
			owner := GroupParticipant{UserID: user, DeviceID: "device", ConnectionID: "original"}
			auth := &groupTestPresence{revision: 1, memberIDs: []uuid.UUID{user}}
			rooms := &retryStartRooms{fencedTestRooms: fencedTestRooms{id: id, conversation: conversation, owner: owner, state: "started", groupTestRooms: groupTestRooms{room: GroupRoom{ID: uuid.New(), ConversationID: conversation, MembershipRevision: 1, Generation: 1, StateRevision: 1, Status: GroupRoomRinging, Participants: []GroupParticipant{owner}}}}, failPublication: failure == "publication"}
			hub := NewHubWithGroupCallAuthorizer(nil, auth, auth, rooms, nil, nil, nil, nil, nil, nil)
			client := &recordingClient{identity: sharedauth.Identity{UserID: user, DeviceID: owner.DeviceID}, connectionID: "reconnected", sendFailure: failure == "acknowledgement"}
			command := func() error {
				return hub.handleGroupStartAttempt(context.Background(), client, "request", "group.call.cancel_start", conversation, id)
			}
			if err := command(); err == nil {
				t.Fatal("first cancellation unexpectedly acknowledged")
			}
			client.sendFailure = false
			if err := command(); err != nil {
				t.Fatalf("retry: %v", err)
			}
			if len(rooms.published) == 0 || rooms.published[len(rooms.published)-1].Type != "ended" || rooms.published[len(rooms.published)-1].Room.ID != rooms.room.ID {
				t.Fatalf("terminal not republished: %+v", rooms.published)
			}
			last := client.events[len(client.events)-1].(serverEvent)
			payload, err := json.Marshal(last.Payload)
			if err != nil || last.Type != "group.call.start_cancelled" || !json.Valid(payload) {
				t.Fatalf("acknowledgement = %s %s: %v", last.Type, payload, err)
			}
			var result struct {
				Outcome string `json:"outcome"`
			}
			if err := json.Unmarshal(payload, &result); err != nil || result.Outcome != "retired" {
				t.Fatalf("acknowledgement outcome=%q err=%v", result.Outcome, err)
			}
		})
	}
}

func (r *fencedTestRooms) PrepareGroupRoomStart(_ context.Context, conversation uuid.UUID, owner GroupParticipant) (uuid.UUID, time.Time, error) {
	r.id, r.conversation, r.owner, r.state = uuid.New(), conversation, owner, "prepared"
	return r.id, time.Now().Add(time.Minute), nil
}
func (r *fencedTestRooms) StartPreparedGroupRoom(ctx context.Context, room GroupRoom, token string, id uuid.UUID) (GroupRoom, error) {
	if r.state != "prepared" || id != r.id || room.ConversationID != r.conversation || len(room.Participants) != 1 || room.Participants[0] != r.owner {
		return GroupRoom{}, ErrCallNotAllowed
	}
	r.state = "started"
	return r.groupTestRooms.StartGroupRoom(ctx, room, token)
}
func (r *fencedTestRooms) CancelGroupRoomStart(_ context.Context, conversation uuid.UUID, owner GroupParticipant, id uuid.UUID) (GroupRoom, string, error) {
	if id != r.id || owner.UserID != r.owner.UserID || owner.DeviceID != r.owner.DeviceID || conversation != r.conversation {
		return GroupRoom{}, "", ErrCallNotAllowed
	}
	if r.state == "cancelled" && r.room.Status == GroupRoomEnded {
		return r.room, "retired", nil
	}
	started := r.state == "started"
	r.state = "cancelled"
	if !started {
		return GroupRoom{}, "confirmed", nil
	}
	r.room.Status = GroupRoomEnded
	r.room.StateRevision++
	return r.room, "retired", nil
}

func TestGroupStartAttemptCommands(t *testing.T) {
	user, member, conversation := uuid.New(), uuid.New(), uuid.New()
	auth := &groupTestPresence{revision: 1, memberIDs: []uuid.UUID{user, member}}
	rooms := &fencedTestRooms{}
	hub := NewHubWithGroupCallAuthorizer(nil, auth, auth, rooms, nil, nil, nil, nil, nil, nil)
	owner := &recordingClient{identity: sharedauth.Identity{UserID: user, DeviceID: "device"}, connectionID: "first"}
	peer := &recordingClient{identity: sharedauth.Identity{UserID: member, DeviceID: "peer"}, connectionID: "peer"}
	hub.Add(context.Background(), owner)
	hub.Add(context.Background(), peer)
	command := func(client Client, event string, id uuid.UUID) error {
		payload := fmt.Sprintf(`{"version":3,"type":%q,"request_id":"req","payload":{"conversation_id":%q,"attempt_id":%q}}`, event, conversation, id)
		return hub.HandleVersion(context.Background(), client, 3, []byte(payload))
	}
	if err := command(owner, "group.call.start", uuid.Nil); err == nil {
		t.Fatal("unfenced start accepted")
	}
	if err := command(owner, "group.call.prepare_start", uuid.Nil); err != nil {
		t.Fatal(err)
	}
	prepared := owner.events[len(owner.events)-1].(serverEvent)
	encoded, _ := json.Marshal(prepared.Payload)
	var payload struct {
		AttemptID      uuid.UUID `json:"attempt_id"`
		ConversationID uuid.UUID `json:"conversation_id"`
	}
	if err := json.Unmarshal(encoded, &payload); err != nil || prepared.Type != "group.call.start_prepared" || payload.AttemptID == uuid.Nil || payload.ConversationID != conversation {
		t.Fatalf("prepared = %s %s (%v)", prepared.Type, encoded, err)
	}
	sibling := &recordingClient{identity: owner.identity, connectionID: "second"}
	if err := command(sibling, "group.call.start", payload.AttemptID); err == nil {
		t.Fatal("other connection started permit")
	}
	if err := command(owner, "group.call.cancel_start", payload.AttemptID); err != nil {
		t.Fatal(err)
	}
	if err := command(owner, "group.call.start", payload.AttemptID); err == nil {
		t.Fatal("cancelled permit started")
	}
	if err := command(owner, "group.call.prepare_start", uuid.Nil); err != nil {
		t.Fatal(err)
	}
	id := rooms.id
	if err := command(owner, "group.call.start", id); err != nil {
		t.Fatal(err)
	}
	hub.Add(context.Background(), sibling)
	if err := command(sibling, "group.call.cancel_start", id); err != nil {
		t.Fatal(err)
	}
	if rooms.room.Status != GroupRoomEnded {
		t.Fatalf("room remains %s", rooms.room.Status)
	}
	if len(rooms.published) < 2 || rooms.published[len(rooms.published)-1].Type != "ended" {
		t.Fatalf("terminal not published: %+v", rooms.published)
	}
	last := sibling.events[len(sibling.events)-1].(serverEvent)
	if last.Type != "group.call.start_cancelled" {
		t.Fatalf("cancel response = %s", last.Type)
	}
	if err := command(owner, "group.call.prepare_start", uuid.Nil); err != nil {
		t.Fatal(err)
	}
	id = rooms.id
	hub.Remove(context.Background(), owner)
	if err := command(sibling, "group.call.start", id); err == nil {
		t.Fatal("reconnected sibling used disconnected socket permit")
	}
}

func TestDelayedGroupStartedAfterCancellationIsDropped(t *testing.T) {
	user, conversation, roomID := uuid.New(), uuid.New(), uuid.New()
	auth := &groupTestPresence{revision: 1, memberIDs: []uuid.UUID{user}}
	room := GroupRoom{ID: roomID, ConversationID: conversation, MembershipRevision: 1, Generation: 1, StateRevision: 1, Status: GroupRoomRinging, ExpiresAt: time.Now().Add(time.Minute), Participants: []GroupParticipant{{UserID: user, DeviceID: "device", ConnectionID: "socket"}}}
	rooms := &groupTestRooms{room: room}
	rooms.room.Status = GroupRoomEnded
	hub := NewHubWithGroupCallAuthorizer(nil, auth, auth, rooms, nil, nil, nil, nil, nil, nil)
	client := &recordingClient{identity: sharedauth.Identity{UserID: user, DeviceID: "device"}, connectionID: "socket"}
	hub.Add(context.Background(), client)
	client.events = nil
	hub.DeliverGroupRoom(context.Background(), GroupRoomChange{Type: "started", Room: room, FromUserID: user, FromDeviceID: "device", RecipientUserIDs: []uuid.UUID{user}, ParticipantConnectionIDs: groupParticipantConnectionIDs(room)})
	if len(client.events) != 0 {
		t.Fatalf("delayed start delivered: %+v", client.events)
	}
}
