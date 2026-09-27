package redis

import (
	"context"
	"errors"
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/google/uuid"
	redis "github.com/redis/go-redis/v9"

	"github.com/KovalMax/zwei/services/realtime/internal/application"
)

func startAdmittedGroupRoom(ctx context.Context, coordinator *PresenceCoordinator, room application.GroupRoom) (application.GroupRoom, error) {
	userID := room.Participants[0].UserID
	token, err := coordinator.AcquireCallAdmission(ctx, []uuid.UUID{userID})
	if err != nil {
		return application.GroupRoom{}, err
	}
	defer coordinator.ReleaseCallAdmission(ctx, []uuid.UUID{userID}, token)
	return coordinator.StartGroupRoom(ctx, room, token)
}

func joinAdmittedGroupRoom(ctx context.Context, coordinator *PresenceCoordinator, roomID uuid.UUID, participant application.GroupParticipant, revision int64) (application.GroupRoom, error) {
	var token string
	for {
		var err error
		token, err = coordinator.AcquireCallAdmission(ctx, []uuid.UUID{participant.UserID})
		if err == nil {
			break
		}
		if !errors.Is(err, application.ErrCallBusy) {
			return application.GroupRoom{}, err
		}
		select {
		case <-ctx.Done():
			return application.GroupRoom{}, ctx.Err()
		case <-time.After(time.Millisecond):
		}
	}
	defer coordinator.ReleaseCallAdmission(ctx, []uuid.UUID{participant.UserID}, token)
	return coordinator.JoinGroupRoom(ctx, roomID, participant, revision, token)
}

func TestGroupRoomReservationIntegration(t *testing.T) {
	rawURL := os.Getenv("ZWEI_TEST_REDIS_URL")
	if rawURL == "" {
		t.Skip("set ZWEI_TEST_REDIS_URL to run Redis integration tests")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	coordinator, err := NewPresenceCoordinator(rawURL)
	if err != nil {
		t.Fatalf("create coordinator: %v", err)
	}
	defer coordinator.Close()

	roomID, conversationID := uuid.New(), uuid.New()
	participants := []application.GroupParticipant{
		{UserID: uuid.New(), DeviceID: uuid.NewString(), ConnectionID: uuid.NewString()},
		{UserID: uuid.New(), DeviceID: uuid.NewString(), ConnectionID: uuid.NewString()},
		{UserID: uuid.New(), DeviceID: uuid.NewString(), ConnectionID: uuid.NewString()},
		{UserID: uuid.New(), DeviceID: uuid.NewString(), ConnectionID: uuid.NewString()},
		{UserID: uuid.New(), DeviceID: uuid.NewString(), ConnectionID: uuid.NewString()},
	}
	defer func() {
		keys := []string{groupRoomKey(roomID), groupRoomConversationKey(conversationID)}
		for _, participant := range participants {
			keys = append(keys, groupRoomUserKey(participant.UserID))
		}
		_ = coordinator.client.Del(ctx, keys...).Err()
	}()

	room, err := startAdmittedGroupRoom(ctx, coordinator, application.GroupRoom{ID: roomID, ConversationID: conversationID, MembershipRevision: 7, Generation: 1, Participants: participants[:1]})
	if err != nil {
		t.Fatalf("start room: %v", err)
	}
	if room.Status != application.GroupRoomRinging || len(room.Participants) != 1 || room.Participants[0].ConnectionID != participants[0].ConnectionID {
		t.Fatalf("started room = %#v", room)
	}

	joinResults := make(chan error, len(participants)-1)
	for _, participant := range participants[1:] {
		go func(participant application.GroupParticipant) {
			_, err := joinAdmittedGroupRoom(ctx, coordinator, roomID, participant, 7)
			joinResults <- err
		}(participant)
	}
	successes := 0
	for range participants[1:] {
		if err := <-joinResults; err == nil {
			successes++
		} else if !errors.Is(err, application.ErrCallUnavailable) {
			t.Fatalf("concurrent join: %v", err)
		}
	}
	if successes != 3 {
		t.Fatalf("concurrent join successes = %d, want 3", successes)
	}
	room, err = coordinator.GetGroupRoom(ctx, roomID)
	if err != nil {
		t.Fatalf("get active room: %v", err)
	}
	if room.Status != application.GroupRoomActive || len(room.Participants) != application.GroupRoomCapacity {
		t.Fatalf("active room = %#v", room)
	}
	if room, err = coordinator.SetGroupPresenter(ctx, roomID, room.Participants[1], true); err != nil || room.Presenter == nil || room.Presenter.UserID != room.Participants[1].UserID {
		t.Fatalf("set presenter: room=%#v err=%v", room, err)
	}
	if _, err = coordinator.SetGroupPresenter(ctx, roomID, room.Participants[0], false); !errors.Is(err, application.ErrCallNotAllowed) {
		t.Fatalf("clear another participant presenter: err=%v, want not allowed", err)
	}
	leaveParticipant := room.Participants[0]
	for _, current := range room.Participants {
		if current.UserID != participants[0].UserID {
			leaveParticipant = current
			break
		}
	}
	wrongSocket := leaveParticipant
	wrongSocket.ConnectionID = uuid.NewString()
	if _, err := coordinator.LeaveGroupRoom(ctx, roomID, wrongSocket); !errors.Is(err, application.ErrCallNotAllowed) {
		t.Fatalf("leave from sibling socket: err=%v, want not allowed", err)
	}
	room, err = coordinator.LeaveGroupRoom(ctx, roomID, leaveParticipant)
	if err != nil {
		t.Fatalf("leave room: %v", err)
	}
	if len(room.Participants) != 3 {
		t.Fatalf("remaining participants = %d, want 3", len(room.Participants))
	}
	if room.Presenter != nil && room.Presenter.UserID == leaveParticipant.UserID {
		t.Fatalf("departed participant remained presenter: %#v", room.Presenter)
	}
	owner := participants[0]
	for _, current := range room.Participants {
		if current.UserID == owner.UserID {
			owner = current
			break
		}
	}
	if _, err := coordinator.EndGroupRoom(ctx, roomID, owner); err != nil {
		t.Fatalf("end room: %v", err)
	}
	endedState, err := coordinator.client.HGetAll(ctx, groupRoomKey(roomID)).Result()
	if err != nil {
		t.Fatalf("read ended room tombstone: %v", err)
	}
	if _, err := startAdmittedGroupRoom(ctx, coordinator, application.GroupRoom{ID: roomID, ConversationID: conversationID, MembershipRevision: 7, Generation: 2, Participants: participants[:1]}); !errors.Is(err, application.ErrCallUnavailable) {
		t.Fatalf("restart ended room during tombstone retention: %v, want unavailable", err)
	}
	stateAfterRestart, err := coordinator.client.HGetAll(ctx, groupRoomKey(roomID)).Result()
	if err != nil {
		t.Fatalf("read room after rejected restart: %v", err)
	}
	if !reflect.DeepEqual(stateAfterRestart, endedState) {
		t.Fatalf("rejected restart mutated ended room: before=%v after=%v", endedState, stateAfterRestart)
	}
	if _, err := joinAdmittedGroupRoom(ctx, coordinator, roomID, participants[1], 7); !errors.Is(err, application.ErrCallUnavailable) {
		t.Fatalf("join ended room during tombstone retention: %v, want unavailable", err)
	}
	stateAfterJoin, err := coordinator.client.HGetAll(ctx, groupRoomKey(roomID)).Result()
	if err != nil {
		t.Fatalf("read room after rejected join: %v", err)
	}
	if !reflect.DeepEqual(stateAfterJoin, endedState) {
		t.Fatalf("rejected join mutated ended room: before=%v after=%v", endedState, stateAfterJoin)
	}
	if _, err := startAdmittedGroupRoom(ctx, coordinator, application.GroupRoom{ID: uuid.New(), ConversationID: conversationID, MembershipRevision: 7, Generation: 2, Participants: participants[:1]}); err != nil {
		t.Fatalf("start after terminal cleanup: %v", err)
	}
}

func TestGroupRoomSyncRevisionAndEndedTombstoneIntegration(t *testing.T) {
	rawURL := os.Getenv("ZWEI_TEST_REDIS_URL")
	if rawURL == "" {
		t.Skip("set ZWEI_TEST_REDIS_URL to run Redis integration tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	coordinator, err := NewPresenceCoordinator(rawURL)
	if err != nil {
		t.Fatalf("create coordinator: %v", err)
	}
	defer coordinator.Close()

	roomID, conversationID := uuid.New(), uuid.New()
	owner := application.GroupParticipant{UserID: uuid.New(), DeviceID: "owner-device", ConnectionID: "owner-socket"}
	member := application.GroupParticipant{UserID: uuid.New(), DeviceID: "member-device", ConnectionID: "member-socket"}
	defer coordinator.client.Del(ctx, groupRoomKey(roomID), groupRoomConversationKey(conversationID), groupRoomUserKey(owner.UserID), groupRoomUserKey(member.UserID))
	room, err := startAdmittedGroupRoom(ctx, coordinator, application.GroupRoom{ID: roomID, ConversationID: conversationID, MembershipRevision: 12, Generation: 5, Participants: []application.GroupParticipant{owner}})
	if err != nil || room.StateRevision != 1 {
		t.Fatalf("start room = %#v, err=%v; state_revision should start at 1", room, err)
	}
	room, err = joinAdmittedGroupRoom(ctx, coordinator, roomID, member, 12)
	if err != nil || room.StateRevision != 2 || room.Status != application.GroupRoomActive {
		t.Fatalf("join room = %#v, err=%v", room, err)
	}
	active, ok, err := coordinator.SyncGroupRoom(ctx, roomID, 5, owner)
	if err != nil || !ok || active.StateRevision != 2 || len(active.Participants) != 2 {
		t.Fatalf("active sync = %#v, active=%v, err=%v", active, ok, err)
	}
	for _, request := range []struct {
		roomID      uuid.UUID
		generation  int64
		participant application.GroupParticipant
	}{
		{roomID: roomID, generation: 6, participant: owner},
		{roomID: uuid.New(), generation: 5, participant: owner},
		{roomID: roomID, generation: 5, participant: application.GroupParticipant{UserID: uuid.New(), DeviceID: "removed-device", ConnectionID: "removed-socket"}},
	} {
		ack, active, err := coordinator.SyncGroupRoom(ctx, request.roomID, request.generation, request.participant)
		if err != nil || active || ack.Status != application.GroupRoomEnded || ack.ID != request.roomID || ack.Generation != request.generation || len(ack.Participants) != 0 || ack.Presenter != nil {
			t.Fatalf("non-owner/mismatched sync ack=%#v active=%v err=%v", ack, active, err)
		}
	}
	if _, ok, err := coordinator.SyncGroupRoom(ctx, roomID, 5, application.GroupParticipant{UserID: owner.UserID, DeviceID: owner.DeviceID, ConnectionID: "sibling-socket"}); err != nil || ok {
		t.Fatalf("sibling socket sync active=%v err=%v, want inactive", ok, err)
	}
	room, err = coordinator.SetGroupPresenter(ctx, roomID, member, true)
	if err != nil || room.StateRevision != 3 {
		t.Fatalf("presenter mutation room=%#v err=%v", room, err)
	}
	if _, err := coordinator.EndGroupRoomForMembershipChange(ctx, conversationID, roomID, 5, 2, 13); !errors.Is(err, application.ErrCallNotAllowed) {
		t.Fatalf("stale state revision ended active room: %v", err)
	}
	stillActive, err := coordinator.GetGroupRoom(ctx, roomID)
	if err != nil || stillActive.Status != application.GroupRoomActive || stillActive.StateRevision != 3 {
		t.Fatalf("stale cleanup mutated active room: %#v err=%v", stillActive, err)
	}
	room, err = coordinator.EndGroupRoom(ctx, roomID, owner)
	if err != nil || room.StateRevision != 4 || room.Status != application.GroupRoomEnded {
		t.Fatalf("end room=%#v err=%v", room, err)
	}
	if _, ok, err := coordinator.SyncGroupRoom(ctx, roomID, 5, owner); err != nil || ok {
		t.Fatalf("ended room sync active=%v err=%v", ok, err)
	}
	tombstone, err := coordinator.client.HGetAll(ctx, groupRoomKey(roomID)).Result()
	if err != nil || tombstone["ended_participants"] == "" || tombstone["ended_connections"] == "" {
		t.Fatalf("ended tombstone lacks former socket ownership: %#v err=%v", tombstone, err)
	}
	ttl, err := coordinator.client.TTL(ctx, groupRoomKey(roomID)).Result()
	if err != nil || ttl <= 0 || ttl > groupRoomEndedTTL {
		t.Fatalf("ended tombstone TTL=%s err=%v", ttl, err)
	}
	if _, err := coordinator.EndGroupRoomForMembershipChange(ctx, conversationID, roomID, 4, room.StateRevision, 13); !errors.Is(err, application.ErrCallNotFound) {
		t.Fatalf("stale membership cleanup ended terminal/newer room: %v", err)
	}
}

func TestAbortGroupRoomStartDoesNotRemoveNewerGeneration(t *testing.T) {
	rawURL := os.Getenv("ZWEI_TEST_REDIS_URL")
	if rawURL == "" {
		t.Skip("set ZWEI_TEST_REDIS_URL to run Redis integration tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	coordinator, err := NewPresenceCoordinator(rawURL)
	if err != nil {
		t.Fatalf("create coordinator: %v", err)
	}
	defer coordinator.Close()

	conversationID, userID := uuid.New(), uuid.New()
	oldRoomID, newerRoomID := uuid.New(), uuid.New()
	participant := application.GroupParticipant{UserID: userID, DeviceID: "device", ConnectionID: "old-socket"}
	keys := []string{groupRoomKey(oldRoomID), groupRoomKey(newerRoomID), groupRoomConversationKey(conversationID), groupRoomUserKey(userID), groupRoomExpiryKey}
	defer coordinator.client.Del(ctx, keys...)
	if _, err := startAdmittedGroupRoom(ctx, coordinator, application.GroupRoom{ID: oldRoomID, ConversationID: conversationID, MembershipRevision: 7, Generation: 1, Participants: []application.GroupParticipant{participant}}); err != nil {
		t.Fatalf("start old room: %v", err)
	}

	// Model a replacement that won the conversation/user indexes before a late
	// ambiguous-commit compensation for the prior room arrives.
	newOwner := application.GroupParticipant{UserID: userID, DeviceID: "device", ConnectionID: "new-socket"}
	connections := userID.String() + "|device|new-socket"
	if err := coordinator.client.HSet(ctx, groupRoomKey(newerRoomID), map[string]any{
		"conversation_id": conversationID.String(), "membership_revision": "8", "generation": "2",
		"status": application.GroupRoomRinging, "participants": `[{"user_id":"` + userID.String() + `","device_id":"device"}]`,
		"connections": connections, "expires_at": time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano),
	}).Err(); err != nil {
		t.Fatalf("seed newer room: %v", err)
	}
	if err := coordinator.client.Set(ctx, groupRoomConversationKey(conversationID), newerRoomID.String(), time.Minute).Err(); err != nil {
		t.Fatalf("set newer conversation index: %v", err)
	}
	if err := coordinator.client.Set(ctx, groupRoomUserKey(userID), newerRoomID.String(), time.Minute).Err(); err != nil {
		t.Fatalf("set newer user index: %v", err)
	}
	if err := coordinator.AbortGroupRoomStart(ctx, oldRoomID, 1, participant); err != nil {
		t.Fatalf("abort attempted room: %v", err)
	}
	for _, key := range []string{groupRoomConversationKey(conversationID), groupRoomUserKey(userID)} {
		if got, err := coordinator.client.Get(ctx, key).Result(); err != nil || got != newerRoomID.String() {
			t.Fatalf("index %s = %q, %v; want newer room %s", key, got, err, newerRoomID)
		}
	}
	newRoom, err := coordinator.GetGroupRoom(ctx, newerRoomID)
	if err != nil || newRoom.Generation != 2 || newRoom.Status != application.GroupRoomRinging || newRoom.Participants[0].ConnectionID != "new-socket" {
		t.Fatalf("new generation changed: room=%#v err=%v", newRoom, err)
	}
	oldRoom, err := coordinator.GetGroupRoom(ctx, oldRoomID)
	if err != nil || oldRoom.Status != application.GroupRoomEnded {
		t.Fatalf("attempted room not cleaned: room=%#v err=%v", oldRoom, err)
	}
	if err := coordinator.AbortGroupRoomStart(ctx, newerRoomID, 1, newOwner); !errors.Is(err, application.ErrCallNotAllowed) {
		t.Fatalf("stale generation cleanup = %v, want not allowed", err)
	}
}

func TestReadCursorFanoutCarriesAllAuthorizedGroupPeers(t *testing.T) {
	rawURL := os.Getenv("ZWEI_TEST_REDIS_URL")
	if rawURL == "" {
		t.Skip("set ZWEI_TEST_REDIS_URL to run Redis integration tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	coordinator, err := NewPresenceCoordinator(rawURL)
	if err != nil {
		t.Fatalf("create coordinator: %v", err)
	}
	defer coordinator.Close()
	readerID, conversationID := uuid.New(), uuid.New()
	peerIDs := []uuid.UUID{uuid.New(), uuid.New()}
	changes := make(chan ReadChange, 1)
	consumeCtx, stopConsume := context.WithCancel(ctx)
	defer stopConsume()
	go func() {
		_ = coordinator.ConsumeReads(consumeCtx, func(change ReadChange) { changes <- change })
	}()

	deadline := time.Now().Add(2 * time.Second)
	for {
		if err := coordinator.PublishRead(ctx, readerID, peerIDs, conversationID, 12, 4); err != nil {
			t.Fatalf("publish read event: %v", err)
		}
		select {
		case change := <-changes:
			if change.ReaderID != readerID || change.ConversationID != conversationID || change.Sequence != 12 || change.VisibleFromSequence != 4 || len(change.RecipientIDs) != 2 || change.RecipientIDs[0] != peerIDs[0] || change.RecipientIDs[1] != peerIDs[1] {
				t.Fatalf("read pubsub change = %+v", change)
			}
			// The legacy direct-recipient field remains populated for older Redis
			// publishers/consumers while the array supports group fan-out.
			if err := coordinator.PublishRead(ctx, readerID, peerIDs[:1], conversationID, 13, 4); err != nil {
				t.Fatalf("publish direct-compatible read event: %v", err)
			}
			select {
			case directChange := <-changes:
				if directChange.RecipientID != peerIDs[0] || len(directChange.RecipientIDs) != 1 || directChange.RecipientIDs[0] != peerIDs[0] {
					t.Fatalf("direct-compatible read pubsub change = %+v", directChange)
				}
			case <-time.After(time.Second):
				t.Fatal("timed out waiting for direct-compatible read event")
			}
			return
		case <-time.After(50 * time.Millisecond):
			if time.Now().After(deadline) {
				t.Fatal("timed out waiting for read pubsub event")
			}
		}
	}
}

func TestExpireGroupRoomsPreservesTerminalTargetsAndReleasesReservations(t *testing.T) {
	rawURL := os.Getenv("ZWEI_TEST_REDIS_URL")
	if rawURL == "" {
		t.Skip("set ZWEI_TEST_REDIS_URL to run Redis integration tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	coordinator, err := NewPresenceCoordinator(rawURL)
	if err != nil {
		t.Fatalf("create coordinator: %v", err)
	}
	defer coordinator.Close()

	roomID, conversationID := uuid.New(), uuid.New()
	participant := application.GroupParticipant{UserID: uuid.New(), DeviceID: uuid.NewString(), ConnectionID: uuid.NewString()}
	defer func() {
		_ = coordinator.client.Del(ctx, groupRoomKey(roomID), groupRoomConversationKey(conversationID), groupRoomUserKey(participant.UserID)).Err()
		_ = coordinator.client.ZRem(ctx, groupRoomExpiryKey, roomID.String()).Err()
	}()
	if _, err := startAdmittedGroupRoom(ctx, coordinator, application.GroupRoom{ID: roomID, ConversationID: conversationID, MembershipRevision: 1, Generation: 1, Participants: []application.GroupParticipant{participant}}); err != nil {
		t.Fatalf("start room: %v", err)
	}
	past := time.Now().Add(-time.Second).UnixMilli()
	if err := coordinator.client.HSet(ctx, groupRoomKey(roomID), "expires_at_unix_ms", past).Err(); err != nil {
		t.Fatalf("expire room state: %v", err)
	}
	if err := coordinator.client.ZAdd(ctx, groupRoomExpiryKey, redis.Z{Score: float64(past), Member: roomID.String()}).Err(); err != nil {
		t.Fatalf("schedule expiry: %v", err)
	}

	expired, err := coordinator.ExpireGroupRooms(ctx, 10)
	var expiredRoom *application.GroupRoom
	for index := range expired {
		if expired[index].ID == roomID {
			expiredRoom = &expired[index]
			break
		}
	}
	if err != nil || expiredRoom == nil || expiredRoom.Status != application.GroupRoomEnded || len(expiredRoom.Participants) != 1 || expiredRoom.Participants[0].ConnectionID != participant.ConnectionID {
		t.Fatalf("expired rooms = %#v, %v", expired, err)
	}
	if _, err := startAdmittedGroupRoom(ctx, coordinator, application.GroupRoom{ID: uuid.New(), ConversationID: conversationID, MembershipRevision: 1, Generation: 2, Participants: []application.GroupParticipant{participant}}); err != nil {
		t.Fatalf("start after expiry cleanup: %v", err)
	}
}

func TestDirectCallAndGroupJoinReservationRace(t *testing.T) {
	rawURL := os.Getenv("ZWEI_TEST_REDIS_URL")
	if rawURL == "" {
		t.Skip("set ZWEI_TEST_REDIS_URL to run Redis integration tests")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	directCoordinator, err := NewPresenceCoordinator(rawURL)
	if err != nil {
		t.Fatalf("create direct-call coordinator: %v", err)
	}
	defer directCoordinator.Close()
	groupCoordinator, err := NewPresenceCoordinator(rawURL)
	if err != nil {
		t.Fatalf("create group-room coordinator: %v", err)
	}
	defer groupCoordinator.Close()

	userID, recipientID, ownerID := uuid.New(), uuid.New(), uuid.New()
	conversationID, roomID, callID := uuid.New(), uuid.New(), uuid.New()
	deviceID, connectionID := uuid.NewString(), uuid.NewString()
	recipientDevice, recipientConnection := uuid.NewString(), uuid.NewString()
	owner := application.GroupParticipant{UserID: ownerID, DeviceID: uuid.NewString(), ConnectionID: uuid.NewString()}
	joiningParticipant := application.GroupParticipant{UserID: userID, DeviceID: deviceID, ConnectionID: connectionID}
	callKeys := []string{callKey(callID), callUserKey(userID), callUserKey(recipientID), callDeviceKey(userID, deviceID), callDeviceKey(recipientID, recipientDevice), "zwei:call:admission:" + userID.String(), "zwei:call:admission:" + recipientID.String()}
	roomKeys := []string{groupRoomKey(roomID), groupRoomConversationKey(conversationID), groupRoomUserKey(ownerID), groupRoomUserKey(userID)}
	defer func() {
		_ = directCoordinator.client.Del(ctx, append(callKeys, roomKeys...)...).Err()
		_ = directCoordinator.client.ZRem(ctx, callExpiryKey(), callID.String()).Err()
		_ = directCoordinator.client.ZRem(ctx, groupRoomExpiryKey, roomID.String()).Err()
		_, _ = directCoordinator.Disconnect(ctx, userID, connectionID)
		_, _ = directCoordinator.Disconnect(ctx, recipientID, recipientConnection)
	}()

	if _, err := startAdmittedGroupRoom(ctx, groupCoordinator, application.GroupRoom{ID: roomID, ConversationID: conversationID, MembershipRevision: 9, Generation: 1, Participants: []application.GroupParticipant{owner}}); err != nil {
		t.Fatalf("start target room: %v", err)
	}
	if _, err := directCoordinator.Connect(ctx, userID, connectionID); err != nil {
		t.Fatalf("connect direct caller: %v", err)
	}
	if _, err := directCoordinator.Connect(ctx, recipientID, recipientConnection); err != nil {
		t.Fatalf("connect call recipient: %v", err)
	}

	ready := make(chan struct{}, 2)
	start := make(chan struct{})
	type outcome struct {
		operation string
		err       error
	}
	outcomes := make(chan outcome, 2)
	go func() {
		ready <- struct{}{}
		<-start
		token, acquireErr := directCoordinator.AcquireCallAdmission(ctx, []uuid.UUID{userID, recipientID})
		if acquireErr != nil {
			outcomes <- outcome{operation: "direct", err: acquireErr}
			return
		}
		defer directCoordinator.ReleaseCallAdmission(ctx, []uuid.UUID{userID, recipientID}, token)
		_, startErr := directCoordinator.Start(ctx, application.Call{ID: callID, ConversationID: uuid.New(), CallerID: userID, RecipientID: recipientID, CallerDeviceID: deviceID, CallerConnectionID: connectionID}, token)
		outcomes <- outcome{operation: "direct", err: startErr}
	}()
	go func() {
		ready <- struct{}{}
		<-start
		token, acquireErr := groupCoordinator.AcquireCallAdmission(ctx, []uuid.UUID{joiningParticipant.UserID})
		if acquireErr != nil {
			outcomes <- outcome{operation: "group", err: acquireErr}
			return
		}
		defer groupCoordinator.ReleaseCallAdmission(ctx, []uuid.UUID{joiningParticipant.UserID}, token)
		_, joinErr := groupCoordinator.JoinGroupRoom(ctx, roomID, joiningParticipant, 9, token)
		outcomes <- outcome{operation: "group", err: joinErr}
	}()
	<-ready
	<-ready
	close(start)

	winners := 0
	for range 2 {
		result := <-outcomes
		if result.err == nil {
			winners++
		} else if !errors.Is(result.err, application.ErrCallBusy) {
			t.Fatalf("%s reservation: %v", result.operation, result.err)
		}
	}
	if winners != 1 {
		t.Fatalf("reservation winners = %d, want exactly one", winners)
	}

	callReservation, err := directCoordinator.client.Get(ctx, callUserKey(userID)).Result()
	if err == redis.Nil {
		callReservation = ""
	} else if err != nil {
		t.Fatalf("read direct reservation: %v", err)
	}
	groupReservation, err := directCoordinator.client.Get(ctx, groupRoomUserKey(userID)).Result()
	if err == redis.Nil {
		groupReservation = ""
	} else if err != nil {
		t.Fatalf("read group reservation: %v", err)
	}
	if (callReservation != "") == (groupReservation != "") {
		t.Fatalf("expected exactly one reservation, direct=%q group=%q", callReservation, groupReservation)
	}
	if _, err := directCoordinator.client.Get(ctx, "zwei:call:admission:"+userID.String()).Result(); err != redis.Nil {
		t.Fatalf("admission lock was not released: %v", err)
	}
}

func TestAdmissionTokenFencesStaleDirectStartAndConflictsWithGroupStart(t *testing.T) {
	rawURL := os.Getenv("ZWEI_TEST_REDIS_URL")
	if rawURL == "" {
		t.Skip("set ZWEI_TEST_REDIS_URL to run Redis integration tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	coordinator, err := NewPresenceCoordinator(rawURL)
	if err != nil {
		t.Fatalf("create coordinator: %v", err)
	}
	defer coordinator.Close()

	callerID, recipientID := uuid.New(), uuid.New()
	conversationID, staleCallID, winningCallID, roomID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	callerDevice, callerConnection := uuid.NewString(), uuid.NewString()
	users := []uuid.UUID{callerID, recipientID}
	leaseKey := "zwei:call:admission:" + callerID.String()
	room := application.GroupRoom{ID: roomID, ConversationID: conversationID, MembershipRevision: 1, Generation: 1, Participants: []application.GroupParticipant{{UserID: callerID, DeviceID: callerDevice, ConnectionID: callerConnection}}}
	call := application.Call{ID: staleCallID, ConversationID: conversationID, CallerID: callerID, RecipientID: recipientID, CallerDeviceID: callerDevice, CallerConnectionID: callerConnection}
	defer func() {
		_ = coordinator.client.Del(ctx, leaseKey, "zwei:call:admission:"+recipientID.String(), callKey(staleCallID), callKey(winningCallID), callUserKey(callerID), callUserKey(recipientID), callDeviceKey(callerID, callerDevice), groupRoomKey(roomID), groupRoomConversationKey(conversationID), groupRoomUserKey(callerID)).Err()
		_ = coordinator.client.ZRem(ctx, callExpiryKey(), staleCallID.String(), winningCallID.String()).Err()
		_ = coordinator.client.ZRem(ctx, groupRoomExpiryKey, roomID.String()).Err()
	}()
	if _, err := coordinator.Connect(ctx, callerID, callerConnection); err != nil {
		t.Fatalf("connect caller: %v", err)
	}
	if _, err := coordinator.Connect(ctx, recipientID, recipientID.String()+":"+uuid.NewString()); err != nil {
		t.Fatalf("connect recipient: %v", err)
	}

	tokenA, err := coordinator.AcquireCallAdmission(ctx, users)
	if err != nil {
		t.Fatalf("acquire token A: %v", err)
	}
	if err := coordinator.client.Del(ctx, leaseKey, "zwei:call:admission:"+recipientID.String()).Err(); err != nil {
		t.Fatalf("expire token A lease: %v", err)
	}
	tokenB, err := coordinator.AcquireCallAdmission(ctx, users)
	if err != nil {
		t.Fatalf("acquire replacement token B: %v", err)
	}
	if tokenA == tokenB {
		t.Fatal("replacement admission reused stale token")
	}
	if _, err := coordinator.Start(ctx, call, tokenA); !errors.Is(err, application.ErrCallBusy) {
		t.Fatalf("stale A commit error = %v, want busy", err)
	}
	call.ID = winningCallID
	if _, err := coordinator.Start(ctx, call, tokenB); err != nil {
		t.Fatalf("replacement B commit: %v", err)
	}
	if _, err := coordinator.StartGroupRoom(ctx, room, tokenB); !errors.Is(err, application.ErrCallBusy) {
		t.Fatalf("conflicting group start error = %v, want busy", err)
	}
	if _, err := coordinator.AcquireCallAdmission(ctx, []uuid.UUID{callerID}); !errors.Is(err, application.ErrCallBusy) {
		t.Fatalf("group contender admission error = %v, want busy", err)
	}

	callReservation, err := coordinator.client.Get(ctx, callUserKey(callerID)).Result()
	if err != nil || callReservation != winningCallID.String() {
		t.Fatalf("direct reservation = %q, %v; want exactly winning call %s", callReservation, err, winningCallID)
	}
	groupReservation, err := coordinator.client.Get(ctx, groupRoomUserKey(callerID)).Result()
	if err != redis.Nil || groupReservation != "" {
		t.Fatalf("group reservation = %q, %v; want none", groupReservation, err)
	}
	coordinator.ReleaseCallAdmission(ctx, users, tokenA)
	if value, err := coordinator.client.Get(ctx, leaseKey).Result(); err != nil || value != tokenB {
		t.Fatalf("stale cleanup changed replacement lease: value=%q err=%v", value, err)
	}
}
