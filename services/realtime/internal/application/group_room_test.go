package application

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	sharedauth "github.com/KovalMax/zwei/services/shared/auth"
)

func TestHubStartsGroupRoomOnlyForCurrentV2Member(t *testing.T) {
	userID, memberID, conversationID := uuid.New(), uuid.New(), uuid.New()
	presence := &groupTestPresence{revision: 4, memberIDs: []uuid.UUID{userID, memberID}}
	rooms := &groupTestRooms{}
	hub := NewHubWithGroupCallAuthorizer(nil, presence, presence, rooms, nil, nil, nil, nil, nil, nil)
	client := &recordingClient{identity: sharedauth.Identity{UserID: userID, DeviceID: "device"}, connectionID: "socket"}
	member := &recordingClient{identity: sharedauth.Identity{UserID: memberID, DeviceID: "member-device"}, connectionID: "member-socket"}
	hub.Add(context.Background(), client)
	hub.Add(context.Background(), member)
	member.events = nil

	err := hub.HandleVersion(context.Background(), client, 2, []byte(`{"version":2,"type":"group.call.start","request_id":"start-1","payload":{"conversation_id":"`+conversationID.String()+`"}}`))
	if err != nil {
		t.Fatalf("start group room: %v", err)
	}
	if rooms.room.ConversationID != conversationID || rooms.room.MembershipRevision != 4 || len(rooms.room.Participants) != 1 || rooms.room.Participants[0].ConnectionID != "socket" {
		t.Fatalf("room = %#v", rooms.room)
	}
	if len(member.events) != 1 {
		t.Fatalf("member events = %#v", member.events)
	}
}

func TestGroupCallStartLinearizesWithMembershipRevocation(t *testing.T) {
	ownerID, memberID, conversationID := uuid.New(), uuid.New(), uuid.New()
	order := &groupStartOrder{revision: 4, memberIDs: []uuid.UUID{ownerID, memberID}}
	rooms := &orderedGroupStartRooms{groupTestRooms: groupTestRooms{}, entered: make(chan struct{}), continueStart: make(chan struct{}), order: order}
	hub := NewHubWithGroupCallAuthorizer(nil, order, order, rooms, nil, nil, nil, nil, nil, nil)
	client := &recordingClient{identity: sharedauth.Identity{UserID: ownerID, DeviceID: "device"}, connectionID: "socket"}
	request := []byte(`{"version":2,"type":"group.call.start","request_id":"start-1","payload":{"conversation_id":"` + conversationID.String() + `"}}`)
	started := make(chan error, 1)
	go func() { started <- hub.HandleVersion(context.Background(), client, 2, request) }()
	<-rooms.entered // Redis Start is inside the held PostgreSQL-style lease.

	revocationStarted := make(chan struct{})
	revocationCommitted := make(chan struct{})
	allowProjection := make(chan struct{})
	revocationDone := make(chan error, 1)
	go func() {
		close(revocationStarted)
		revocationDone <- order.revokeAndProject(hub, conversationID, ownerID, revocationCommitted, allowProjection)
	}()
	<-revocationStarted
	select {
	case err := <-revocationDone:
		t.Fatalf("revocation passed the start lease before Redis Start completed: %v", err)
	default:
	}

	close(rooms.continueStart)
	if err := <-started; err != nil {
		t.Fatalf("start group room: %v", err)
	}
	<-revocationCommitted
	close(allowProjection)
	if err := <-revocationDone; err != nil {
		t.Fatalf("revoke after start: %v", err)
	}
	got := order.snapshot()
	if !(indexOf(got, "admission.acquire") < indexOf(got, "lease.begin") && indexOf(got, "lease.begin") < indexOf(got, "redis.start") && indexOf(got, "redis.start") < indexOf(got, "lease.commit") && indexOf(got, "lease.commit") < indexOf(got, "membership.revoke") && indexOf(got, "membership.revoke") < indexOf(got, "projection.cleanup")) {
		t.Fatalf("invalid admission/lease/start/commit ordering: %v", got)
	}
	if rooms.room.Status != GroupRoomEnded {
		t.Fatalf("projection did not clean up started room: %#v", rooms.room)
	}
}

func TestGroupCallSyncReturnsOwnedActiveSnapshotOrMinimalTerminalAck(t *testing.T) {
	ownerID, otherID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	room := GroupRoom{ID: roomID, ConversationID: conversationID, MembershipRevision: 9, Generation: 3, StateRevision: 7, Status: GroupRoomActive, Participants: []GroupParticipant{{UserID: ownerID, DeviceID: "owner-device", ConnectionID: "owner-socket"}, {UserID: otherID, DeviceID: "other-device", ConnectionID: "other-socket"}}}
	presence := &groupTestPresence{revision: 9, memberIDs: []uuid.UUID{ownerID, otherID}}
	rooms := &groupTestRooms{room: room}
	hub := NewHubWithGroupCallAuthorizer(nil, presence, presence, rooms, nil, nil, nil, nil, nil, nil)
	owner := &recordingClient{identity: sharedauth.Identity{UserID: ownerID, DeviceID: "owner-device"}, connectionID: "owner-socket"}
	request := func(roomID uuid.UUID, conversationID uuid.UUID, generation int64) []byte {
		return []byte(`{"version":2,"type":"group.call.sync","request_id":"sync-1","payload":{"conversation_id":"` + conversationID.String() + `","room_id":"` + roomID.String() + `","generation":` + fmt.Sprint(generation) + `}}`)
	}

	if err := hub.HandleVersion(context.Background(), owner, 2, request(roomID, conversationID, 3)); err != nil {
		t.Fatalf("active sync: %v", err)
	}
	active := owner.events[len(owner.events)-1].(serverEvent)
	if active.Type != "group.call.synced" || active.RequestID != "sync-1" {
		t.Fatalf("active event = %#v", active)
	}
	encoded, err := json.Marshal(active)
	if err != nil {
		t.Fatal(err)
	}
	var activeEnvelope struct {
		Payload struct {
			StateRevision int64              `json:"state_revision"`
			Participants  []GroupParticipant `json:"participants"`
			ICEServers    any                `json:"ice_servers"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(encoded, &activeEnvelope); err != nil {
		t.Fatalf("decode active snapshot: %v", err)
	}
	if activeEnvelope.Payload.StateRevision != 7 || len(activeEnvelope.Payload.Participants) != 2 || activeEnvelope.Payload.ICEServers != nil {
		t.Fatalf("active snapshot = %#v", activeEnvelope.Payload)
	}

	for _, test := range []struct {
		name         string
		room         uuid.UUID
		conversation uuid.UUID
		generation   int64
	}{
		{name: "wrong room", room: uuid.New(), conversation: conversationID, generation: 3},
		{name: "wrong conversation", room: roomID, conversation: uuid.New(), generation: 3},
		{name: "wrong generation", room: roomID, conversation: conversationID, generation: 4},
	} {
		t.Run(test.name, func(t *testing.T) {
			client := &recordingClient{identity: owner.Identity(), connectionID: owner.ConnectionID()}
			if err := hub.HandleVersion(context.Background(), client, 2, request(test.room, test.conversation, test.generation)); err != nil {
				t.Fatalf("sync: %v", err)
			}
			ack := client.events[0].(serverEvent)
			payload := ack.Payload.(struct {
				RoomID     uuid.UUID `json:"room_id"`
				Generation int64     `json:"generation"`
				Status     string    `json:"status"`
			})
			if ack.Type != "group.call.synced" || len(client.events) != 1 || payload.RoomID != test.room || payload.Generation != test.generation || payload.Status != GroupRoomEnded {
				t.Fatalf("terminal event = %#v", ack)
			}
			payloadJSON, _ := json.Marshal(ack.Payload)
			if bytes.Contains(payloadJSON, []byte("participants")) || bytes.Contains(payloadJSON, []byte("presenter")) || bytes.Contains(payloadJSON, []byte("conversation_id")) {
				t.Fatalf("terminal ack disclosed room state: %s", payloadJSON)
			}
		})
	}

	removed := &recordingClient{identity: sharedauth.Identity{UserID: otherID, DeviceID: "other-device"}, connectionID: "old-socket"}
	if err := hub.HandleVersion(context.Background(), removed, 2, request(roomID, conversationID, 3)); err != nil {
		t.Fatalf("removed socket sync: %v", err)
	}
	if len(removed.events) != 1 || removed.events[0].(serverEvent).Payload.(struct {
		RoomID     uuid.UUID `json:"room_id"`
		Generation int64     `json:"generation"`
		Status     string    `json:"status"`
	}).Status != GroupRoomEnded {
		t.Fatalf("removed socket got non-minimal response: %#v", removed.events)
	}

	stalePresence := &groupTestPresence{revision: 10, memberIDs: []uuid.UUID{ownerID, otherID}}
	staleRooms := &groupTestRooms{room: room}
	staleHub := NewHubWithGroupCallAuthorizer(nil, stalePresence, stalePresence, staleRooms, nil, nil, nil, nil, nil, nil)
	staleClient := &recordingClient{identity: owner.Identity(), connectionID: owner.ConnectionID()}
	if err := staleHub.HandleVersion(context.Background(), staleClient, 2, request(roomID, conversationID, 3)); err != nil {
		t.Fatalf("stale membership sync: %v", err)
	}
	if staleRooms.room.Status != GroupRoomEnded || staleRooms.room.Generation != 3 {
		t.Fatalf("stale membership did not conditionally end exact generation: %#v", staleRooms.room)
	}
	ack := staleClient.events[len(staleClient.events)-1].(serverEvent)
	ackPayload, _ := json.Marshal(ack.Payload)
	if ack.Type != "group.call.synced" || bytes.Contains(ackPayload, []byte("participants")) || bytes.Contains(ackPayload, []byte("presenter")) {
		t.Fatalf("stale sync response is not a minimal terminal ack: %#v", ack)
	}
}

func TestGroupCallSignalHoldsMembershipLeaseThroughFanout(t *testing.T) {
	ownerID, memberID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	order := &groupStartOrder{revision: 4, memberIDs: []uuid.UUID{ownerID, memberID}}
	room := GroupRoom{ID: roomID, ConversationID: conversationID, MembershipRevision: 4, Generation: 1, Status: GroupRoomActive, Participants: []GroupParticipant{{UserID: ownerID, DeviceID: "owner-device", ConnectionID: "owner-socket"}, {UserID: memberID, DeviceID: "member-device", ConnectionID: "member-socket"}}}
	rooms := &blockingGroupSignalRooms{groupTestRooms: groupTestRooms{room: room}, publishing: make(chan struct{}), continuePublish: make(chan struct{}), order: order}
	hub := NewHubWithGroupCallAuthorizer(nil, order, order, rooms, nil, nil, nil, nil, nil, nil)
	owner := &recordingClient{identity: sharedauth.Identity{UserID: ownerID, DeviceID: "owner-device"}, connectionID: "owner-socket"}
	member := &recordingClient{identity: sharedauth.Identity{UserID: memberID, DeviceID: "member-device"}, connectionID: "member-socket"}
	hub.Add(context.Background(), owner)
	hub.Add(context.Background(), member)
	owner.events, member.events = nil, nil
	request := []byte(`{"version":2,"type":"group.call.signal","request_id":"signal-locked","payload":{"conversation_id":"` + conversationID.String() + `","room_id":"` + roomID.String() + `","generation":1,"target_user_id":"` + memberID.String() + `","target_device_id":"member-device","signal":{"type":"offer","sdp":"opaque"}}}`)
	commandDone := make(chan error, 1)
	go func() { commandDone <- hub.HandleVersion(context.Background(), owner, 2, request) }()
	<-rooms.publishing // Redis fanout is still inside the membership lease.

	revocationCommitted := make(chan struct{})
	allowProjection := make(chan struct{})
	revocationDone := make(chan error, 1)
	go func() {
		revocationDone <- order.revokeAndProject(hub, conversationID, ownerID, revocationCommitted, allowProjection)
	}()
	select {
	case err := <-revocationDone:
		t.Fatalf("revocation passed a signal still being fanned out: %v", err)
	default:
	}
	close(rooms.continuePublish)
	if err := <-commandDone; err != nil {
		t.Fatalf("signal command: %v", err)
	}
	<-revocationCommitted
	close(allowProjection)
	if err := <-revocationDone; err != nil {
		t.Fatalf("revoke after signal: %v", err)
	}
	// Either queue-admission lease may win: revocation first means ended only;
	// enqueue first means signal followed by ended. No other order is valid.
	if len(member.events) < 1 || len(member.events) > 2 {
		t.Fatalf("target events = %#v, want ended only or signal then ended", member.events)
	}
	endedIndex := len(member.events) - 1
	endedEvent, ok := member.events[endedIndex].(serverEvent)
	if !ok || endedEvent.Type != "group.call.ended" {
		t.Fatalf("last target event = %#v, want group.call.ended", member.events[endedIndex])
	}
	if endedIndex == 1 {
		if signalEvent, ok := member.events[0].(serverEvent); !ok || signalEvent.Type != "group.call.signal" {
			t.Fatalf("first target event = %#v, want signal before terminal", member.events[0])
		}
	}
	endedPayload, err := json.Marshal(endedEvent.Payload)
	if err != nil {
		t.Fatalf("marshal ended payload: %v", err)
	}
	var endedAck struct {
		RoomID        uuid.UUID `json:"room_id"`
		Generation    int64     `json:"generation"`
		Status        string    `json:"status"`
		StateRevision int64     `json:"state_revision"`
	}
	if err := json.Unmarshal(endedPayload, &endedAck); err != nil {
		t.Fatalf("decode ended payload: %v", err)
	}
	var endedFields map[string]json.RawMessage
	if err := json.Unmarshal(endedPayload, &endedFields); err != nil {
		t.Fatalf("decode ended payload fields: %v", err)
	}
	if endedAck.RoomID != roomID || endedAck.Generation != 1 || endedAck.Status != GroupRoomEnded || endedAck.StateRevision != 1 || len(endedFields) != 4 {
		t.Fatalf("delivered ended payload = %s", endedPayload)
	}
	for index, rawEvent := range member.events {
		if event, ok := rawEvent.(serverEvent); ok && event.Type == "group.call.signal" && index > endedIndex {
			t.Fatalf("signal event at position %d followed terminal event: %#v", index, rawEvent)
		}
	}
	steps := order.snapshot()
	if !(indexOf(steps, "lease.begin") < indexOf(steps, "signal.publish") && indexOf(steps, "signal.publish") < indexOf(steps, "lease.commit") && indexOf(steps, "lease.commit") < indexOf(steps, "membership.revoke") && indexOf(steps, "membership.revoke") < indexOf(steps, "projection.cleanup")) {
		t.Fatalf("signal/revocation ordering = %v", steps)
	}
}

func TestGroupConversationLockHonorsCanceledContext(t *testing.T) {
	hub := NewHubWithGroupCallAuthorizer(nil, nil, nil, nil, nil, nil, nil, nil, nil, nil)
	conversationID := uuid.New()
	unlock, err := hub.lockGroupConversation(context.Background(), conversationID)
	if err != nil {
		t.Fatalf("acquire initial stripe: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := hub.lockGroupConversation(ctx, conversationID); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled stripe acquisition error = %v, want context.Canceled", err)
	}
	deadlineCtx, deadlineCancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer deadlineCancel()
	if err := hub.NotifyGroupProjection(deadlineCtx, conversationID, 1, false, nil); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("NotifyGroupProjection while stripe held = %v, want context.DeadlineExceeded", err)
	}

	// Cancellation must not leave a semaphore permit behind or compromise the
	// held lock; acquisition succeeds once the original owner releases it.
	unlock()
	unlock, err = hub.lockGroupConversation(context.Background(), conversationID)
	if err != nil {
		t.Fatalf("acquire stripe after release: %v", err)
	}
	unlock()
}

func TestGroupSignalQueueLeaseWinsBeforeRevocation(t *testing.T) {
	ownerID, memberID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	order := &groupStartOrder{revision: 4, memberIDs: []uuid.UUID{ownerID, memberID}}
	room := GroupRoom{ID: roomID, ConversationID: conversationID, MembershipRevision: 4, Generation: 1, Status: GroupRoomActive, Participants: []GroupParticipant{{UserID: ownerID, DeviceID: "owner-device", ConnectionID: "owner-socket"}, {UserID: memberID, DeviceID: "member-device", ConnectionID: "member-socket"}}}
	hub := NewHubWithGroupCallAuthorizer(nil, order, order, &groupTestRooms{room: room}, nil, nil, nil, nil, nil, nil)
	member := &blockingRecordingClient{recordingClient: recordingClient{identity: sharedauth.Identity{UserID: memberID, DeviceID: "member-device"}, connectionID: "member-socket"}, entered: make(chan struct{}), release: make(chan struct{})}
	hub.Add(context.Background(), member)
	member.events = nil
	signal := GroupRoomChange{Type: "signal", Room: room, FromUserID: ownerID, FromDeviceID: "owner-device", ToUserID: memberID, ToDeviceID: "member-device", Signal: json.RawMessage(`{"type":"offer","sdp":"opaque"}`), ParticipantConnectionIDs: groupParticipantConnectionIDs(room)}
	deliveryDone := make(chan struct{})
	go func() {
		hub.DeliverGroupRoom(context.Background(), signal)
		close(deliveryDone)
	}()
	<-member.entered // Target enqueue is in progress while its membership lease is held.

	revocationCommitted := make(chan struct{})
	allowProjection := make(chan struct{})
	revocationDone := make(chan error, 1)
	go func() {
		revocationDone <- order.revokeAndProject(hub, conversationID, ownerID, revocationCommitted, allowProjection)
	}()
	select {
	case <-revocationCommitted:
		t.Fatal("revocation passed the target queue-admission lease")
	default:
	}
	close(member.release)
	<-deliveryDone
	<-revocationCommitted
	close(allowProjection)
	if err := <-revocationDone; err != nil {
		t.Fatalf("revoke after admitted signal: %v", err)
	}
	if len(member.events) != 2 {
		t.Fatalf("member events = %#v, want signal then terminal", member.events)
	}
	first, firstOK := member.events[0].(serverEvent)
	second, secondOK := member.events[1].(serverEvent)
	if !firstOK || first.Type != "group.call.signal" || !secondOK || second.Type != "group.call.ended" {
		t.Fatalf("event order = %#v, want signal followed by ended", member.events)
	}
}

type blockingGroupSignalRooms struct {
	groupTestRooms
	publishing      chan struct{}
	continuePublish chan struct{}
	order           *groupStartOrder
}

func (r *blockingGroupSignalRooms) PublishGroupRoom(ctx context.Context, change GroupRoomChange) error {
	if change.Type == "signal" {
		close(r.publishing)
		// The command owns order.mu through its lease, so append under that lock.
		r.order.steps = append(r.order.steps, "signal.publish")
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-r.continuePublish:
			return nil
		}
	}
	return nil
}

func indexOf(values []string, value string) int {
	for index, candidate := range values {
		if candidate == value {
			return index
		}
	}
	return len(values)
}

func TestGroupCallStartAfterProjectionCleanupIsRejected(t *testing.T) {
	ownerID, conversationID := uuid.New(), uuid.New()
	presence := &revokedGroupStartPresence{groupTestPresence: groupTestPresence{revision: 5}}
	rooms := &groupTestRooms{}
	hub := NewHubWithGroupCallAuthorizer(nil, presence, presence, rooms, nil, nil, nil, nil, nil, nil)
	client := &recordingClient{identity: sharedauth.Identity{UserID: ownerID, DeviceID: "device"}, connectionID: "socket"}
	err := hub.HandleVersion(context.Background(), client, 2, []byte(`{"version":2,"type":"group.call.start","request_id":"start-2","payload":{"conversation_id":"`+conversationID.String()+`"}}`))
	if !errors.Is(err, ErrCallNotAllowed) {
		t.Fatalf("start after committed revocation = %v, want not allowed", err)
	}
	if rooms.room.ID != uuid.Nil {
		t.Fatalf("stale room was created after projection cleanup: %#v", rooms.room)
	}
}

func TestGroupCallCommandRejectsMemberRemovedBeforeLease(t *testing.T) {
	userID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New()
	removed := &revokedGroupStartPresence{groupTestPresence: groupTestPresence{revision: 6}}
	rooms := &groupTestRooms{room: GroupRoom{ID: roomID, ConversationID: conversationID, MembershipRevision: 5, Generation: 1, Status: GroupRoomActive, Participants: []GroupParticipant{{UserID: userID, DeviceID: "device", ConnectionID: "socket"}}}}
	hub := NewHubWithGroupCallAuthorizer(nil, removed, removed, rooms, nil, nil, nil, nil, nil, nil)
	client := &recordingClient{identity: sharedauth.Identity{UserID: userID, DeviceID: "device"}, connectionID: "socket"}
	request := []byte(`{"version":2,"type":"group.call.end","request_id":"revoked-end","payload":{"conversation_id":"` + conversationID.String() + `","room_id":"` + roomID.String() + `","generation":1}}`)
	if err := hub.HandleVersion(context.Background(), client, 2, request); !errors.Is(err, ErrCallNotAllowed) {
		t.Fatalf("removed member command error = %v, want not allowed", err)
	}
	if rooms.mutationCalls != 0 {
		t.Fatalf("removed member caused %d Redis mutations", rooms.mutationCalls)
	}
}

func TestGroupCallJoinPubSubFailureCommitsLeaseAndDeliversLocalSnapshot(t *testing.T) {
	userID, peerID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	lease := &trackedGroupCallLease{revision: 3, members: []uuid.UUID{userID, peerID}}
	publishErr := errors.New("fanout unavailable")
	rooms := &failingJoinGroupRoomPublisher{
		failingGroupRoomPublisher: failingGroupRoomPublisher{
			groupTestRooms: groupTestRooms{room: GroupRoom{ID: roomID, ConversationID: conversationID, MembershipRevision: 3, Generation: 1, Status: GroupRoomActive, Participants: []GroupParticipant{{UserID: peerID, DeviceID: "peer-device", ConnectionID: "peer-socket"}}}},
			publishErr:     publishErr,
		},
	}
	hub := NewHubWithGroupCallAuthorizer(nil, &groupTestPresence{}, &commandThenDeliveryAuthorizer{commandLease: lease, deliveryRevision: 3, deliveryMembers: []uuid.UUID{userID, peerID}}, rooms, nil, nil, nil, nil, nil, nil)
	client := &recordingClient{identity: sharedauth.Identity{UserID: userID, DeviceID: "device"}, connectionID: "socket"}
	hub.Add(context.Background(), client)
	client.events = nil
	request := []byte(`{"version":2,"type":"group.call.join","request_id":"publisher-failure","payload":{"conversation_id":"` + conversationID.String() + `","room_id":"` + roomID.String() + `","generation":1}}`)
	if err := hub.HandleVersion(context.Background(), client, 2, request); err != nil {
		t.Fatalf("join error = %v, want accepted despite Pub/Sub failure", err)
	}
	if !lease.committed || lease.rolledBack {
		t.Fatalf("lease committed=%v rolled_back=%v, want commit only", lease.committed, lease.rolledBack)
	}
	if len(client.events) != 1 {
		t.Fatalf("local events = %#v, want committed room snapshot", client.events)
	}
	event, ok := client.events[0].(serverEvent)
	if !ok || event.Type != "group.call.participant.joined" {
		t.Fatalf("local event = %#v, want participant.joined snapshot", client.events[0])
	}
	encoded, err := json.Marshal(event.Payload)
	if err != nil || !bytes.Contains(encoded, []byte(userID.String())) {
		t.Fatalf("local snapshot = %s, err=%v; want joining user", encoded, err)
	}
}

type failingJoinGroupRoomPublisher struct{ failingGroupRoomPublisher }

func (r *failingJoinGroupRoomPublisher) JoinGroupRoom(_ context.Context, _ uuid.UUID, participant GroupParticipant, _ int64, _ string) (GroupRoom, error) {
	r.mutationCalls++
	r.room.Participants = append(r.room.Participants, participant)
	r.room.StateRevision++
	return r.room, nil
}

func TestGroupCallPresenterAndEndUseLocalFallbackAfterPubSubFailure(t *testing.T) {
	for _, test := range []struct {
		name, command, wantEvent string
	}{
		{
			name:      "presenter",
			command:   "group.call.presenter.start",
			wantEvent: "group.call.presenter.start",
		},
		{
			name:      "end",
			command:   "group.call.end",
			wantEvent: "group.call.ended",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			userID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New()
			lease := &trackedGroupCallLease{revision: 3, members: []uuid.UUID{userID}}
			rooms := &failingGroupRoomPublisher{groupTestRooms: groupTestRooms{room: GroupRoom{
				ID: roomID, ConversationID: conversationID, MembershipRevision: 3, Generation: 1,
				Status:       GroupRoomActive,
				Participants: []GroupParticipant{{UserID: userID, DeviceID: "device", ConnectionID: "socket"}},
			}}, publishErr: errors.New("fanout unavailable")}
			mutatingRooms := &fallbackGroupRoomPublisher{failingGroupRoomPublisher: rooms}
			hub := NewHubWithGroupCallAuthorizer(nil, &groupTestPresence{}, &commandThenDeliveryAuthorizer{commandLease: lease, deliveryRevision: 3, deliveryMembers: []uuid.UUID{userID}}, mutatingRooms, nil, nil, nil, nil, nil, nil)
			client := &recordingClient{identity: sharedauth.Identity{UserID: userID, DeviceID: "device"}, connectionID: "socket"}
			hub.Add(context.Background(), client)
			client.events = nil
			request := []byte(`{"version":2,"type":"` + test.command + `","request_id":"fallback","payload":{"conversation_id":"` + conversationID.String() + `","room_id":"` + roomID.String() + `","generation":1}}`)
			if err := hub.HandleVersion(context.Background(), client, 2, request); err != nil {
				t.Fatalf("command error = %v, want accepted", err)
			}
			if !lease.committed || lease.rolledBack {
				t.Fatalf("lease committed=%v rolled_back=%v", lease.committed, lease.rolledBack)
			}
			if len(client.events) != 1 {
				t.Fatalf("local events = %#v, want fallback snapshot", client.events)
			}
			event, ok := client.events[0].(serverEvent)
			if !ok || event.Type != test.wantEvent {
				t.Fatalf("local event = %#v, want %q", client.events[0], test.wantEvent)
			}
		})
	}
}

func TestGroupCallSignalPubSubFailureRemainsRejectedWithoutLocalDelivery(t *testing.T) {
	userID, targetID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	lease := &trackedGroupCallLease{revision: 3, members: []uuid.UUID{userID, targetID}}
	rooms := &failingGroupRoomPublisher{
		groupTestRooms: groupTestRooms{room: GroupRoom{
			ID: roomID, ConversationID: conversationID, MembershipRevision: 3, Generation: 1, Status: GroupRoomActive,
			Participants: []GroupParticipant{{UserID: userID, DeviceID: "device", ConnectionID: "socket"}, {UserID: targetID, DeviceID: "target-device", ConnectionID: "target-socket"}},
		}},
		publishErr: errors.New("fanout unavailable"),
	}
	hub := NewHubWithGroupCallAuthorizer(nil, &groupTestPresence{}, trackedGroupCallAuthorizer{lease: lease}, rooms, nil, nil, nil, nil, nil, nil)
	client := &recordingClient{identity: sharedauth.Identity{UserID: targetID, DeviceID: "target-device"}, connectionID: "target-socket"}
	hub.Add(context.Background(), client)
	client.events = nil
	request := []byte(`{"version":2,"type":"group.call.signal","request_id":"signal-failure","payload":{"conversation_id":"` + conversationID.String() + `","room_id":"` + roomID.String() + `","generation":1,"target_user_id":"` + targetID.String() + `","target_device_id":"target-device","signal":{"type":"offer","sdp":"opaque"}}}`)
	if err := hub.HandleVersion(context.Background(), &recordingClient{identity: sharedauth.Identity{UserID: userID, DeviceID: "device"}, connectionID: "socket"}, 2, request); !errors.Is(err, rooms.publishErr) {
		t.Fatalf("signal error = %v, want Pub/Sub failure", err)
	}
	if len(client.events) != 0 {
		t.Fatalf("remote signal delivery = %#v, want none", client.events)
	}
	if lease.committed || !lease.rolledBack {
		t.Fatalf("lease committed=%v rolled_back=%v, want rollback", lease.committed, lease.rolledBack)
	}
}

func TestGroupCallJoinMutationFailureOrCancellationDoesNotDeliverLocally(t *testing.T) {
	for _, test := range []struct {
		name      string
		cancel    bool
		wantError error
	}{
		{name: "redis mutation error", wantError: errors.New("redis mutation failed")},
		{name: "canceled after mutation", cancel: true, wantError: context.Canceled},
	} {
		t.Run(test.name, func(t *testing.T) {
			userID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New()
			lease := &trackedGroupCallLease{revision: 3, members: []uuid.UUID{userID}}
			mutationErr := test.wantError
			if test.cancel {
				mutationErr = nil
			}
			rooms := &failedJoinGroupRoomPublisher{groupTestRooms: groupTestRooms{room: GroupRoom{
				ID: roomID, ConversationID: conversationID, MembershipRevision: 3, Generation: 1, Status: GroupRoomActive,
				Participants: []GroupParticipant{{UserID: userID, DeviceID: "device", ConnectionID: "socket"}},
			}}, mutationErr: mutationErr}
			ctx, cancel := context.WithCancel(context.Background())
			if test.cancel {
				rooms.cancel = cancel
			}
			defer cancel()
			hub := NewHubWithGroupCallAuthorizer(nil, &groupTestPresence{}, trackedGroupCallAuthorizer{lease: lease}, rooms, nil, nil, nil, nil, nil, nil)
			client := &recordingClient{identity: sharedauth.Identity{UserID: userID, DeviceID: "device"}, connectionID: "socket"}
			hub.Add(context.Background(), client)
			client.events = nil
			request := []byte(`{"version":2,"type":"group.call.join","request_id":"mutation-failure","payload":{"conversation_id":"` + conversationID.String() + `","room_id":"` + roomID.String() + `","generation":1}}`)
			if err := hub.HandleVersion(ctx, client, 2, request); !errors.Is(err, test.wantError) {
				t.Fatalf("join error = %v, want %v", err, test.wantError)
			}
			if len(client.events) != 0 {
				t.Fatalf("local delivery after unsuccessful/canceled mutation = %#v, want none", client.events)
			}
			if lease.committed || !lease.rolledBack {
				t.Fatalf("lease committed=%v rolled_back=%v", lease.committed, lease.rolledBack)
			}
		})
	}
}

type fallbackGroupRoomPublisher struct{ *failingGroupRoomPublisher }

type failedJoinGroupRoomPublisher struct {
	groupTestRooms
	mutationErr error
	cancel      context.CancelFunc
}

func (r *failedJoinGroupRoomPublisher) JoinGroupRoom(_ context.Context, _ uuid.UUID, _ GroupParticipant, _ int64, _ string) (GroupRoom, error) {
	if r.cancel != nil {
		r.cancel()
	}
	return r.room, r.mutationErr
}

type commandThenDeliveryAuthorizer struct {
	commandLease     *trackedGroupCallLease
	deliveryRevision int64
	deliveryMembers  []uuid.UUID
	called           bool
}

func (a *commandThenDeliveryAuthorizer) BeginGroupCall(context.Context, uuid.UUID, uuid.UUID) (GroupCallLease, error) {
	if !a.called {
		a.called = true
		return a.commandLease, nil
	}
	return &trackedGroupCallLease{revision: a.deliveryRevision, members: a.deliveryMembers}, nil
}

func (r *fallbackGroupRoomPublisher) SetGroupPresenter(_ context.Context, _ uuid.UUID, participant GroupParticipant, enabled bool) (GroupRoom, error) {
	r.mutationCalls++
	if enabled {
		r.room.Presenter = &participant
	} else {
		r.room.Presenter = nil
	}
	r.room.StateRevision++
	return r.room, nil
}

func (r *fallbackGroupRoomPublisher) EndGroupRoom(_ context.Context, _ uuid.UUID, _ GroupParticipant) (GroupRoom, error) {
	r.mutationCalls++
	room := r.room
	room.Status = GroupRoomEnded
	room.StateRevision++
	room.Participants = nil
	return room, nil
}

func TestGroupCallEnqueuesLocallyOnlyAfterFanoutAndLeaseRelease(t *testing.T) {
	userID, targetID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	lease := &trackedGroupCallLease{revision: 3, members: []uuid.UUID{userID, targetID}}
	room := GroupRoom{ID: roomID, ConversationID: conversationID, MembershipRevision: 3, Generation: 1, Status: GroupRoomActive, Participants: []GroupParticipant{{UserID: userID, DeviceID: "device", ConnectionID: "socket"}, {UserID: targetID, DeviceID: "target-device", ConnectionID: "target-socket"}}}
	rooms := &leaseObservingPublisher{groupTestRooms: groupTestRooms{room: room}, lease: lease}
	hub := NewHubWithGroupCallAuthorizer(nil, &groupTestPresence{}, trackedGroupCallAuthorizer{lease: lease}, rooms, nil, nil, nil, nil, nil, nil)
	client := &leaseCheckingClient{recordingClient: recordingClient{identity: sharedauth.Identity{UserID: targetID, DeviceID: "target-device"}, connectionID: "target-socket"}, lease: lease}
	hub.Add(context.Background(), client)
	client.events = nil
	owner := &recordingClient{identity: sharedauth.Identity{UserID: userID, DeviceID: "device"}, connectionID: "socket"}
	request := []byte(`{"version":2,"type":"group.call.presenter.start","request_id":"lease-order","payload":{"conversation_id":"` + conversationID.String() + `","room_id":"` + roomID.String() + `","generation":1}}`)
	if err := hub.HandleVersion(context.Background(), owner, 2, request); err != nil {
		t.Fatalf("group call command: %v", err)
	}
	if !rooms.publishedWhileLeased {
		t.Fatal("PubSub was not accepted while the PostgreSQL-style membership lease was held")
	}
	if !client.deliveredAfterRelease {
		t.Fatal("local socket enqueue did not happen after lease commit")
	}
	if len(client.events) != 1 {
		t.Fatalf("local events = %#v, want one", client.events)
	}
}

func TestGroupCommandLocalSignalPrecedesCommittedRevocationProjection(t *testing.T) {
	ownerID, memberID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	lease := &commitNotifyingLease{trackedGroupCallLease: trackedGroupCallLease{revision: 3, members: []uuid.UUID{ownerID, memberID}}, committed: make(chan struct{})}
	room := GroupRoom{ID: roomID, ConversationID: conversationID, MembershipRevision: 3, Generation: 1, Status: GroupRoomActive, Participants: []GroupParticipant{{UserID: ownerID, DeviceID: "owner-device", ConnectionID: "owner-socket"}, {UserID: memberID, DeviceID: "member-device", ConnectionID: "member-socket"}}}
	hub := NewHubWithGroupCallAuthorizer(nil, &groupTestPresence{}, commitNotifyingAuthorizer{lease: lease}, &groupTestRooms{room: room}, nil, nil, nil, nil, nil, nil)
	owner := &recordingClient{identity: sharedauth.Identity{UserID: ownerID, DeviceID: "owner-device"}, connectionID: "owner-socket"}
	member := &blockingRecordingClient{recordingClient: recordingClient{identity: sharedauth.Identity{UserID: memberID, DeviceID: "member-device"}, connectionID: "member-socket"}, entered: make(chan struct{}), release: make(chan struct{})}
	hub.Add(context.Background(), owner)
	hub.Add(context.Background(), member)
	owner.events, member.events = nil, nil
	request := []byte(`{"version":2,"type":"group.call.signal","request_id":"ordered-signal","payload":{"conversation_id":"` + conversationID.String() + `","room_id":"` + roomID.String() + `","generation":1,"target_user_id":"` + memberID.String() + `","target_device_id":"member-device","signal":{"type":"offer","sdp":"opaque-test-sdp"}}}`)
	commandDone := make(chan error, 1)
	go func() { commandDone <- hub.HandleVersion(context.Background(), owner, 2, request) }()
	<-lease.committed
	<-member.entered // the lease is committed, but the command still owns the stripe while enqueueing.
	projectionDone := make(chan struct{})
	go func() {
		hub.DeliverGroupProjection(context.Background(), conversationID, 4, false, []uuid.UUID{memberID})
		close(projectionDone)
	}()
	close(member.release)
	if err := <-commandDone; err != nil {
		t.Fatalf("signal command: %v", err)
	}
	<-projectionDone
	if len(member.events) != 2 {
		t.Fatalf("member events = %#v, want signal then membership projection", member.events)
	}
	signal, ok := member.events[0].(serverEvent)
	if !ok || signal.Type != "group.call.signal" {
		t.Fatalf("first event = %#v, want signal", member.events[0])
	}
	payload, err := json.Marshal(signal.Payload)
	if err != nil || !bytes.Contains(payload, []byte(`"sdp":"opaque-test-sdp"`)) {
		t.Fatalf("signal payload = %s, err=%v", payload, err)
	}
	projection, ok := member.events[1].(serverEvent)
	if !ok || projection.Type != "group.membership.changed" {
		t.Fatalf("second event = %#v, want membership projection", member.events[1])
	}
}

func TestHubDropsStalePubSubGroupSignalAfterCommittedRevocation(t *testing.T) {
	ownerID, memberID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	current := &trackedGroupCallLease{revision: 4, members: []uuid.UUID{ownerID, memberID}}
	hub := NewHubWithGroupCallAuthorizer(nil, &groupTestPresence{}, trackedGroupCallAuthorizer{lease: current}, &groupTestRooms{}, nil, nil, nil, nil, nil, nil)
	member := &recordingClient{identity: sharedauth.Identity{UserID: memberID, DeviceID: "member-device"}, connectionID: "member-socket"}
	hub.Add(context.Background(), member)
	member.events = nil
	room := GroupRoom{ID: roomID, ConversationID: conversationID, MembershipRevision: 3, Generation: 1, Status: GroupRoomActive, Participants: []GroupParticipant{{UserID: ownerID, DeviceID: "owner-device", ConnectionID: "owner-socket"}, {UserID: memberID, DeviceID: "member-device", ConnectionID: "member-socket"}}}
	hub.DeliverGroupRoom(context.Background(), GroupRoomChange{Type: "signal", Room: room, FromUserID: ownerID, FromDeviceID: "owner-device", ToUserID: memberID, ToDeviceID: "member-device", Signal: json.RawMessage(`{"type":"offer","sdp":"stale-secret"}`), ParticipantConnectionIDs: groupParticipantConnectionIDs(room)})
	if len(member.events) != 0 {
		t.Fatalf("stale room event delivered after revision advanced: %#v", member.events)
	}
}

type commitNotifyingLease struct {
	trackedGroupCallLease
	committed chan struct{}
}

type commitNotifyingAuthorizer struct{ lease *commitNotifyingLease }

func (a commitNotifyingAuthorizer) BeginGroupCall(context.Context, uuid.UUID, uuid.UUID) (GroupCallLease, error) {
	return a.lease, nil
}

func (l *commitNotifyingLease) Commit(context.Context) error {
	l.trackedGroupCallLease.Commit(context.Background())
	close(l.committed)
	return nil
}

type blockingRecordingClient struct {
	recordingClient
	entered chan struct{}
	release chan struct{}
}

func (c *blockingRecordingClient) SendJSON(event any) bool {
	if value, ok := event.(serverEvent); ok && value.Type == "group.call.signal" {
		close(c.entered)
		<-c.release
	}
	return c.recordingClient.SendJSON(event)
}

type leaseObservingPublisher struct {
	groupTestRooms
	lease                *trackedGroupCallLease
	publishedWhileLeased bool
}

func (r *leaseObservingPublisher) PublishGroupRoom(context.Context, GroupRoomChange) error {
	r.publishedWhileLeased = !r.lease.committed && !r.lease.rolledBack
	return nil
}

type leaseCheckingClient struct {
	recordingClient
	lease                 *trackedGroupCallLease
	deliveredAfterRelease bool
}

func (c *leaseCheckingClient) SendJSON(event any) bool {
	c.deliveredAfterRelease = c.lease.committed
	return c.recordingClient.SendJSON(event)
}

type trackedGroupCallAuthorizer struct{ lease *trackedGroupCallLease }

func (a trackedGroupCallAuthorizer) BeginGroupCall(context.Context, uuid.UUID, uuid.UUID) (GroupCallLease, error) {
	return a.lease, nil
}

type trackedGroupCallLease struct {
	revision   int64
	members    []uuid.UUID
	committed  bool
	rolledBack bool
}

func (l *trackedGroupCallLease) MembershipRevision() int64    { return l.revision }
func (l *trackedGroupCallLease) ActiveMemberIDs() []uuid.UUID { return l.members }
func (l *trackedGroupCallLease) Commit(context.Context) error {
	l.committed = true
	return nil
}
func (l *trackedGroupCallLease) Rollback(context.Context) error {
	l.rolledBack = true
	return nil
}

type failingGroupRoomPublisher struct {
	groupTestRooms
	publishErr error
}

func (r *failingGroupRoomPublisher) PublishGroupRoom(context.Context, GroupRoomChange) error {
	return r.publishErr
}

func TestGroupCallStartCommitErrorCleansOnlyAttemptedRoom(t *testing.T) {
	ownerID, conversationID, newerRoomID := uuid.New(), uuid.New(), uuid.New()
	presence := &commitErrorGroupStartAuthorizer{groupTestPresence: groupTestPresence{revision: 9, memberIDs: []uuid.UUID{ownerID}}}
	rooms := &groupTestRooms{newerRoom: GroupRoom{ID: newerRoomID, Generation: 2, Status: GroupRoomActive}}
	hub := NewHubWithGroupCallAuthorizer(nil, presence, presence, rooms, nil, nil, nil, nil, nil, nil)
	client := &recordingClient{identity: sharedauth.Identity{UserID: ownerID, DeviceID: "device"}, connectionID: "socket"}
	err := hub.HandleVersion(context.Background(), client, 2, []byte(`{"version":2,"type":"group.call.start","request_id":"commit-failure","payload":{"conversation_id":"`+conversationID.String()+`"}}`))
	if err == nil {
		t.Fatal("expected commit failure")
	}
	if rooms.abortedRoom == uuid.Nil || rooms.abortedRoom == newerRoomID || rooms.abortCalls != 1 {
		t.Fatalf("abort room=%s calls=%d newer=%s", rooms.abortedRoom, rooms.abortCalls, newerRoomID)
	}
	if rooms.room.Status != GroupRoomEnded || rooms.room.ID != rooms.abortedRoom {
		t.Fatalf("attempted room not ended: %#v", rooms.room)
	}
	if rooms.newerRoom.ID != newerRoomID || rooms.newerRoom.Status != GroupRoomActive || rooms.newerRoom.Generation != 2 {
		t.Fatalf("newer room was affected: %#v", rooms.newerRoom)
	}
}

func TestGroupCallStartCancellationReleasesAdmissionAndLease(t *testing.T) {
	ownerID, conversationID := uuid.New(), uuid.New()
	presence := &cancelGroupStartAuthorizer{groupTestPresence: groupTestPresence{revision: 2, memberIDs: []uuid.UUID{ownerID}}}
	rooms := &cancelGroupStartRooms{}
	hub := NewHubWithGroupCallAuthorizer(nil, presence, presence, rooms, nil, nil, nil, nil, nil, nil)
	client := &recordingClient{identity: sharedauth.Identity{UserID: ownerID, DeviceID: "device"}, connectionID: "socket"}
	err := hub.HandleVersion(context.Background(), client, 2, []byte(`{"version":2,"type":"group.call.start","request_id":"cancel","payload":{"conversation_id":"`+conversationID.String()+`"}}`))
	if err == nil || !errors.Is(err, context.Canceled) {
		t.Fatalf("start error = %v, want cancellation", err)
	}
	if !presence.rolledBack || rooms.releaseCalls != 1 || rooms.abortCalls != 1 {
		t.Fatalf("rollback=%v release=%d cleanup=%d", presence.rolledBack, rooms.releaseCalls, rooms.abortCalls)
	}
}

type cancelGroupStartAuthorizer struct {
	groupTestPresence
	rolledBack bool
}

func (a *cancelGroupStartAuthorizer) BeginGroupCall(context.Context, uuid.UUID, uuid.UUID) (GroupCallLease, error) {
	return &cancellableGroupStartLease{owner: a}, nil
}

type cancellableGroupStartLease struct{ owner *cancelGroupStartAuthorizer }

func (l *cancellableGroupStartLease) MembershipRevision() int64    { return l.owner.revision }
func (l *cancellableGroupStartLease) ActiveMemberIDs() []uuid.UUID { return l.owner.memberIDs }
func (*cancellableGroupStartLease) Commit(context.Context) error   { return nil }
func (l *cancellableGroupStartLease) Rollback(context.Context) error {
	l.owner.rolledBack = true
	return nil
}

type commitErrorGroupStartAuthorizer struct{ groupTestPresence }

func (a *commitErrorGroupStartAuthorizer) BeginGroupCall(context.Context, uuid.UUID, uuid.UUID) (GroupCallLease, error) {
	return commitErrorGroupStartLease{revision: a.revision, members: a.memberIDs}, nil
}

type commitErrorGroupStartLease struct {
	revision int64
	members  []uuid.UUID
}

func (l commitErrorGroupStartLease) MembershipRevision() int64    { return l.revision }
func (l commitErrorGroupStartLease) ActiveMemberIDs() []uuid.UUID { return l.members }
func (commitErrorGroupStartLease) Commit(context.Context) error {
	return errors.New("commit outcome unknown")
}
func (commitErrorGroupStartLease) Rollback(context.Context) error { return nil }

type cancelGroupStartRooms struct {
	groupTestRooms
	releaseCalls int
	abortCalls   int
}

func (r *cancelGroupStartRooms) StartGroupRoom(_ context.Context, room GroupRoom, _ string) (GroupRoom, error) {
	r.room = room
	return GroupRoom{}, context.Canceled
}

func (r *cancelGroupStartRooms) AcquireCallAdmission(context.Context, []uuid.UUID) (string, error) {
	return "admission", nil
}
func (r *cancelGroupStartRooms) ReleaseCallAdmission(context.Context, []uuid.UUID, string) {
	r.releaseCalls++
}
func (r *cancelGroupStartRooms) AbortGroupRoomStart(_ context.Context, roomID uuid.UUID, _ int64, _ GroupParticipant) error {
	r.abortCalls++
	r.abortedRoom = roomID
	return nil
}

type groupStartOrder struct {
	mu        sync.Mutex
	revision  int64
	memberIDs []uuid.UUID
	steps     []string
}

func (o *groupStartOrder) record(step string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.steps = append(o.steps, step)
}

func (o *groupStartOrder) snapshot() []string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return append([]string(nil), o.steps...)
}

func (o *groupStartOrder) PeerIDs(context.Context, uuid.UUID) ([]uuid.UUID, error) { return nil, nil }
func (o *groupStartOrder) RecipientID(context.Context, uuid.UUID, uuid.UUID) (uuid.UUID, error) {
	return uuid.Nil, nil
}
func (o *groupStartOrder) BeginGroupCall(context.Context, uuid.UUID, uuid.UUID) (GroupCallLease, error) {
	o.record("lease.begin")
	o.mu.Lock()
	return &orderedGroupStartLease{order: o, revision: o.revision, members: append([]uuid.UUID(nil), o.memberIDs...)}, nil
}

func (o *groupStartOrder) revokeAndProject(hub *Hub, conversationID, retainedMemberID uuid.UUID, committed chan struct{}, allowProjection <-chan struct{}) error {
	o.mu.Lock() // waits for the start lease's Commit/Rollback
	o.revision++
	o.memberIDs = []uuid.UUID{retainedMemberID}
	o.steps = append(o.steps, "membership.revoke")
	o.mu.Unlock()
	close(committed)
	<-allowProjection
	if err := hub.NotifyGroupProjection(context.Background(), conversationID, o.revision, false, o.memberIDs); err != nil {
		return err
	}
	o.record("projection.cleanup")
	return nil
}

type orderedGroupStartLease struct {
	order    *groupStartOrder
	revision int64
	members  []uuid.UUID
}

func (l *orderedGroupStartLease) MembershipRevision() int64    { return l.revision }
func (l *orderedGroupStartLease) ActiveMemberIDs() []uuid.UUID { return l.members }
func (l *orderedGroupStartLease) Commit(context.Context) error {
	l.order.steps = append(l.order.steps, "lease.commit")
	l.order.mu.Unlock()
	return nil
}
func (l *orderedGroupStartLease) Rollback(context.Context) error {
	l.order.mu.Unlock()
	return nil
}

type orderedGroupStartRooms struct {
	groupTestRooms
	entered       chan struct{}
	continueStart chan struct{}
	order         *groupStartOrder
}

func (r *orderedGroupStartRooms) StartGroupRoom(ctx context.Context, room GroupRoom, token string) (GroupRoom, error) {
	close(r.entered)
	select {
	case <-ctx.Done():
		return GroupRoom{}, ctx.Err()
	case <-r.continueStart:
	}
	r.order.steps = append(r.order.steps, "redis.start")
	return r.groupTestRooms.StartGroupRoom(ctx, room, token)
}

func (r *orderedGroupStartRooms) AcquireCallAdmission(ctx context.Context, ids []uuid.UUID) (string, error) {
	r.order.record("admission.acquire")
	return r.groupTestRooms.AcquireCallAdmission(ctx, ids)
}

func (r *orderedGroupStartRooms) ReleaseCallAdmission(ctx context.Context, ids []uuid.UUID, token string) {
	r.order.record("admission.release")
	r.groupTestRooms.ReleaseCallAdmission(ctx, ids, token)
}

type revokedGroupStartPresence struct{ groupTestPresence }

func (p *revokedGroupStartPresence) BeginGroupCall(context.Context, uuid.UUID, uuid.UUID) (GroupCallLease, error) {
	return nil, ErrCallNotAllowed
}

func TestHubQueuesGroupStartForInitiatorBeforeMembers(t *testing.T) {
	ownerID, memberID, conversationID := uuid.New(), uuid.New(), uuid.New()
	presence := &groupTestPresence{revision: 4, memberIDs: []uuid.UUID{ownerID, memberID}}
	rooms := &groupTestRooms{}
	hub := NewHubWithGroupCallAuthorizer(nil, presence, presence, rooms, nil, nil, nil, nil, nil, nil)
	var deliveryOrder []string
	owner := &orderedRecordingClient{recordingClient: recordingClient{identity: sharedauth.Identity{UserID: ownerID, DeviceID: "owner-device"}, connectionID: "owner-socket"}, delivered: &deliveryOrder, name: "owner"}
	member := &orderedRecordingClient{recordingClient: recordingClient{identity: sharedauth.Identity{UserID: memberID, DeviceID: "member-device"}, connectionID: "member-socket"}, delivered: &deliveryOrder, name: "member"}
	hub.Add(context.Background(), owner)
	hub.Add(context.Background(), member)
	deliveryOrder = nil

	if err := hub.HandleVersion(context.Background(), owner, 2, []byte(`{"version":2,"type":"group.call.start","request_id":"start-1","payload":{"conversation_id":"`+conversationID.String()+`"}}`)); err != nil {
		t.Fatalf("start group room: %v", err)
	}
	if got, want := deliveryOrder, []string{"owner:group.call.started", "member:group.call.started"}; !equalStrings(got, want) {
		t.Fatalf("delivery order = %v, want %v", got, want)
	}
}

func TestHubRejectsGroupSignalFromSiblingSocket(t *testing.T) {
	userID, targetID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	rooms := &groupTestRooms{room: GroupRoom{ID: roomID, ConversationID: conversationID, MembershipRevision: 2, Generation: 1, Status: GroupRoomActive, Participants: []GroupParticipant{{UserID: userID, DeviceID: "device", ConnectionID: "owner"}, {UserID: targetID, DeviceID: "target", ConnectionID: "target-owner"}}}}
	hub := NewHub(nil, &groupTestPresence{revision: 2}, rooms, nil, nil, nil, nil)
	client := &recordingClient{identity: sharedauth.Identity{UserID: userID, DeviceID: "device"}, connectionID: "sibling"}

	err := hub.HandleVersion(context.Background(), client, 2, []byte(`{"version":2,"type":"group.call.signal","request_id":"signal-1","payload":{"conversation_id":"`+conversationID.String()+`","room_id":"`+roomID.String()+`","generation":1,"target_user_id":"`+targetID.String()+`","target_device_id":"target","signal":{"type":"offer","sdp":"safe"}}}`))
	if err == nil || err.Error() != ErrCallNotAllowed.Error() {
		t.Fatalf("signal error = %v", err)
	}
}

func TestHubRejectsGroupRoomActionsForDifferentConversation(t *testing.T) {
	userID, targetID, actualConversationID, suppliedConversationID, roomID := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	for _, action := range []string{"group.call.join", "group.call.leave", "group.call.end", "group.call.presenter.start", "group.call.signal"} {
		t.Run(action, func(t *testing.T) {
			rooms := &groupTestRooms{room: GroupRoom{ID: roomID, ConversationID: actualConversationID, MembershipRevision: 2, Generation: 1, Status: GroupRoomActive, Participants: []GroupParticipant{{UserID: userID, DeviceID: "device", ConnectionID: "socket"}, {UserID: targetID, DeviceID: "target-device", ConnectionID: "target"}}}}
			hub := NewHub(nil, &groupTestPresence{revision: 2}, rooms, nil, nil, nil, nil)
			client := &recordingClient{identity: sharedauth.Identity{UserID: userID, DeviceID: "device"}, connectionID: "socket"}
			payload := `{"version":2,"type":"` + action + `","request_id":"mismatch","payload":{"conversation_id":"` + suppliedConversationID.String() + `","room_id":"` + roomID.String() + `","generation":1,"target_user_id":"` + targetID.String() + `","target_device_id":"target-device","signal":{"type":"offer","sdp":"safe"}}}`
			if err := hub.HandleVersion(context.Background(), client, 2, []byte(payload)); err == nil {
				t.Fatal("action using another conversation was authorized")
			}
			if rooms.mutationCalls != 0 {
				t.Fatalf("Redis mutation calls = %d, want none", rooms.mutationCalls)
			}
		})
	}
}

func TestHubBindsEveryV2GroupRoomCommandToPositiveGeneration(t *testing.T) {
	userID, targetID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	commands := []string{
		"group.call.join",
		"group.call.leave",
		"group.call.end",
		"group.call.presenter.start",
		"group.call.presenter.stop",
		"group.call.signal",
	}
	for _, command := range commands {
		for _, testCase := range []struct {
			name       string
			generation string
			wantErr    bool
		}{
			{name: "missing", wantErr: true},
			{name: "wrong", generation: `,"generation":2`, wantErr: true},
			{name: "valid", generation: `,"generation":1`},
		} {
			t.Run(command+"/"+testCase.name, func(t *testing.T) {
				rooms := &groupTestRooms{room: GroupRoom{
					ID: roomID, ConversationID: conversationID, MembershipRevision: 2,
					Generation: 1, Status: GroupRoomActive,
					Participants: []GroupParticipant{
						{UserID: userID, DeviceID: "device", ConnectionID: "socket"},
						{UserID: targetID, DeviceID: "target-device", ConnectionID: "target"},
					},
				}}
				presence := &groupTestPresence{revision: 2, memberIDs: []uuid.UUID{userID, targetID}}
				hub := NewHub(nil, presence, rooms, nil, nil, nil, nil)
				client := &recordingClient{identity: sharedauth.Identity{UserID: userID, DeviceID: "device"}, connectionID: "socket"}
				payload := `{"version":2,"type":"` + command + `","request_id":"generation-test","payload":{"conversation_id":"` + conversationID.String() + `","room_id":"` + roomID.String() + `"` + testCase.generation + `,"target_user_id":"` + targetID.String() + `","target_device_id":"target-device","signal":{"type":"offer","sdp":"safe"}}}`

				err := hub.HandleVersion(context.Background(), client, 2, []byte(payload))
				if testCase.wantErr && err == nil {
					t.Fatal("command without the exact positive room generation was accepted")
				}
				if !testCase.wantErr && err != nil {
					t.Fatalf("command with matching generation was rejected: %v", err)
				}
				if testCase.wantErr && rooms.mutationCalls != 0 {
					t.Fatalf("rejected command made %d room mutations", rooms.mutationCalls)
				}
			})
		}
	}
}

func TestHubDeliversGroupEndToRemainingParticipant(t *testing.T) {
	ownerID, memberID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	rooms := &groupTestRooms{room: GroupRoom{ID: roomID, ConversationID: conversationID, MembershipRevision: 2, Generation: 1, StateRevision: 7, Status: GroupRoomActive, Participants: []GroupParticipant{{UserID: ownerID, DeviceID: "owner-device", ConnectionID: "owner-socket"}, {UserID: memberID, DeviceID: "member-device", ConnectionID: "member-socket"}}}}
	hub := NewHub(nil, &groupTestPresence{revision: 2}, rooms, nil, nil, nil, nil)
	owner := &recordingClient{identity: sharedauth.Identity{UserID: ownerID, DeviceID: "owner-device"}, connectionID: "owner-socket"}
	member := &recordingClient{identity: sharedauth.Identity{UserID: memberID, DeviceID: "member-device"}, connectionID: "member-socket"}
	sibling := &recordingClient{identity: sharedauth.Identity{UserID: memberID, DeviceID: "member-device"}, connectionID: "member-sibling"}
	hub.Add(context.Background(), owner)
	hub.Add(context.Background(), member)
	hub.Add(context.Background(), sibling)
	owner.events = nil
	member.events = nil
	sibling.events = nil

	err := hub.HandleVersion(context.Background(), owner, 2, []byte(`{"version":2,"type":"group.call.end","request_id":"end-1","payload":{"conversation_id":"`+conversationID.String()+`","room_id":"`+roomID.String()+`","generation":1}}`))
	if err != nil {
		t.Fatalf("end group room: %v", err)
	}
	if len(member.events) != 1 {
		t.Fatalf("member events = %#v", member.events)
	}
	event, ok := member.events[0].(serverEvent)
	if !ok || event.Type != "group.call.ended" {
		t.Fatalf("member terminal event = %#v", member.events[0])
	}
	endedPayload, err := json.Marshal(event.Payload)
	if err != nil {
		t.Fatalf("marshal terminal payload: %v", err)
	}
	var ended struct {
		StateRevision int64 `json:"state_revision"`
	}
	if err := json.Unmarshal(endedPayload, &ended); err != nil {
		t.Fatalf("decode terminal payload: %v", err)
	}
	if ended.StateRevision != 8 {
		t.Fatalf("terminal state revision = %d, want post-end revision 8: %s", ended.StateRevision, endedPayload)
	}
	if len(sibling.events) != 0 {
		t.Fatalf("sibling events = %#v", sibling.events)
	}
}

func TestHubDeliversGroupEndAfterPubSubRoundTrip(t *testing.T) {
	ownerID, memberID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	room := GroupRoom{ID: roomID, ConversationID: conversationID, MembershipRevision: 2, Generation: 1, Status: GroupRoomEnded, Participants: []GroupParticipant{{UserID: ownerID, DeviceID: "owner-device", ConnectionID: "owner-socket"}, {UserID: memberID, DeviceID: "member-device", ConnectionID: "member-socket"}}}
	hub := NewHub(nil, &groupTestPresence{revision: 2}, &groupTestRooms{}, nil, nil, nil, nil)
	member := &recordingClient{identity: sharedauth.Identity{UserID: memberID, DeviceID: "member-device"}, connectionID: "member-socket"}
	hub.Add(context.Background(), member)
	member.events = nil

	change := GroupRoomChange{Type: "ended", Room: room, ParticipantConnectionIDs: groupParticipantConnectionIDs(room)}
	payload, err := json.Marshal(change)
	if err != nil {
		t.Fatalf("marshal group room change: %v", err)
	}
	var delivered GroupRoomChange
	if err := json.Unmarshal(payload, &delivered); err != nil {
		t.Fatalf("unmarshal group room change: %v", err)
	}
	if delivered.Room.Participants[1].ConnectionID != "" {
		t.Fatalf("connection ID leaked into room payload: %#v", delivered.Room.Participants[1])
	}

	hub.DeliverGroupRoom(context.Background(), delivered)
	if len(member.events) != 1 {
		t.Fatalf("member events = %#v", member.events)
	}
	event, ok := member.events[0].(serverEvent)
	if !ok || event.Type != "group.call.ended" {
		t.Fatalf("member terminal event = %#v", member.events[0])
	}
}

func TestHubGroupRoomFanoutRequiresV2Protocol(t *testing.T) {
	ownerID, peerID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	room := GroupRoom{ID: roomID, ConversationID: conversationID, MembershipRevision: 2, Generation: 1, Status: GroupRoomActive, Participants: []GroupParticipant{
		{UserID: ownerID, DeviceID: "owner", ConnectionID: "owner-socket"},
		{UserID: peerID, DeviceID: "peer", ConnectionID: "peer-v1-socket"},
		{UserID: peerID, DeviceID: "peer", ConnectionID: "peer-v2-socket"},
	}}
	for _, eventType := range []string{"started", "participant.joined", "participant.left", "ended", "presenter.start", "presenter.stop", "signal"} {
		t.Run(eventType, func(t *testing.T) {
			presence := &groupTestPresence{revision: 2, memberIDs: []uuid.UUID{ownerID, peerID}}
			hub := NewHubWithGroupCallAuthorizer(nil, presence, presence, &groupTestRooms{}, nil, nil, nil, nil, nil, nil)
			v1 := &versionedRecordingClient{recordingClient: recordingClient{identity: sharedauth.Identity{UserID: peerID, DeviceID: "peer"}, connectionID: "peer-v1-socket"}, version: 1}
			v2 := &versionedRecordingClient{recordingClient: recordingClient{identity: sharedauth.Identity{UserID: peerID, DeviceID: "peer"}, connectionID: "peer-v2-socket"}, version: 2}
			hub.Add(context.Background(), v1)
			hub.Add(context.Background(), v2)
			v1.events = nil
			v2.events = nil
			change := GroupRoomChange{Type: eventType, Room: room, ParticipantConnectionIDs: groupParticipantConnectionIDs(room), ToUserID: peerID, ToDeviceID: "peer", Signal: json.RawMessage(`{"type":"offer","sdp":"safe"}`)}
			hub.DeliverGroupRoom(context.Background(), change)
			if len(v1.events) != 0 {
				t.Fatalf("v1 received group call event: %#v", v1.events)
			}
			if len(v2.events) != 1 {
				t.Fatalf("v2 events = %#v, want one", v2.events)
			}
			got := v2.events[0].(serverEvent).Type
			want := "group.call." + eventType
			if got != want {
				t.Fatalf("v2 event = %q, want %q", got, want)
			}
		})
	}
}

type versionedRecordingClient struct {
	recordingClient
	version int
}

func (c *versionedRecordingClient) ProtocolVersion() int { return c.version }

func TestHubMembershipChangeTerminatesRemovedParticipantRoomSocket(t *testing.T) {
	ownerID, removedID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	rooms := &groupTestRooms{room: GroupRoom{ID: roomID, ConversationID: conversationID, MembershipRevision: 2, StateRevision: 7, Generation: 4, Status: GroupRoomActive, Participants: []GroupParticipant{{UserID: ownerID, DeviceID: "owner", ConnectionID: "owner-socket"}, {UserID: removedID, DeviceID: "removed", ConnectionID: "removed-socket"}}}}
	hub := NewHubWithGroupCallAuthorizer(nil, &groupTestPresence{}, currentProjectionAuthorizer{revision: 3, activeUserIDs: map[uuid.UUID]bool{ownerID: true}}, rooms, nil, nil, nil, nil, nil, nil)
	owner := &recordingClient{identity: sharedauth.Identity{UserID: ownerID, DeviceID: "owner"}, connectionID: "owner-socket"}
	removed := &recordingClient{identity: sharedauth.Identity{UserID: removedID, DeviceID: "removed"}, connectionID: "removed-socket"}
	hub.Add(context.Background(), owner)
	hub.Add(context.Background(), removed)
	owner.events, removed.events = nil, nil

	if err := hub.NotifyGroupProjection(context.Background(), conversationID, 3, false, []uuid.UUID{ownerID}); err != nil {
		t.Fatalf("notify projection: %v", err)
	}
	var activeEvent serverEvent
	for _, rawEvent := range owner.events {
		if event, ok := rawEvent.(serverEvent); ok && event.Type == "group.call.ended" {
			activeEvent = event
			break
		}
	}
	if activeEvent.Type != "group.call.ended" {
		t.Fatalf("active terminal event not delivered: %#v", owner.events)
	}
	activePayload, err := json.Marshal(activeEvent.Payload)
	if err != nil {
		t.Fatalf("marshal active payload: %v", err)
	}
	var activeRoom map[string]json.RawMessage
	if err := json.Unmarshal(activePayload, &activeRoom); err != nil {
		t.Fatalf("decode active payload: %v", err)
	}
	if _, ok := activeRoom["conversation_id"]; !ok || activeRoom["participants"] == nil {
		t.Fatalf("active member did not receive full terminal room: %s", activePayload)
	}
	if len(removed.events) != 1 {
		t.Fatalf("removed participant events = %#v", removed.events)
	}
	event, ok := removed.events[0].(serverEvent)
	if !ok || event.Type != "group.call.ended" {
		t.Fatalf("removed terminal event = %#v", removed.events[0])
	}
	payload, err := json.Marshal(event.Payload)
	if err != nil {
		t.Fatalf("marshal removed payload: %v", err)
	}
	var minimal map[string]json.RawMessage
	if err := json.Unmarshal(payload, &minimal); err != nil {
		t.Fatalf("decode removed payload: %v", err)
	}
	for _, forbidden := range []string{"conversation_id", "participants", "presenter", "ice_servers", "connection_id", "participant_connection_ids"} {
		if _, exists := minimal[forbidden]; exists {
			t.Errorf("removed payload leaked %q: %s", forbidden, payload)
		}
	}
	if len(minimal) != 4 || string(minimal["status"]) != `"ended"` || string(minimal["state_revision"]) != "8" {
		t.Fatalf("removed terminal payload = %s; want minimal revision 8", payload)
	}
}

func TestGroupProjectionTerminalFanoutReachesRemotePreTerminalSockets(t *testing.T) {
	for _, deleted := range []bool{false, true} {
		t.Run(map[bool]string{false: "removal", true: "deletion"}[deleted], func(t *testing.T) {
			ownerID, removedID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
			room := GroupRoom{ID: roomID, ConversationID: conversationID, MembershipRevision: 2, Generation: 4, Status: GroupRoomActive, Participants: []GroupParticipant{
				{UserID: ownerID, DeviceID: "owner", ConnectionID: "owner-socket"},
				{UserID: removedID, DeviceID: "removed", ConnectionID: "removed-socket"},
			}}
			publisherRooms := &groupTestRooms{room: room}
			publisher := NewHub(nil, &groupTestPresence{}, publisherRooms, nil, nil, nil, nil)
			if err := publisher.NotifyGroupProjection(context.Background(), conversationID, 3, deleted, []uuid.UUID{ownerID}); err != nil {
				t.Fatalf("publish projection: %v", err)
			}
			if len(publisherRooms.published) != 1 {
				t.Fatalf("published room changes = %#v, want one terminal projection", publisherRooms.published)
			}

			// The remote replica has the pre-terminal sockets, but authorization
			// confirms that no actor is currently active (as after removal/delete).
			verifier := currentProjectionAuthorizer{revision: 3, activeUserIDs: map[uuid.UUID]bool{ownerID: !deleted}}
			remote := NewHubWithGroupCallAuthorizer(nil, &groupTestPresence{}, verifier, &groupTestRooms{}, nil, nil, nil, nil, nil, nil)
			owner := &recordingClient{identity: sharedauth.Identity{UserID: ownerID, DeviceID: "owner"}, connectionID: "owner-socket"}
			removed := &recordingClient{identity: sharedauth.Identity{UserID: removedID, DeviceID: "removed"}, connectionID: "removed-socket"}
			sibling := &recordingClient{identity: sharedauth.Identity{UserID: removedID, DeviceID: "removed"}, connectionID: "removed-sibling"}
			remote.Add(context.Background(), owner)
			remote.Add(context.Background(), removed)
			remote.Add(context.Background(), sibling)
			owner.events, removed.events, sibling.events = nil, nil, nil

			change := publisherRooms.published[0]
			if change.MembershipProjectionRevision != 3 || change.MembershipProjectionDeleted != deleted {
				t.Fatalf("terminal projection metadata = %#v", change)
			}
			if change.Room.StateRevision <= room.StateRevision || len(change.Room.Participants) != len(room.Participants) {
				t.Fatalf("terminal event lost post-end revision or pre-end socket roster: %#v", change.Room)
			}
			payload, err := json.Marshal(change)
			if err != nil {
				t.Fatalf("marshal internal pub/sub event: %v", err)
			}
			var remoteChange GroupRoomChange
			if err := json.Unmarshal(payload, &remoteChange); err != nil {
				t.Fatalf("unmarshal internal pub/sub event: %v", err)
			}
			remote.DeliverGroupRoom(context.Background(), remoteChange)

			for name, client := range map[string]*recordingClient{"owner": owner, "removed": removed} {
				if len(client.events) != 1 || client.events[0].(serverEvent).Type != "group.call.ended" {
					t.Errorf("%s terminal events = %#v", name, client.events)
					continue
				}
				payload, err := json.Marshal(client.events[0].(serverEvent).Payload)
				if err != nil {
					t.Errorf("marshal %s payload: %v", name, err)
					continue
				}
				var fields map[string]json.RawMessage
				_ = json.Unmarshal(payload, &fields)
				wantMinimal := deleted || name == "removed"
				_, hasConversation := fields["conversation_id"]
				if hasConversation == wantMinimal {
					t.Errorf("%s payload authorization mismatch (deleted=%v): %s", name, deleted, payload)
				}
				if wantMinimal && len(fields) != 4 {
					t.Errorf("%s minimal payload has unexpected fields: %s", name, payload)
				}
			}
			if len(sibling.events) != 0 {
				t.Errorf("nonparticipant sibling received terminal event: %#v", sibling.events)
			}
		})
	}
}

func TestOutOfOrderGroupProjectionRevalidatesCurrentRecipientMembership(t *testing.T) {
	ownerID, removedID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	room := GroupRoom{ID: roomID, ConversationID: conversationID, MembershipRevision: 1, Generation: 4, StateRevision: 8, Status: GroupRoomEnded, Participants: []GroupParticipant{
		{UserID: ownerID, DeviceID: "owner", ConnectionID: "owner-socket"},
		{UserID: removedID, DeviceID: "removed", ConnectionID: "removed-socket"},
	}}
	// This is the earlier terminal projection (revision 2), delivered after a
	// committed removal at revision 3. The historical projection included both
	// participants, but only the owner remains active now.
	change := GroupRoomChange{Type: "ended", Room: room, ParticipantConnectionIDs: groupParticipantConnectionIDs(room), MembershipProjectionRevision: 2}
	authorizer := currentProjectionAuthorizer{revision: 3, activeUserIDs: map[uuid.UUID]bool{ownerID: true}}
	hub := NewHubWithGroupCallAuthorizer(nil, &groupTestPresence{}, authorizer, &groupTestRooms{}, nil, nil, nil, nil, nil, nil)
	owner := &recordingClient{identity: sharedauth.Identity{UserID: ownerID, DeviceID: "owner"}, connectionID: "owner-socket"}
	removed := &recordingClient{identity: sharedauth.Identity{UserID: removedID, DeviceID: "removed"}, connectionID: "removed-socket"}
	hub.Add(context.Background(), owner)
	hub.Add(context.Background(), removed)
	owner.events, removed.events = nil, nil

	hub.DeliverGroupRoom(context.Background(), change)

	assertTerminalPayload := func(client *recordingClient, wantMinimal bool) {
		t.Helper()
		if len(client.events) != 1 {
			t.Fatalf("terminal events for %s = %#v", client.Identity().UserID, client.events)
		}
		payload, err := json.Marshal(client.events[0].(serverEvent).Payload)
		if err != nil {
			t.Fatalf("marshal terminal payload: %v", err)
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(payload, &fields); err != nil {
			t.Fatalf("decode terminal payload: %v", err)
		}
		_, fullRoster := fields["participants"]
		if fullRoster == wantMinimal || (wantMinimal && len(fields) != 4) {
			t.Errorf("payload minimal=%v, want %v: %s", !fullRoster, wantMinimal, payload)
		}
	}
	assertTerminalPayload(owner, false)
	assertTerminalPayload(removed, true)
}

func TestGroupRoomQueueAdmissionRevalidatesEveryRecipient(t *testing.T) {
	ownerID, activeID, removedID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	room := GroupRoom{ID: roomID, ConversationID: conversationID, MembershipRevision: 5, Generation: 2, StateRevision: 8, Status: GroupRoomActive, Participants: []GroupParticipant{
		{UserID: ownerID, DeviceID: "owner", ConnectionID: "owner-socket"},
		{UserID: activeID, DeviceID: "active", ConnectionID: "active-socket"},
		{UserID: removedID, DeviceID: "removed", ConnectionID: "removed-socket"},
	}, Presenter: &GroupParticipant{UserID: removedID, DeviceID: "removed", ConnectionID: "removed-socket"}}
	authorizer := currentProjectionAuthorizer{revision: 5, activeUserIDs: map[uuid.UUID]bool{ownerID: true, activeID: true}}
	hub := NewHubWithGroupCallAuthorizer(nil, &groupTestPresence{}, authorizer, &groupTestRooms{}, nil, nil, nil, nil, nil, nil)
	clients := []*recordingClient{
		{identity: sharedauth.Identity{UserID: ownerID, DeviceID: "owner"}, connectionID: "owner-socket"},
		{identity: sharedauth.Identity{UserID: activeID, DeviceID: "active"}, connectionID: "active-socket"},
		{identity: sharedauth.Identity{UserID: removedID, DeviceID: "removed"}, connectionID: "removed-socket"},
	}
	for _, client := range clients {
		hub.Add(context.Background(), client)
		client.events = nil
	}
	change := GroupRoomChange{Type: "participant.joined", Room: room, ParticipantConnectionIDs: groupParticipantConnectionIDs(room), RecipientUserIDs: []uuid.UUID{ownerID, activeID, removedID}}
	hub.deliverGroupRoomLockedContext(context.Background(), change)
	for _, client := range clients[:2] {
		if len(client.events) != 1 {
			t.Fatalf("active recipient %s events = %#v", client.Identity().UserID, client.events)
		}
		payload, _ := json.Marshal(client.events[0].(serverEvent).Payload)
		var got struct {
			Participants []GroupParticipant `json:"participants"`
			Presenter    *GroupParticipant  `json:"presenter"`
		}
		if err := json.Unmarshal(payload, &got); err != nil {
			t.Fatal(err)
		}
		if len(got.Participants) != 2 || got.Presenter != nil {
			t.Errorf("removed member leaked in active recipient roster: %s", payload)
		}
	}
	if len(clients[2].events) != 0 {
		t.Fatalf("revoked recipient got queued full payload: %#v", clients[2].events)
	}

	// Even an active recipient gets no historical event if its room revision is stale.
	clients[0].events = nil
	stale := change
	stale.Room.MembershipRevision = 4
	hub.deliverGroupRoomLockedContext(context.Background(), stale)
	if len(clients[0].events) != 0 {
		t.Fatalf("stale nonterminal event was queued: %#v", clients[0].events)
	}
}

func TestDeletedGroupProjectionSendsMinimalTerminalPayloadToEveryone(t *testing.T) {
	ownerID, removedID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	room := GroupRoom{ID: roomID, ConversationID: conversationID, MembershipRevision: 1, Generation: 1, StateRevision: 2, Status: GroupRoomEnded, Participants: []GroupParticipant{
		{UserID: ownerID, DeviceID: "owner", ConnectionID: "owner-socket"},
		{UserID: removedID, DeviceID: "removed", ConnectionID: "removed-socket"},
	}}
	hub := NewHubWithGroupCallAuthorizer(nil, &groupTestPresence{}, currentProjectionAuthorizer{revision: 2, activeUserIDs: map[uuid.UUID]bool{ownerID: true, removedID: true}}, &groupTestRooms{}, nil, nil, nil, nil, nil, nil)
	clients := []*recordingClient{
		{identity: sharedauth.Identity{UserID: ownerID, DeviceID: "owner"}, connectionID: "owner-socket"},
		{identity: sharedauth.Identity{UserID: removedID, DeviceID: "removed"}, connectionID: "removed-socket"},
	}
	for _, client := range clients {
		hub.Add(context.Background(), client)
		client.events = nil
	}
	hub.DeliverGroupRoom(context.Background(), GroupRoomChange{Type: "ended", Room: room, ParticipantConnectionIDs: groupParticipantConnectionIDs(room), MembershipProjectionRevision: 2, MembershipProjectionDeleted: true})
	for _, client := range clients {
		if len(client.events) != 1 {
			t.Fatalf("terminal events = %#v", client.events)
		}
		payload, _ := json.Marshal(client.events[0].(serverEvent).Payload)
		var fields map[string]json.RawMessage
		_ = json.Unmarshal(payload, &fields)
		if len(fields) != 4 {
			t.Errorf("deleted group sent non-minimal payload: %s", payload)
		}
	}
}

type currentProjectionAuthorizer struct {
	revision      int64
	activeUserIDs map[uuid.UUID]bool
}

func (a currentProjectionAuthorizer) BeginGroupCall(_ context.Context, _ uuid.UUID, userID uuid.UUID) (GroupCallLease, error) {
	if !a.activeUserIDs[userID] {
		return nil, ErrCallNotAllowed
	}
	memberIDs := make([]uuid.UUID, 0, len(a.activeUserIDs))
	for activeUserID, active := range a.activeUserIDs {
		if active {
			memberIDs = append(memberIDs, activeUserID)
		}
	}
	return &trackedGroupCallLease{revision: a.revision, members: memberIDs}, nil
}

func (a currentProjectionAuthorizer) GroupMembershipRevision(context.Context, uuid.UUID) (int64, error) {
	return a.revision, nil
}

func TestRemoteGroupProjectionRejectsStaleSignalsAndUnverifiedRemoval(t *testing.T) {
	ownerID, memberID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	room := GroupRoom{ID: roomID, ConversationID: conversationID, MembershipRevision: 2, Generation: 1, Status: GroupRoomActive, Participants: []GroupParticipant{
		{UserID: ownerID, DeviceID: "owner", ConnectionID: "owner-socket"},
		{UserID: memberID, DeviceID: "member", ConnectionID: "member-socket"},
	}}
	remote := NewHubWithGroupCallAuthorizer(nil, &groupTestPresence{}, inactiveProjectionAuthorizer{revision: 2}, &groupTestRooms{}, nil, nil, nil, nil, nil, nil)
	member := &recordingClient{identity: sharedauth.Identity{UserID: memberID, DeviceID: "member"}, connectionID: "member-socket"}
	remote.Add(context.Background(), member)
	member.events = nil
	connections := groupParticipantConnectionIDs(room)

	remote.DeliverGroupRoom(context.Background(), GroupRoomChange{Type: "signal", Room: room, ParticipantConnectionIDs: connections, ToUserID: memberID, ToDeviceID: "member", Signal: json.RawMessage(`{"type":"offer","sdp":"safe"}`)})
	remote.DeliverGroupRoom(context.Background(), GroupRoomChange{Type: "ended", Room: room, ParticipantConnectionIDs: connections, MembershipProjectionRevision: 3})
	if len(member.events) != 0 {
		t.Fatalf("stale or unverified group events delivered: %#v", member.events)
	}
}

func TestEndedRoomUsesMinimalPayloadForSocketWhoseMembershipWasRevoked(t *testing.T) {
	userID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New()
	client := &recordingClient{identity: sharedauth.Identity{UserID: userID, DeviceID: "member"}, connectionID: "member-socket"}
	room := GroupRoom{ID: roomID, ConversationID: conversationID, MembershipRevision: 1, Generation: 3, Status: GroupRoomEnded, StateRevision: 9, Participants: []GroupParticipant{{UserID: userID, DeviceID: "member", ConnectionID: "member-socket"}}}
	hub := NewHubWithGroupCallAuthorizer(nil, &groupTestPresence{}, inactiveProjectionAuthorizer{revision: 2}, &groupTestRooms{}, nil, nil, nil, nil, nil, nil)
	hub.Add(context.Background(), client)
	client.events = nil

	hub.deliverGroupRoomLockedContext(context.Background(), GroupRoomChange{Type: "ended", Room: room, ParticipantConnectionIDs: groupParticipantConnectionIDs(room)})

	if len(client.events) != 1 || client.events[0].(serverEvent).Type != "group.call.ended" {
		t.Fatalf("terminal events = %#v", client.events)
	}
	payload, err := json.Marshal(client.events[0].(serverEvent).Payload)
	if err != nil {
		t.Fatalf("marshal terminal payload: %v", err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(payload, &fields); err != nil {
		t.Fatalf("decode terminal payload: %v", err)
	}
	if len(fields) != 4 {
		t.Fatalf("revoked socket received %d terminal fields, want exactly 4", len(fields))
	}
	for _, field := range []string{"room_id", "generation", "status", "state_revision"} {
		if _, ok := fields[field]; !ok {
			t.Errorf("minimal terminal payload is missing %q", field)
		}
	}
}

func TestOlderMembershipProjectionFiltersTerminalRosterButStillRoutesRemovedPeer(t *testing.T) {
	userU, userV, conversationID, roomID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	room := GroupRoom{
		ID: roomID, ConversationID: conversationID, MembershipRevision: 1,
		Generation: 4, StateRevision: 8, Status: GroupRoomEnded,
		Participants: []GroupParticipant{
			{UserID: userU, DeviceID: "u-device", ConnectionID: "u-socket"},
			{UserID: userV, DeviceID: "v-device", ConnectionID: "v-socket"},
		},
		Presenter: &GroupParticipant{UserID: userV, DeviceID: "v-device", ConnectionID: "v-socket"},
	}
	hub := NewHubWithGroupCallAuthorizer(nil, &groupTestPresence{}, currentProjectionAuthorizer{
		revision: 2, activeUserIDs: map[uuid.UUID]bool{userU: true},
	}, &groupTestRooms{}, nil, nil, nil, nil, nil, nil)
	user := &recordingClient{identity: sharedauth.Identity{UserID: userU, DeviceID: "u-device"}, connectionID: "u-socket"}
	removed := &recordingClient{identity: sharedauth.Identity{UserID: userV, DeviceID: "v-device"}, connectionID: "v-socket"}
	for _, client := range []*recordingClient{user, removed} {
		hub.Add(context.Background(), client)
		client.events = nil
	}

	hub.DeliverGroupRoom(context.Background(), GroupRoomChange{
		Type: "ended", Room: room, ParticipantConnectionIDs: groupParticipantConnectionIDs(room),
		MembershipProjectionRevision: 2,
	})

	if len(user.events) != 1 || len(removed.events) != 1 {
		t.Fatalf("terminal events: U=%#v V=%#v; expected routing to both historical sockets", user.events, removed.events)
	}
	fullPayload, err := json.Marshal(user.events[0].(serverEvent).Payload)
	if err != nil {
		t.Fatalf("marshal U terminal payload: %v", err)
	}
	var full struct {
		Participants []GroupParticipant `json:"participants"`
		Presenter    *GroupParticipant  `json:"presenter"`
	}
	if err := json.Unmarshal(fullPayload, &full); err != nil {
		t.Fatalf("decode U terminal payload: %v", err)
	}
	if len(full.Participants) != 1 || full.Participants[0].UserID != userU {
		t.Fatalf("U terminal roster = %#v, want only active user U", full.Participants)
	}
	if full.Presenter != nil {
		t.Fatalf("removed presenter leaked in U terminal payload: %#v", full.Presenter)
	}
	minimalPayload, err := json.Marshal(removed.events[0].(serverEvent).Payload)
	if err != nil {
		t.Fatalf("marshal V terminal payload: %v", err)
	}
	var minimalFields map[string]json.RawMessage
	if err := json.Unmarshal(minimalPayload, &minimalFields); err != nil {
		t.Fatalf("decode V terminal payload: %v", err)
	}
	if len(minimalFields) != 4 {
		t.Fatalf("removed V received non-minimal terminal payload: %s", minimalPayload)
	}
}

type inactiveProjectionAuthorizer struct{ revision int64 }

func (inactiveProjectionAuthorizer) BeginGroupCall(context.Context, uuid.UUID, uuid.UUID) (GroupCallLease, error) {
	return nil, ErrCallNotAllowed
}

func (a inactiveProjectionAuthorizer) GroupMembershipRevision(context.Context, uuid.UUID) (int64, error) {
	return a.revision, nil
}

func TestHubRetriesGroupProjectionWhenRoomTerminationFails(t *testing.T) {
	conversationID := uuid.New()
	cleanupErr := errors.New("redis temporarily unavailable")
	rooms := &failingGroupTerminationCoordinator{
		groupTestRooms: groupTestRooms{room: GroupRoom{ID: uuid.New(), ConversationID: conversationID, Status: GroupRoomActive}},
		endErr:         cleanupErr,
	}
	hub := NewHub(nil, &groupTestPresence{}, rooms, nil, nil, nil, nil)

	err := hub.NotifyGroupProjection(context.Background(), conversationID, 3, false, nil)

	if !errors.Is(err, cleanupErr) {
		t.Fatalf("membership projection error = %v, want cleanup error", err)
	}
	if rooms.projections != 0 {
		t.Fatalf("published %d projections before room cleanup succeeded", rooms.projections)
	}
}

func TestHubAllowsGroupProjectionWhenNoActiveRoomExists(t *testing.T) {
	conversationID := uuid.New()
	rooms := &failingGroupTerminationCoordinator{getErr: ErrCallNotFound}
	hub := NewHub(nil, &groupTestPresence{}, rooms, nil, nil, nil, nil)

	if err := hub.NotifyGroupProjection(context.Background(), conversationID, 3, false, nil); err != nil {
		t.Fatalf("notify projection without a live room: %v", err)
	}
	if rooms.projections != 1 {
		t.Fatalf("published projections = %d, want 1", rooms.projections)
	}
}

func TestHubCanceledGroupProjectionReleasesConversationStripe(t *testing.T) {
	conversationID := uuid.New()
	rooms := &cancelingProjectionRooms{groupTestRooms: &groupTestRooms{}, entered: make(chan struct{})}
	hub := NewHub(nil, &groupTestPresence{}, rooms, nil, nil, nil, nil)
	ctx, cancel := context.WithCancel(context.Background())
	firstDone := make(chan error, 1)
	go func() {
		firstDone <- hub.NotifyGroupProjection(ctx, conversationID, 3, false, nil)
	}()
	<-rooms.entered
	cancel()
	if err := <-firstDone; !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled projection error = %v, want context.Canceled", err)
	}

	secondDone := make(chan error, 1)
	go func() {
		secondDone <- hub.NotifyGroupProjection(context.Background(), conversationID, 3, false, nil)
	}()
	select {
	case err := <-secondDone:
		if err != nil {
			t.Fatalf("projection after cancellation: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("conversation stripe remained locked after canceled projection")
	}
}

type cancelingProjectionRooms struct {
	*groupTestRooms
	entered chan struct{}
	first   bool
}

func (r *cancelingProjectionRooms) GetGroupRoomForConversation(ctx context.Context, _ uuid.UUID) (GroupRoom, error) {
	if !r.first {
		r.first = true
		close(r.entered)
		<-ctx.Done()
		return GroupRoom{}, ctx.Err()
	}
	return GroupRoom{}, ErrCallNotFound
}

func TestHubNotifiesExpiredGroupRoomParticipants(t *testing.T) {
	memberID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New()
	hub := NewHub(nil, &groupTestPresence{}, &groupTestRooms{}, nil, nil, nil, nil)
	member := &recordingClient{identity: sharedauth.Identity{UserID: memberID, DeviceID: "member"}, connectionID: "member-socket"}
	hub.Add(context.Background(), member)
	member.events = nil

	hub.NotifyExpiredGroupRooms(context.Background(), []GroupRoom{{ID: roomID, ConversationID: conversationID, Status: GroupRoomActive, Participants: []GroupParticipant{{UserID: memberID, DeviceID: "member", ConnectionID: "member-socket"}}}})
	if len(member.events) != 1 {
		t.Fatalf("member events = %#v", member.events)
	}
	event, ok := member.events[0].(serverEvent)
	if !ok || event.Type != "group.call.ended" {
		t.Fatalf("expired terminal event = %#v", member.events[0])
	}
}

func TestHubGroupSignalUsesSignalRateBudget(t *testing.T) {
	userID, targetID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	rooms := &groupSignalRateRooms{}
	hub := NewHub(nil, &groupTestPresence{revision: 2}, rooms, nil, nil, nil, nil)
	err := hub.HandleVersion(context.Background(), &recordingClient{identity: sharedauth.Identity{UserID: userID, DeviceID: "device"}, connectionID: "socket"}, 2, []byte(`{"version":2,"type":"group.call.signal","request_id":"signal-1","payload":{"conversation_id":"`+conversationID.String()+`","room_id":"`+roomID.String()+`","generation":1,"target_user_id":"`+targetID.String()+`","target_device_id":"target","signal":{"type":"offer","sdp":"safe"}}}`))
	if err == nil || err.Error() != "call rate limit exceeded" {
		t.Fatalf("signal error = %v", err)
	}
	if rooms.callChecks != 0 || rooms.signalChecks != 1 {
		t.Fatalf("rate checks call=%d signal=%d", rooms.callChecks, rooms.signalChecks)
	}
}

func TestGroupCallOperationDeadlineCoversRateAuthorizationRoomMutationAndFanout(t *testing.T) {
	userID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New()
	rooms := &boundedGroupCallRooms{groupTestRooms: groupTestRooms{room: GroupRoom{
		ID: roomID, ConversationID: conversationID, MembershipRevision: 2, Generation: 1, Status: GroupRoomActive,
		Participants: []GroupParticipant{{UserID: userID, DeviceID: "device", ConnectionID: "socket"}},
	}}}
	presence := &boundedGroupCallPresence{groupTestPresence: groupTestPresence{revision: 2}}
	limiter := &boundedGroupCallLimiter{}
	hub := NewHub(nil, presence, limiterWithRooms{boundedGroupCallLimiter: limiter, GroupRoomCoordinator: rooms, PresenceCoordinator: rooms}, nil, nil, nil, nil)
	client := &recordingClient{identity: sharedauth.Identity{UserID: userID, DeviceID: "device"}, connectionID: "socket"}

	err := hub.HandleVersion(context.Background(), client, 2, []byte(`{"version":2,"type":"group.call.join","request_id":"bounded","payload":{"conversation_id":"`+conversationID.String()+`","room_id":"`+roomID.String()+`","generation":1}}`))
	if err != nil {
		t.Fatalf("join group room: %v", err)
	}
	if !limiter.deadlineSeen || !presence.deadlineSeen || !rooms.allDeadlinesSeen() {
		t.Fatalf("operation deadline was not propagated: limiter=%v membership=%v room calls=%v", limiter.deadlineSeen, presence.deadlineSeen, rooms.deadlineCalls)
	}
}

func TestGroupCallCancellationDuringMembershipDoesNotReadOrMutateRoom(t *testing.T) {
	userID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rooms := &boundedGroupCallRooms{groupTestRooms: groupTestRooms{room: GroupRoom{
		ID: roomID, ConversationID: conversationID, MembershipRevision: 2, Generation: 1, Status: GroupRoomActive,
		Participants: []GroupParticipant{{UserID: userID, DeviceID: "device", ConnectionID: "socket"}},
	}}}
	presence := &boundedGroupCallPresence{groupTestPresence: groupTestPresence{revision: 2}, cancel: cancel}
	limiter := &boundedGroupCallLimiter{}
	hub := NewHub(nil, presence, limiterWithRooms{boundedGroupCallLimiter: limiter, GroupRoomCoordinator: rooms, PresenceCoordinator: rooms}, nil, nil, nil, nil)
	client := &recordingClient{identity: sharedauth.Identity{UserID: userID, DeviceID: "device"}, connectionID: "socket"}

	err := hub.HandleVersion(ctx, client, 2, []byte(`{"version":2,"type":"group.call.join","request_id":"cancel-membership","payload":{"conversation_id":"`+conversationID.String()+`","room_id":"`+roomID.String()+`","generation":1}}`))
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("join error = %v, want canceled context", err)
	}
	if len(rooms.deadlineCalls) != 0 || rooms.mutationCalls != 0 {
		t.Fatalf("room operations after cancellation: calls=%v mutations=%d", rooms.deadlineCalls, rooms.mutationCalls)
	}
}

type boundedGroupCallLimiter struct{ deadlineSeen bool }

func (l *boundedGroupCallLimiter) AllowCall(ctx context.Context, _ uuid.UUID) (bool, error) {
	_, l.deadlineSeen = ctx.Deadline()
	return true, ctx.Err()
}
func (l *boundedGroupCallLimiter) AllowSignal(context.Context, uuid.UUID) (bool, error) {
	return true, nil
}
func (l *boundedGroupCallLimiter) AllowPresenceRefresh(context.Context, uuid.UUID) (bool, error) {
	return true, nil
}
func (l *boundedGroupCallLimiter) AllowRead(context.Context, uuid.UUID) (bool, error) {
	return true, nil
}

type limiterWithRooms struct {
	*boundedGroupCallLimiter
	GroupRoomCoordinator
	PresenceCoordinator
}

func (limiterWithRooms) AcquireCallAdmission(ctx context.Context, users []uuid.UUID) (string, error) {
	return "admission", nil
}
func (limiterWithRooms) ReleaseCallAdmission(context.Context, []uuid.UUID, string) {}

type boundedGroupCallPresence struct {
	groupTestPresence
	deadlineSeen bool
	cancel       context.CancelFunc
}

func (p *boundedGroupCallPresence) BeginGroupCall(ctx context.Context, _, _ uuid.UUID) (GroupCallLease, error) {
	_, p.deadlineSeen = ctx.Deadline()
	if p.cancel != nil {
		p.cancel()
	}
	return groupTestStartLease{revision: p.revision, memberIDs: p.memberIDs}, ctx.Err()
}

type boundedGroupCallRooms struct {
	groupTestRooms
	deadlineCalls []string
}

func (r *boundedGroupCallRooms) recordDeadline(name string, ctx context.Context) {
	if _, ok := ctx.Deadline(); ok {
		r.deadlineCalls = append(r.deadlineCalls, name)
	}
}
func (r *boundedGroupCallRooms) allDeadlinesSeen() bool {
	return equalStrings(r.deadlineCalls, []string{"get", "join", "publish"})
}
func (r *boundedGroupCallRooms) GetGroupRoom(ctx context.Context, id uuid.UUID) (GroupRoom, error) {
	r.recordDeadline("get", ctx)
	return r.groupTestRooms.GetGroupRoom(ctx, id)
}
func (r *boundedGroupCallRooms) JoinGroupRoom(ctx context.Context, id uuid.UUID, participant GroupParticipant, revision int64, token string) (GroupRoom, error) {
	r.recordDeadline("join", ctx)
	return r.groupTestRooms.JoinGroupRoom(ctx, id, participant, revision, token)
}
func (r *boundedGroupCallRooms) PublishGroupRoom(ctx context.Context, change GroupRoomChange) error {
	r.recordDeadline("publish", ctx)
	return nil
}

type groupTestPresence struct {
	revision  int64
	memberIDs []uuid.UUID
}

func (*groupTestPresence) PeerIDs(context.Context, uuid.UUID) ([]uuid.UUID, error) { return nil, nil }
func (*groupTestPresence) RecipientID(context.Context, uuid.UUID, uuid.UUID) (uuid.UUID, error) {
	return uuid.Nil, nil
}
func (p *groupTestPresence) BeginGroupCall(context.Context, uuid.UUID, uuid.UUID) (GroupCallLease, error) {
	return groupTestStartLease{revision: p.revision, memberIDs: p.memberIDs}, nil
}

type groupTestStartLease struct {
	revision  int64
	memberIDs []uuid.UUID
}

func (l groupTestStartLease) MembershipRevision() int64    { return l.revision }
func (l groupTestStartLease) ActiveMemberIDs() []uuid.UUID { return l.memberIDs }
func (groupTestStartLease) Commit(context.Context) error   { return nil }
func (groupTestStartLease) Rollback(context.Context) error { return nil }

type groupTestRooms struct {
	room          GroupRoom
	published     []GroupRoomChange
	mutationCalls int
	newerRoom     GroupRoom
	abortedRoom   uuid.UUID
	abortCalls    int
}

type failingGroupTerminationCoordinator struct {
	groupTestRooms
	getErr      error
	endErr      error
	projections int
}

func (r *failingGroupTerminationCoordinator) GetGroupRoomForConversation(context.Context, uuid.UUID) (GroupRoom, error) {
	return r.room, r.getErr
}

func (r *failingGroupTerminationCoordinator) EndGroupRoomForMembershipChange(context.Context, uuid.UUID, uuid.UUID, int64, int64, int64) (GroupRoom, error) {
	return GroupRoom{}, r.endErr
}

func (r *failingGroupTerminationCoordinator) PublishGroupProjection(context.Context, uuid.UUID, int64, bool, []uuid.UUID) error {
	r.projections++
	return nil
}

func (r *groupTestRooms) AcquireCallAdmission(context.Context, []uuid.UUID) (string, error) {
	return uuid.NewString(), nil
}
func (r *groupTestRooms) ReleaseCallAdmission(context.Context, []uuid.UUID, string) {}

func (r *groupTestRooms) Connect(context.Context, uuid.UUID, string) (bool, error) { return false, nil }
func (r *groupTestRooms) Disconnect(context.Context, uuid.UUID, string) (bool, error) {
	return false, nil
}
func (*groupTestRooms) Online(context.Context, []uuid.UUID) (map[uuid.UUID]bool, error) {
	return nil, nil
}
func (*groupTestRooms) Publish(context.Context, uuid.UUID, bool) error { return nil }
func (r *groupTestRooms) StartGroupRoom(_ context.Context, room GroupRoom, _ string) (GroupRoom, error) {
	room.Status = GroupRoomRinging
	r.room = room
	return room, nil
}
func (r *groupTestRooms) JoinGroupRoom(context.Context, uuid.UUID, GroupParticipant, int64, string) (GroupRoom, error) {
	r.mutationCalls++
	return r.room, nil
}
func (r *groupTestRooms) LeaveGroupRoom(context.Context, uuid.UUID, GroupParticipant) (GroupRoom, error) {
	r.mutationCalls++
	return r.room, nil
}
func (r *groupTestRooms) EndGroupRoom(context.Context, uuid.UUID, GroupParticipant) (GroupRoom, error) {
	r.mutationCalls++
	room := r.room
	room.Status = GroupRoomEnded
	room.StateRevision++
	room.Participants = nil
	return room, nil
}
func (r *groupTestRooms) AbortGroupRoomStart(_ context.Context, roomID uuid.UUID, generation int64, owner GroupParticipant) error {
	r.abortCalls++
	r.abortedRoom = roomID
	if r.room.ID != roomID || r.room.Generation != generation || len(r.room.Participants) == 0 || r.room.Participants[0] != owner {
		return nil // stale compensation is a safe no-op
	}
	r.room.Status = GroupRoomEnded
	r.room.Participants = nil
	return nil
}
func (r *groupTestRooms) GetGroupRoom(context.Context, uuid.UUID) (GroupRoom, error) {
	return r.room, nil
}
func (r *groupTestRooms) GetGroupRoomForConversation(context.Context, uuid.UUID) (GroupRoom, error) {
	return r.room, nil
}
func (r *groupTestRooms) SyncGroupRoom(_ context.Context, roomID uuid.UUID, generation int64, participant GroupParticipant) (GroupRoom, bool, error) {
	if r.room.ID != roomID || r.room.Generation != generation || r.room.Status != GroupRoomActive || !groupParticipantOwns(r.room, participant) {
		return GroupRoom{ID: roomID, Generation: generation, Status: GroupRoomEnded}, false, nil
	}
	return r.room, true, nil
}
func (r *groupTestRooms) SetGroupPresenter(context.Context, uuid.UUID, GroupParticipant, bool) (GroupRoom, error) {
	r.mutationCalls++
	return r.room, nil
}
func (r *groupTestRooms) RemoveGroupConnection(context.Context, uuid.UUID, string, string) ([]GroupRoom, error) {
	return nil, nil
}
func (r *groupTestRooms) EndGroupRoomForMembershipChange(_ context.Context, conversationID, roomID uuid.UUID, generation, stateRevision, membershipRevision int64) (GroupRoom, error) {
	if r.room.ID != roomID || r.room.Generation != generation || r.room.StateRevision != stateRevision || r.room.MembershipRevision >= membershipRevision {
		return GroupRoom{}, ErrCallNotFound
	}
	room := r.room
	room.Status = GroupRoomEnded
	room.StateRevision++
	room.Participants = nil
	r.room = room
	return room, nil
}
func (*groupTestRooms) ExpireGroupRooms(context.Context, int) ([]GroupRoom, error) { return nil, nil }
func (r *groupTestRooms) PublishGroupRoom(_ context.Context, change GroupRoomChange) error {
	r.published = append(r.published, change)
	return nil
}

type groupSignalRateRooms struct {
	groupTestRooms
	callChecks   int
	signalChecks int
}

func (r *groupSignalRateRooms) AllowCall(context.Context, uuid.UUID) (bool, error) {
	r.callChecks++
	return true, nil
}
func (r *groupSignalRateRooms) AllowSignal(context.Context, uuid.UUID) (bool, error) {
	r.signalChecks++
	return false, nil
}
func (*groupSignalRateRooms) AllowPresenceRefresh(context.Context, uuid.UUID) (bool, error) {
	return true, nil
}
func (*groupSignalRateRooms) AllowRead(context.Context, uuid.UUID) (bool, error) { return true, nil }
