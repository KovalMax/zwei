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
	attempt, _, err := coordinator.PrepareGroupRoomStart(ctx, room.ConversationID, room.Participants[0])
	if err != nil {
		return application.GroupRoom{}, err
	}
	return coordinator.StartPreparedGroupRoom(ctx, room, token, attempt)
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

func TestGroupRoomRingDeadlineDoesNotExpireRoom(t *testing.T) {
	rawURL := os.Getenv("ZWEI_TEST_REDIS_URL")
	if rawURL == "" {
		t.Skip("set ZWEI_TEST_REDIS_URL to run Redis integration tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, err := NewPresenceCoordinator(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	owner := application.GroupParticipant{UserID: uuid.New(), DeviceID: uuid.NewString(), ConnectionID: uuid.NewString()}
	joiner := application.GroupParticipant{UserID: uuid.New(), DeviceID: uuid.NewString(), ConnectionID: uuid.NewString()}
	id, conversation := uuid.New(), uuid.New()
	defer c.client.Del(context.Background(), groupRoomKey(id), groupRoomConversationKey(conversation), groupRoomUserKey(owner.UserID), groupRoomUserKey(joiner.UserID))
	defer c.client.ZRem(context.Background(), groupRoomExpiryKey, id.String())
	room, err := startAdmittedGroupRoom(ctx, c, application.GroupRoom{ID: id, ConversationID: conversation, MembershipRevision: 1, Generation: 1, Participants: []application.GroupParticipant{owner}})
	if err != nil {
		t.Fatal(err)
	}
	if delta := room.ExpiresAt.Sub(room.RingExpiresAt); delta != groupRoomActiveTTL-groupRoomRingingTTL {
		t.Fatalf("deadline separation = %s", delta)
	}
	// Advance only the logical invitation deadline; the room and hard expiry remain unchanged.
	if err := c.client.HSet(ctx, groupRoomKey(id), "ring_expires_at", time.Now().Add(-time.Second).UTC().Format(time.RFC3339Nano)).Err(); err != nil {
		t.Fatal(err)
	}
	other, err := NewPresenceCoordinator(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	joined, err := joinAdmittedGroupRoom(ctx, other, id, joiner, 1)
	if err != nil {
		t.Fatalf("late join: %v", err)
	}
	if !joined.ExpiresAt.Equal(room.ExpiresAt) || joined.Status != application.GroupRoomActive {
		t.Fatalf("late joined room = %+v", joined)
	}
}

func TestJoinMissingGroupRoomReturnsNotFound(t *testing.T) {
	rawURL := os.Getenv("ZWEI_TEST_REDIS_URL")
	if rawURL == "" {
		t.Skip("set ZWEI_TEST_REDIS_URL to run Redis integration tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, err := NewPresenceCoordinator(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	participant := application.GroupParticipant{UserID: uuid.New(), DeviceID: uuid.NewString(), ConnectionID: uuid.NewString()}
	_, err = joinAdmittedGroupRoom(ctx, c, uuid.New(), participant, 1)
	if !errors.Is(err, application.ErrCallNotFound) {
		t.Fatalf("join missing room error = %v, want ErrCallNotFound", err)
	}
}

func TestGroupRoomRenewalRequiresLiveOwnerAndCannotReviveExpiredRoom(t *testing.T) {
	rawURL := os.Getenv("ZWEI_TEST_REDIS_URL")
	if rawURL == "" {
		t.Skip("set ZWEI_TEST_REDIS_URL to run Redis integration tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, err := NewPresenceCoordinator(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	owner := application.GroupParticipant{UserID: uuid.New(), DeviceID: uuid.NewString(), ConnectionID: uuid.NewString()}
	id, conversation := uuid.New(), uuid.New()
	defer c.client.Del(context.Background(), groupRoomKey(id), groupRoomConversationKey(conversation), groupRoomUserKey(owner.UserID))
	defer c.client.ZRem(context.Background(), groupRoomExpiryKey, id.String())
	room, err := startAdmittedGroupRoom(ctx, c, application.GroupRoom{ID: id, ConversationID: conversation, MembershipRevision: 1, Generation: 1, Participants: []application.GroupParticipant{owner}})
	if err != nil {
		t.Fatal(err)
	}
	now := room.ExpiresAt.Add(-30 * time.Minute)
	if err := c.renewOwnedGroupRoom(ctx, owner.UserID, "wrong-socket", now); err != nil {
		t.Fatal(err)
	}
	unchanged, err := c.GetGroupRoom(ctx, id)
	if err != nil || !unchanged.ExpiresAt.Equal(room.ExpiresAt) {
		t.Fatalf("wrong owner renewed: %+v %v", unchanged, err)
	}
	if _, err := c.Connect(ctx, owner.UserID, owner.ConnectionID); err != nil {
		t.Fatal(err)
	}
	c.mu.Lock()
	c.renewOwnedGroupRoomsLocked(ctx, now)
	c.mu.Unlock()
	renewed, err := c.GetGroupRoom(ctx, id)
	if err != nil || !renewed.ExpiresAt.Equal(now.Add(groupRoomActiveTTL)) {
		t.Fatalf("owned renewal: %+v %v", renewed, err)
	}
	if score, err := c.client.ZScore(ctx, groupRoomExpiryKey, id.String()).Result(); err != nil || int64(score) != renewed.ExpiresAt.UnixMilli() {
		t.Fatalf("renewed expiry index: score=%v err=%v", score, err)
	}
	if ttl, err := c.client.PTTL(ctx, groupRoomKey(id)).Result(); err != nil || ttl != -1 {
		t.Fatalf("indexed live room must survive until sweep: ttl=%s err=%v", ttl, err)
	}
	if _, err := c.Disconnect(ctx, owner.UserID, owner.ConnectionID); err != nil {
		t.Fatal(err)
	}
	c.mu.Lock()
	c.renewOwnedGroupRoomsLocked(ctx, renewed.ExpiresAt.Add(-30*time.Minute))
	c.mu.Unlock()
	unchanged, err = c.GetGroupRoom(ctx, id)
	if err != nil || !unchanged.ExpiresAt.Equal(renewed.ExpiresAt) {
		t.Fatalf("disconnected socket renewed: %+v %v", unchanged, err)
	}
	if err := c.renewOwnedGroupRoom(ctx, owner.UserID, owner.ConnectionID, renewed.ExpiresAt); err != nil {
		t.Fatal(err)
	}
	unchanged, err = c.GetGroupRoom(ctx, id)
	if err != nil || !unchanged.ExpiresAt.Equal(renewed.ExpiresAt) {
		t.Fatalf("expired room revived: %+v %v", unchanged, err)
	}
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
	replica, err := NewPresenceCoordinator(rawURL)
	if err != nil {
		t.Fatalf("create second coordinator: %v", err)
	}
	defer replica.Close()

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

	supportRef := uuid.New()
	room, err := startAdmittedGroupRoom(ctx, coordinator, application.GroupRoom{ID: roomID, SupportRef: supportRef, ConversationID: conversationID, MembershipRevision: 7, Generation: 1, Participants: participants[:1]})
	if err != nil {
		t.Fatalf("start room: %v", err)
	}
	// Simulate a reservation with only a short ringing lifetime left; joining
	// must extend the starter reservation together with the room itself.
	if err := coordinator.client.Expire(ctx, groupRoomUserKey(participants[0].UserID), 2*time.Second).Err(); err != nil {
		t.Fatalf("shorten starter reservation: %v", err)
	}
	if room.Status != application.GroupRoomRinging || len(room.Participants) != 1 || room.Participants[0].ConnectionID != participants[0].ConnectionID {
		t.Fatalf("started room = %#v", room)
	}
	fromRedis, err := replica.GetGroupRoom(ctx, roomID)
	if err != nil || fromRedis.SupportRef != supportRef {
		t.Fatalf("group room support_ref from shared state = %s, want %s (err=%v)", fromRedis.SupportRef, supportRef, err)
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
		} else if !errors.Is(err, application.ErrGroupRoomFull) {
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
	starterReservation := groupRoomUserKey(participants[0].UserID)
	starterTTL, err := coordinator.client.TTL(ctx, starterReservation).Result()
	if err != nil || starterTTL <= groupRoomActiveTTL || starterTTL > groupRoomActiveTTL+groupRoomEndedTTL {
		t.Fatalf("starter reservation TTL = %s, err=%v; want active lifetime plus ended retention", starterTTL, err)
	}
	time.Sleep(2100 * time.Millisecond)
	if reservation, err := coordinator.client.Get(ctx, starterReservation).Result(); err != nil || reservation != roomID.String() {
		t.Fatalf("starter reservation after ringing TTL = %q, err=%v; want room %s", reservation, err, roomID)
	}
	competingToken, err := coordinator.AcquireCallAdmission(ctx, []uuid.UUID{participants[0].UserID})
	if err != nil {
		t.Fatalf("acquire competing call admission: %v", err)
	}
	_, err = coordinator.Start(ctx, application.Call{
		ID: uuid.New(), CallerID: participants[0].UserID, RecipientID: uuid.New(),
		CallerDeviceID: uuid.NewString(), CallerConnectionID: uuid.NewString(),
	}, competingToken)
	coordinator.ReleaseCallAdmission(ctx, []uuid.UUID{participants[0].UserID}, competingToken)
	if !errors.Is(err, application.ErrCallBusy) {
		t.Fatalf("competing call for starter = %v, want call busy", err)
	}
	conversationTTL, err := coordinator.client.TTL(ctx, groupRoomConversationKey(conversationID)).Result()
	if err != nil || conversationTTL <= groupRoomRingingTTL+groupRoomEndedTTL || conversationTTL > groupRoomActiveTTL+groupRoomEndedTTL {
		t.Fatalf("active conversation index TTL = %s, err=%v; want it extended with the active room lifetime", conversationTTL, err)
	}
	joinedParticipant := room.Participants[1]
	reservationKey := groupRoomUserKey(joinedParticipant.UserID)
	if reservation, err := coordinator.client.Get(ctx, reservationKey).Result(); err != nil || reservation != roomID.String() {
		t.Fatalf("joined participant reservation = %q, err=%v; want room %s", reservation, err, roomID)
	}
	reservationTTL, err := coordinator.client.TTL(ctx, reservationKey).Result()
	if err != nil || reservationTTL <= groupRoomActiveTTL || reservationTTL > groupRoomActiveTTL+groupRoomEndedTTL {
		t.Fatalf("joined participant reservation TTL = %s, err=%v; want active lifetime plus ended retention", reservationTTL, err)
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

func TestStaleGroupRoomLeaveAndEndPreserveNewConversationIndex(t *testing.T) {
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

	for _, cleanup := range []string{"leave", "end"} {
		t.Run(cleanup, func(t *testing.T) {
			conversationID, userID := uuid.New(), uuid.New()
			oldRoomID, newerRoomID := uuid.New(), uuid.New()
			participant := application.GroupParticipant{UserID: userID, DeviceID: uuid.NewString(), ConnectionID: uuid.NewString()}
			keys := []string{groupRoomKey(oldRoomID), groupRoomKey(newerRoomID), groupRoomConversationKey(conversationID), groupRoomUserKey(userID)}
			defer coordinator.client.Del(ctx, keys...)
			if _, err := startAdmittedGroupRoom(ctx, coordinator, application.GroupRoom{ID: oldRoomID, ConversationID: conversationID, MembershipRevision: 1, Generation: 1, Participants: []application.GroupParticipant{participant}}); err != nil {
				t.Fatalf("start old room: %v", err)
			}
			if err := coordinator.client.HSet(ctx, groupRoomKey(newerRoomID), map[string]any{
				"conversation_id": conversationID.String(), "membership_revision": "2", "generation": "2",
				"status": application.GroupRoomRinging, "participants": "[]", "connections": "",
			}).Err(); err != nil {
				t.Fatalf("seed new room: %v", err)
			}
			for key := range map[string]string{groupRoomConversationKey(conversationID): newerRoomID.String(), groupRoomUserKey(userID): newerRoomID.String()} {
				if err := coordinator.client.Set(ctx, key, newerRoomID.String(), time.Minute).Err(); err != nil {
					t.Fatalf("set newer index %s: %v", key, err)
				}
			}
			if cleanup == "leave" {
				_, err = coordinator.LeaveGroupRoom(ctx, oldRoomID, participant)
			} else {
				_, err = coordinator.EndGroupRoom(ctx, oldRoomID, participant)
			}
			if err != nil {
				t.Fatalf("old room %s cleanup: %v", cleanup, err)
			}
			for _, key := range []string{groupRoomConversationKey(conversationID), groupRoomUserKey(userID)} {
				if got, err := coordinator.client.Get(ctx, key).Result(); err != nil || got != newerRoomID.String() {
					t.Fatalf("index %s = %q, %v; want newer room %s", key, got, err, newerRoomID)
				}
			}
		})
	}
}

func TestDiscoverableGroupRoomIndexIntegration(t *testing.T) {
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

	roomID, conversationID, otherConversationID := uuid.New(), uuid.New(), uuid.New()
	owner := application.GroupParticipant{UserID: uuid.New(), DeviceID: "owner-device", ConnectionID: "owner-socket"}
	keys := []string{groupRoomKey(roomID), groupRoomConversationKey(conversationID), groupRoomConversationKey(otherConversationID), groupRoomUserKey(owner.UserID)}
	defer func() {
		_ = coordinator.client.Del(ctx, keys...).Err()
		_ = coordinator.client.ZRem(ctx, groupRoomExpiryKey, roomID.String()).Err()
	}()
	if _, err := coordinator.GetGroupRoomForConversation(ctx, conversationID); !errors.Is(err, application.ErrCallNotFound) {
		t.Fatalf("discovery before start = %v, want no room", err)
	}
	started, err := startAdmittedGroupRoom(ctx, coordinator, application.GroupRoom{ID: roomID, ConversationID: conversationID, MembershipRevision: 5, Generation: 1, Participants: []application.GroupParticipant{owner}})
	if err != nil {
		t.Fatalf("start room: %v", err)
	}
	discovered, err := coordinator.GetGroupRoomForConversation(ctx, conversationID)
	if err != nil || discovered.ID != roomID || discovered.Generation != started.Generation || discovered.MembershipRevision != 5 || discovered.Status != application.GroupRoomRinging {
		t.Fatalf("discovered room=%#v err=%v", discovered, err)
	}
	if discovered.Participants[0].ConnectionID != owner.ConnectionID {
		t.Fatalf("internal room lost socket binding: %#v", discovered.Participants[0])
	}
	if err := coordinator.client.Set(ctx, groupRoomConversationKey(otherConversationID), roomID.String(), time.Minute).Err(); err != nil {
		t.Fatalf("seed mismatched room index: %v", err)
	}
	if _, err := coordinator.GetGroupRoomForConversation(ctx, otherConversationID); !errors.Is(err, application.ErrCallNotFound) {
		t.Fatalf("mismatched room index discovery = %v, want no room", err)
	}
	if _, err := coordinator.EndGroupRoom(ctx, roomID, owner); err != nil {
		t.Fatalf("end room: %v", err)
	}
	if _, err := coordinator.GetGroupRoomForConversation(ctx, conversationID); !errors.Is(err, application.ErrCallNotFound) {
		t.Fatalf("discovery after end = %v, want no room", err)
	}
}

func TestMembershipRetirementReturnsAtomicTerminalRevisionIntegration(t *testing.T) {
	rawURL := os.Getenv("ZWEI_TEST_REDIS_URL")
	if rawURL == "" {
		t.Skip("set ZWEI_TEST_REDIS_URL to run Redis integration tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, err := NewPresenceCoordinator(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	roomID, conversationID, userID := uuid.New(), uuid.New(), uuid.New()
	owner := application.GroupParticipant{UserID: userID, DeviceID: "owner", ConnectionID: "socket"}
	defer c.client.Del(ctx, groupRoomKey(roomID), groupRoomConversationKey(conversationID), groupRoomUserKey(userID))
	room, err := startAdmittedGroupRoom(ctx, c, application.GroupRoom{ID: roomID, ConversationID: conversationID, MembershipRevision: 2, Generation: 3, Participants: []application.GroupParticipant{owner}})
	if err != nil {
		t.Fatal(err)
	}
	terminal, err := c.EndGroupRoomForMembershipChange(ctx, conversationID, roomID, room.Generation, room.StateRevision, 3)
	if err != nil || terminal.StateRevision != room.StateRevision+1 || terminal.Status != application.GroupRoomEnded {
		t.Fatalf("terminal=%#v err=%v", terminal, err)
	}
	stored, err := c.GetGroupRoom(ctx, roomID)
	if err != nil || stored.StateRevision != terminal.StateRevision || stored.Status != application.GroupRoomEnded {
		t.Fatalf("stored=%#v err=%v", stored, err)
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
	for _, test := range []struct {
		name        string
		participant application.GroupParticipant
		want        string
	}{
		{"ringing owner", owner, "active"},
		{"ringing sibling", application.GroupParticipant{UserID: owner.UserID, DeviceID: owner.DeviceID, ConnectionID: "sibling"}, "owned_elsewhere"},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, status, err := coordinator.SyncGroupRoomOwnership(ctx, conversationID, roomID, 5, 12, test.participant)
			if err != nil || status != test.want || (status == "active" && (got.Status != application.GroupRoomRinging || len(got.Participants) != 1)) || (status != "active" && len(got.Participants) != 0) {
				t.Fatalf("ringing ownership = %q room=%#v err=%v", status, got, err)
			}
		})
	}
	if err := coordinator.client.HSet(ctx, groupRoomKey(roomID), "expires_at", time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano)).Err(); err != nil {
		t.Fatal(err)
	}
	if got, status, err := coordinator.SyncGroupRoomOwnership(ctx, conversationID, roomID, 5, 12, owner); err != nil || status != "room_unavailable" || len(got.Participants) != 0 {
		t.Fatalf("expired ringing: %q %#v %v", status, got, err)
	}
	if err := coordinator.client.HSet(ctx, groupRoomKey(roomID), "expires_at", room.ExpiresAt.UTC().Format(time.RFC3339Nano)).Err(); err != nil {
		t.Fatal(err)
	}
	room, err = joinAdmittedGroupRoom(ctx, coordinator, roomID, member, 12)
	if err != nil || room.StateRevision != 2 || room.Status != application.GroupRoomActive {
		t.Fatalf("join room = %#v, err=%v", room, err)
	}
	if absent, err := coordinator.GroupReservationAbsent(ctx, member.UserID); err != nil || absent {
		t.Fatalf("revoked member still reserved: absent=%v err=%v", absent, err)
	}
	for _, test := range []struct {
		name                 string
		conversation         uuid.UUID
		generation, revision int64
		participant          application.GroupParticipant
		want                 string
	}{
		{"owner", conversationID, 5, 12, owner, "active"},
		{"sibling socket", conversationID, 5, 12, application.GroupParticipant{UserID: owner.UserID, DeviceID: owner.DeviceID, ConnectionID: "sibling"}, "owned_elsewhere"},
		{"other device", conversationID, 5, 12, application.GroupParticipant{UserID: owner.UserID, DeviceID: "other", ConnectionID: "other"}, "owned_elsewhere"},
		{"absent", conversationID, 5, 12, application.GroupParticipant{UserID: uuid.New(), DeviceID: "absent", ConnectionID: "absent"}, "participant_absent"},
		{"wrong conversation", uuid.New(), 5, 12, owner, "room_unavailable"},
		{"wrong generation", conversationID, 6, 12, owner, "room_unavailable"},
		{"stale membership", conversationID, 5, 13, owner, "room_unavailable"},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, status, err := coordinator.SyncGroupRoomOwnership(ctx, test.conversation, roomID, test.generation, test.revision, test.participant)
			if err != nil || status != test.want || (status == "active" && len(got.Participants) != 2) || (status != "active" && len(got.Participants) != 0) {
				t.Fatalf("ownership = %q room=%#v err=%v", status, got, err)
			}
		})
	}
	if err := coordinator.client.Del(ctx, groupRoomUserKey(owner.UserID)).Err(); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name                 string
		conversation         uuid.UUID
		generation, revision int64
	}{
		{"stale membership", conversationID, 5, 13},
		{"wrong generation", conversationID, 6, 12},
		{"wrong conversation", uuid.New(), 5, 12},
	} {
		t.Run("missing reservation/"+test.name, func(t *testing.T) {
			got, status, err := coordinator.SyncGroupRoomOwnership(ctx, test.conversation, roomID, test.generation, test.revision, owner)
			if err != nil || status != "room_unavailable" || len(got.Participants) != 0 {
				t.Fatalf("ownership = %q room=%#v err=%v, want room_unavailable", status, got, err)
			}
		})
	}
	if err := coordinator.client.Set(ctx, groupRoomUserKey(owner.UserID), roomID.String(), groupRoomActiveTTL).Err(); err != nil {
		t.Fatal(err)
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
	if absent, err := coordinator.GroupReservationAbsent(ctx, member.UserID); err != nil || !absent {
		t.Fatalf("released member: absent=%v err=%v", absent, err)
	}
	for _, requestedRoom := range []uuid.UUID{roomID, uuid.New()} {
		got, status, err := coordinator.SyncGroupRoomOwnership(ctx, conversationID, requestedRoom, 5, 13, member)
		if err != nil || status != "participant_absent" || got.ID != uuid.Nil || len(got.Participants) != 0 {
			t.Fatalf("stale/released ownership: %q %#v %v", status, got, err)
		}
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

func TestGroupRoomOwnershipTerminalAbsenceIntegration(t *testing.T) {
	rawURL := os.Getenv("ZWEI_TEST_REDIS_URL")
	if rawURL == "" {
		t.Skip("set ZWEI_TEST_REDIS_URL to run Redis integration tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, err := NewPresenceCoordinator(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	roomID, conversationID := uuid.New(), uuid.New()
	owner := application.GroupParticipant{UserID: uuid.New(), DeviceID: "device", ConnectionID: "socket"}
	defer c.client.Del(ctx, groupRoomKey(roomID), groupRoomConversationKey(conversationID), groupRoomUserKey(owner.UserID))
	check := func(name, want string) {
		t.Helper()
		room, status, err := c.SyncGroupRoomOwnership(ctx, conversationID, roomID, 1, 1, owner)
		if err != nil || status != want || len(room.Participants) != 0 {
			t.Fatalf("%s: status=%q room=%#v err=%v, want %s", name, status, room, err, want)
		}
	}
	check("missing", "participant_absent")
	if _, err := startAdmittedGroupRoom(ctx, c, application.GroupRoom{ID: roomID, ConversationID: conversationID, MembershipRevision: 1, Generation: 1, Participants: []application.GroupParticipant{owner}}); err != nil {
		t.Fatal(err)
	}
	if _, err := c.LeaveGroupRoom(ctx, roomID, owner); err != nil {
		t.Fatal(err)
	}
	check("last participant left", "participant_absent")
	if n, err := c.client.Exists(ctx, groupRoomUserKey(owner.UserID), groupRoomConversationKey(conversationID)).Result(); err != nil || n != 0 {
		t.Fatalf("leave left reservation indexes: count=%d err=%v", n, err)
	}
	if err := c.client.HSet(ctx, groupRoomKey(roomID), "status", "active", "expires_at", time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano)).Err(); err != nil {
		t.Fatal(err)
	}
	check("expired", "participant_absent")
	if err := c.client.Set(ctx, groupRoomUserKey(owner.UserID), uuid.NewString(), time.Minute).Err(); err != nil {
		t.Fatal(err)
	}
	check("expired with other reservation", "room_unavailable")
	if err := c.client.Del(ctx, groupRoomKey(roomID)).Err(); err != nil {
		t.Fatal(err)
	}
	check("missing with other reservation", "room_unavailable")
	if err := c.client.Set(ctx, groupRoomUserKey(owner.UserID), "", time.Minute).Err(); err != nil {
		t.Fatal(err)
	}
	check("missing with empty reservation key", "room_unavailable")
	if err := c.client.Del(ctx, groupRoomUserKey(owner.UserID)).Err(); err != nil {
		t.Fatal(err)
	}
	if err := c.client.HSet(ctx, groupRoomKey(roomID), "status", "ended").Err(); err != nil {
		t.Fatal(err)
	}
	check("corrupt room", "room_unavailable")
}

func TestGroupRoomOwnershipAfterExpiryCleanupIntegration(t *testing.T) {
	rawURL := os.Getenv("ZWEI_TEST_REDIS_URL")
	if rawURL == "" {
		t.Skip("set ZWEI_TEST_REDIS_URL to run Redis integration tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, err := NewPresenceCoordinator(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	roomID, conversationID := uuid.New(), uuid.New()
	owner := application.GroupParticipant{UserID: uuid.New(), DeviceID: "device", ConnectionID: "socket"}
	defer c.client.Del(ctx, groupRoomKey(roomID), groupRoomConversationKey(conversationID), groupRoomUserKey(owner.UserID))
	defer c.client.ZRem(ctx, groupRoomExpiryKey, roomID.String())
	if _, err := startAdmittedGroupRoom(ctx, c, application.GroupRoom{ID: roomID, ConversationID: conversationID, MembershipRevision: 1, Generation: 1, Participants: []application.GroupParticipant{owner}}); err != nil {
		t.Fatal(err)
	}
	if err := c.client.HSet(ctx, groupRoomKey(roomID), "expires_at", time.Now().Add(-time.Second).UTC().Format(time.RFC3339Nano), "expires_at_unix_ms", time.Now().Add(-time.Second).UnixMilli()).Err(); err != nil {
		t.Fatal(err)
	}
	if err := c.client.ZAdd(ctx, groupRoomExpiryKey, redis.Z{Score: float64(time.Now().Add(-time.Second).UnixMilli()), Member: roomID.String()}).Err(); err != nil {
		t.Fatal(err)
	}
	if _, err := c.ExpireGroupRooms(ctx, 10); err != nil {
		t.Fatal(err)
	}
	for _, revision := range []int64{1, 2} {
		_, status, err := c.SyncGroupRoomOwnership(ctx, conversationID, roomID, 1, revision, owner)
		if err != nil || status != "participant_absent" {
			t.Fatalf("after expiry revision=%d: status=%q err=%v", revision, status, err)
		}
	}
	if n, err := c.client.Exists(ctx, groupRoomUserKey(owner.UserID), groupRoomConversationKey(conversationID)).Result(); err != nil || n != 0 {
		t.Fatalf("expiry left reservation indexes: count=%d err=%v", n, err)
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
	if ttl, err := coordinator.client.TTL(ctx, groupRoomUserKey(userID)).Result(); err != nil || ttl <= 0 {
		t.Fatalf("newer room reservation TTL = %s, err=%v; old-room cleanup must not remove it", ttl, err)
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

func TestJoinOlderGroupRoomDoesNotRefreshNewerConversationIndex(t *testing.T) {
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

	conversationID, starterID, joinerID := uuid.New(), uuid.New(), uuid.New()
	oldRoomID, newerRoomID := uuid.New(), uuid.New()
	starter := application.GroupParticipant{UserID: starterID, DeviceID: "starter-device", ConnectionID: "starter-socket"}
	joiner := application.GroupParticipant{UserID: joinerID, DeviceID: "joiner-device", ConnectionID: "joiner-socket"}
	conversationKey, starterKey := groupRoomConversationKey(conversationID), groupRoomUserKey(starterID)
	keys := []string{groupRoomKey(oldRoomID), groupRoomKey(newerRoomID), conversationKey, starterKey, groupRoomUserKey(joinerID), groupRoomExpiryKey}
	defer coordinator.client.Del(ctx, keys...)

	if _, err := startAdmittedGroupRoom(ctx, coordinator, application.GroupRoom{
		ID: oldRoomID, ConversationID: conversationID, MembershipRevision: 7, Generation: 1,
		Participants: []application.GroupParticipant{starter},
	}); err != nil {
		t.Fatalf("start older room: %v", err)
	}
	longTTL := 3 * time.Hour
	if err := coordinator.client.Set(ctx, conversationKey, newerRoomID.String(), longTTL).Err(); err != nil {
		t.Fatalf("set newer conversation index: %v", err)
	}
	if err := coordinator.client.Set(ctx, starterKey, newerRoomID.String(), longTTL).Err(); err != nil {
		t.Fatalf("set newer user reservation: %v", err)
	}
	minimumPreservedTTL := longTTL - 5*time.Second

	if _, err := joinAdmittedGroupRoom(ctx, coordinator, oldRoomID, joiner, 7); !errors.Is(err, application.ErrCallBusy) {
		t.Fatalf("stale room join = %v, want busy conflict", err)
	}
	for _, key := range []string{conversationKey, starterKey} {
		if got, err := coordinator.client.Get(ctx, key).Result(); err != nil || got != newerRoomID.String() {
			t.Fatalf("index %s = %q, %v; want newer room %s", key, got, err, newerRoomID)
		}
		if ttl, err := coordinator.client.TTL(ctx, key).Result(); err != nil || ttl < minimumPreservedTTL {
			t.Fatalf("newer index %s TTL = %s, err=%v; want at least %s after stale join", key, ttl, err, minimumPreservedTTL)
		}
	}
	room, err := coordinator.GetGroupRoom(ctx, oldRoomID)
	if err != nil {
		t.Fatalf("get older room: %v", err)
	}
	if room.Status != application.GroupRoomRinging || len(room.Participants) != 1 {
		t.Fatalf("stale join changed older room: %#v", room)
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
			if err := coordinator.PublishRead(ctx, readerID, peerIDs[:1], conversationID, 13, 4); err != nil {
				t.Fatalf("publish direct read event: %v", err)
			}
			select {
			case directChange := <-changes:
				if len(directChange.RecipientIDs) != 1 || directChange.RecipientIDs[0] != peerIDs[0] {
					t.Fatalf("direct read pubsub change = %+v", directChange)
				}
			case <-time.After(time.Second):
				t.Fatal("timed out waiting for direct read event")
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
	if err := coordinator.AckExpiredGroupRoom(ctx, *expiredRoom); err != nil {
		t.Fatalf("ack expiry: %v", err)
	}
	if _, err := startAdmittedGroupRoom(ctx, coordinator, application.GroupRoom{ID: uuid.New(), ConversationID: conversationID, MembershipRevision: 1, Generation: 2, Participants: []application.GroupParticipant{participant}}); err != nil {
		t.Fatalf("start after expiry cleanup: %v", err)
	}
}

func TestExpiredGroupRoomClaimRetriesAndFencesStaleAck(t *testing.T) {
	rawURL := os.Getenv("ZWEI_TEST_REDIS_URL")
	if rawURL == "" {
		t.Skip("set ZWEI_TEST_REDIS_URL to run Redis integration tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	a, err := NewPresenceCoordinator(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	b, err := NewPresenceCoordinator(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	id, conversation := uuid.New(), uuid.New()
	owner := application.GroupParticipant{UserID: uuid.New(), DeviceID: uuid.NewString(), ConnectionID: uuid.NewString()}
	defer a.client.Del(context.Background(), groupRoomKey(id), groupRoomConversationKey(conversation), groupRoomUserKey(owner.UserID))
	defer a.client.ZRem(context.Background(), groupRoomExpiryKey, id.String())
	if _, err := startAdmittedGroupRoom(ctx, a, application.GroupRoom{ID: id, ConversationID: conversation, MembershipRevision: 1, Generation: 1, Participants: []application.GroupParticipant{owner}}); err != nil {
		t.Fatal(err)
	}
	past := time.Now().Add(-time.Second).UnixMilli()
	if err := a.client.HSet(ctx, groupRoomKey(id), "expires_at_unix_ms", past).Err(); err != nil {
		t.Fatal(err)
	}
	if err := a.client.ZAdd(ctx, groupRoomExpiryKey, redis.Z{Score: float64(past), Member: id.String()}).Err(); err != nil {
		t.Fatal(err)
	}
	first, err := a.ExpireGroupRooms(ctx, 100)
	if err != nil || len(first) != 1 {
		t.Fatalf("first claim=%+v err=%v", first, err)
	}
	concurrent, err := b.ExpireGroupRooms(ctx, 100)
	if err != nil || len(concurrent) != 0 {
		t.Fatalf("overlapping claim=%+v err=%v", concurrent, err)
	}
	ttl, err := a.client.PTTL(ctx, groupRoomKey(id)).Result()
	if err != nil || ttl <= 0 || ttl > groupRoomEndedTTL {
		t.Fatalf("unacked tombstone TTL=%v err=%v", ttl, err)
	}
	deadline, err := a.client.Do(ctx, "PEXPIRETIME", groupRoomKey(id)).Int64()
	if err != nil {
		t.Fatal(err)
	}
	// Simulate an expired worker lease without sleeping; the next replica retries.
	if err := a.client.ZAdd(ctx, groupRoomExpiryKey, redis.Z{Score: float64(past), Member: id.String()}).Err(); err != nil {
		t.Fatal(err)
	}
	second, err := b.ExpireGroupRooms(ctx, 100)
	if err != nil || len(second) != 1 {
		t.Fatalf("retry claim=%+v err=%v", second, err)
	}
	if second[0].StateRevision != first[0].StateRevision || second[0].Participants[0].ConnectionID != owner.ConnectionID {
		t.Fatalf("retry changed terminal snapshot: %+v", second[0])
	}
	if got, err := a.client.Do(ctx, "PEXPIRETIME", groupRoomKey(id)).Int64(); err != nil || got != deadline {
		t.Fatalf("retry extended retention: before=%d after=%d err=%v", deadline, got, err)
	}
	if err := a.AckExpiredGroupRoom(ctx, first[0]); !errors.Is(err, application.ErrCallUnavailable) {
		t.Fatalf("stale ack=%v", err)
	}
	if err := b.AckExpiredGroupRoom(ctx, second[0]); err != nil {
		t.Fatal(err)
	}
	if got, err := a.client.Do(ctx, "PEXPIRETIME", groupRoomKey(id)).Int64(); err != nil || got != deadline {
		t.Fatalf("ack extended retention: before=%d after=%d err=%v", deadline, got, err)
	}
	if n := a.client.ZScore(ctx, groupRoomExpiryKey, id.String()).Err(); n != redis.Nil {
		t.Fatalf("ack left pending index: %v", n)
	}
}

func TestExpiredGroupRoomRetentionAndLegacyClaims(t *testing.T) {
	rawURL := os.Getenv("ZWEI_TEST_REDIS_URL")
	if rawURL == "" {
		t.Skip("set ZWEI_TEST_REDIS_URL to run Redis integration tests")
	}
	for _, mode := range []string{"new pending", "legacy pending", "legacy ack"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			c, err := NewPresenceCoordinator(rawURL)
			if err != nil {
				t.Fatal(err)
			}
			defer c.Close()
			id, conversation := uuid.New(), uuid.New()
			owner := application.GroupParticipant{UserID: uuid.New(), DeviceID: "device", ConnectionID: "socket"}
			defer c.client.Del(ctx, groupRoomKey(id), groupRoomConversationKey(conversation), groupRoomUserKey(owner.UserID))
			defer c.client.ZRem(ctx, groupRoomExpiryKey, id.String())
			if _, err := startAdmittedGroupRoom(ctx, c, application.GroupRoom{ID: id, ConversationID: conversation, MembershipRevision: 1, Generation: 1, Participants: []application.GroupParticipant{owner}}); err != nil {
				t.Fatal(err)
			}
			attemptKey, err := c.client.HGet(ctx, groupRoomKey(id), "start_attempt_key").Result()
			if err != nil {
				t.Fatal(err)
			}
			defer c.client.Del(ctx, attemptKey, groupStartConnectionKey(owner))
			past := time.Now().Add(-time.Second).UnixMilli()
			if err := c.client.HSet(ctx, groupRoomKey(id), "expires_at_unix_ms", past).Err(); err != nil {
				t.Fatal(err)
			}
			if err := c.client.ZAdd(ctx, groupRoomExpiryKey, redis.Z{Score: float64(past), Member: id.String()}).Err(); err != nil {
				t.Fatal(err)
			}
			first, err := c.ExpireGroupRooms(ctx, 100)
			if err != nil || len(first) != 1 || first[0].ID != id {
				t.Fatalf("initial claim=%+v err=%v", first, err)
			}
			if mode != "new pending" {
				// An older service could have retained an unbounded pending room.
				if err := c.client.Persist(ctx, groupRoomKey(id)).Err(); err != nil {
					t.Fatal(err)
				}
				if mode == "legacy ack" {
					if err := c.AckExpiredGroupRoom(ctx, first[0]); err != nil {
						t.Fatalf("ack legacy claim: %v", err)
					}
					if ttl, err := c.client.PTTL(ctx, groupRoomKey(id)).Result(); err != nil || ttl <= 0 || ttl > groupRoomEndedTTL {
						t.Fatalf("legacy ack retention ttl=%s err=%v", ttl, err)
					}
					if err := c.client.ZScore(ctx, groupRoomExpiryKey, id.String()).Err(); err != redis.Nil {
						t.Fatalf("legacy ack left pending index: %v", err)
					}
					return
				}
				if err := c.client.ZAdd(ctx, groupRoomExpiryKey, redis.Z{Score: float64(past), Member: id.String()}).Err(); err != nil {
					t.Fatal(err)
				}
				first, err = c.ExpireGroupRooms(ctx, 100)
				if err != nil || len(first) != 1 || first[0].ID != id {
					t.Fatalf("legacy claim=%+v err=%v", first, err)
				}
			}
			ttl, err := c.client.PTTL(ctx, groupRoomKey(id)).Result()
			if err != nil || ttl <= 0 || ttl > groupRoomEndedTTL {
				t.Fatalf("pending retention ttl=%s err=%v", ttl, err)
			}
			deadline, err := c.client.Do(ctx, "PEXPIRETIME", groupRoomKey(id)).Int64()
			if err != nil {
				t.Fatal(err)
			}
			if err := c.client.ZAdd(ctx, groupRoomExpiryKey, redis.Z{Score: float64(past), Member: id.String()}).Err(); err != nil {
				t.Fatal(err)
			}
			retry, err := c.ExpireGroupRooms(ctx, 100)
			if err != nil || len(retry) != 1 || retry[0].ID != id || retry[0].StateRevision != first[0].StateRevision {
				t.Fatalf("retry=%+v err=%v", retry, err)
			}
			if got, err := c.client.Do(ctx, "PEXPIRETIME", groupRoomKey(id)).Int64(); err != nil || got != deadline {
				t.Fatalf("retry extended retention: before=%d after=%d err=%v", deadline, got, err)
			}
			// Simulate timeout without waiting a minute; the next sweep must
			// remove the stale index but leave a newer reservation untouched.
			newID := uuid.NewString()
			if err := c.client.Set(ctx, groupRoomConversationKey(conversation), newID, time.Minute).Err(); err != nil {
				t.Fatal(err)
			}
			if err := c.client.PExpireAt(ctx, groupRoomKey(id), time.Now().Add(-time.Second)).Err(); err != nil {
				t.Fatal(err)
			}
			if err := c.client.ZAdd(ctx, groupRoomExpiryKey, redis.Z{Score: float64(past), Member: id.String()}).Err(); err != nil {
				t.Fatal(err)
			}
			if rooms, err := c.ExpireGroupRooms(ctx, 100); err != nil || len(rooms) != 0 {
				t.Fatalf("expired snapshot claimed=%+v err=%v", rooms, err)
			}
			if err := c.client.ZScore(ctx, groupRoomExpiryKey, id.String()).Err(); err != redis.Nil {
				t.Fatalf("expired index not removed: %v", err)
			}
			if err := c.AckExpiredGroupRoom(ctx, retry[0]); !errors.Is(err, application.ErrCallUnavailable) {
				t.Fatalf("expired snapshot acknowledged: %v", err)
			}
			if got, err := c.client.Get(ctx, groupRoomConversationKey(conversation)).Result(); err != nil || got != newID {
				t.Fatalf("newer reservation changed: %q err=%v", got, err)
			}
		})
	}
}

func TestMembershipRetirementRetryIsExactAndDoesNotTouchNewRoom(t *testing.T) {
	rawURL := os.Getenv("ZWEI_TEST_REDIS_URL")
	if rawURL == "" {
		t.Skip("set ZWEI_TEST_REDIS_URL to run Redis integration tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, err := NewPresenceCoordinator(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	conversation, oldID, newID := uuid.New(), uuid.New(), uuid.New()
	owner := application.GroupParticipant{UserID: uuid.New(), DeviceID: "owner", ConnectionID: "old-socket"}
	member := application.GroupParticipant{UserID: uuid.New(), DeviceID: "member", ConnectionID: "member-socket"}
	defer c.client.Del(ctx, groupRoomKey(oldID), groupRoomKey(newID), groupRoomConversationKey(conversation), groupRoomUserKey(owner.UserID), groupRoomUserKey(member.UserID), groupStartConnectionKey(owner), groupMembershipRetirementKey(conversation, 2))
	defer c.client.ZRem(ctx, groupRoomExpiryKey, oldID.String(), newID.String())
	old, err := startAdmittedGroupRoom(ctx, c, application.GroupRoom{ID: oldID, ConversationID: conversation, MembershipRevision: 1, Generation: 1, Participants: []application.GroupParticipant{owner}})
	if err != nil {
		t.Fatal(err)
	}
	oldAttempt, err := c.client.HGet(ctx, groupRoomKey(oldID), "start_attempt_key").Result()
	if err != nil {
		t.Fatal(err)
	}
	defer c.client.Del(ctx, oldAttempt)
	old, err = joinAdmittedGroupRoom(ctx, c, oldID, member, 1)
	if err != nil {
		t.Fatal(err)
	}
	// The mutation committed, but its response was lost to the caller.
	terminal, err := c.EndGroupRoomForMembershipChange(ctx, conversation, oldID, old.Generation, old.StateRevision, 2)
	if err != nil {
		t.Fatal(err)
	}
	deadline, err := c.client.Do(ctx, "PEXPIRETIME", groupMembershipRetirementKey(conversation, 2)).Int64()
	if err != nil || deadline <= time.Now().UnixMilli() || deadline > time.Now().Add(groupRoomEndedTTL).UnixMilli() {
		t.Fatalf("retirement evidence deadline=%d err=%v", deadline, err)
	}
	newRoom, err := startAdmittedGroupRoom(ctx, c, application.GroupRoom{ID: newID, ConversationID: conversation, MembershipRevision: 2, Generation: 2, Participants: []application.GroupParticipant{owner}})
	if err != nil {
		t.Fatal(err)
	}
	newAttempt, err := c.client.HGet(ctx, groupRoomKey(newID), "start_attempt_key").Result()
	if err != nil {
		t.Fatal(err)
	}
	defer c.client.Del(ctx, newAttempt)
	retry, err := c.EndGroupRoomForMembershipChange(ctx, conversation, oldID, old.Generation, old.StateRevision, 2)
	if err != nil || retry.ID != oldID || retry.StateRevision != terminal.StateRevision || retry.Status != application.GroupRoomEnded {
		t.Fatalf("exact retry=%+v err=%v", retry, err)
	}
	if got, err := c.client.Do(ctx, "PEXPIRETIME", groupMembershipRetirementKey(conversation, 2)).Int64(); err != nil || got != deadline {
		t.Fatalf("retry extended retirement evidence: before=%d after=%d err=%v", deadline, got, err)
	}
	recovered, err := c.GetGroupMembershipRetirement(ctx, conversation, 2)
	if err != nil || recovered.ID != oldID || recovered.StateRevision != terminal.StateRevision || recovered.Status != application.GroupRoomEnded || len(recovered.Participants) != 2 {
		t.Fatalf("recovered retirement=%+v err=%v", recovered, err)
	}
	connections := make(map[uuid.UUID]string)
	for _, participant := range recovered.Participants {
		connections[participant.UserID] = participant.ConnectionID
	}
	if connections[owner.UserID] != owner.ConnectionID || connections[member.UserID] != member.ConnectionID {
		t.Fatalf("recovered wrong socket owners: %+v", connections)
	}
	savedConnections, err := c.client.HGet(ctx, groupRoomKey(oldID), "ended_connections").Result()
	if err != nil {
		t.Fatal(err)
	}
	if err := c.client.HDel(ctx, groupRoomKey(oldID), "ended_connections").Err(); err != nil {
		t.Fatal(err)
	}
	if _, err := c.GetGroupMembershipRetirement(ctx, conversation, 2); !errors.Is(err, application.ErrCallUnavailable) {
		t.Fatalf("partial routing evidence: %v", err)
	}
	if err := c.client.HSet(ctx, groupRoomKey(oldID), "ended_connections", savedConnections).Err(); err != nil {
		t.Fatal(err)
	}
	for _, candidate := range []struct {
		conversation uuid.UUID
		revision     int64
	}{{uuid.New(), 2}, {conversation, 3}} {
		if _, err := c.GetGroupMembershipRetirement(ctx, candidate.conversation, candidate.revision); !errors.Is(err, application.ErrCallNotFound) {
			t.Fatalf("foreign retirement lookup: %+v: %v", candidate, err)
		}
	}
	if _, err := c.EndGroupRoomForMembershipChange(ctx, uuid.New(), oldID, old.Generation, old.StateRevision, 2); !errors.Is(err, application.ErrCallNotFound) {
		t.Fatalf("foreign conversation retirement retry: %v", err)
	}
	for _, wrong := range []struct{ generation, stateRevision, membershipRevision int64 }{
		{old.Generation + 1, old.StateRevision, 2}, {old.Generation, old.StateRevision + 1, 2}, {old.Generation, old.StateRevision, 3},
	} {
		if _, err := c.EndGroupRoomForMembershipChange(ctx, conversation, oldID, wrong.generation, wrong.stateRevision, wrong.membershipRevision); err == nil {
			t.Fatalf("foreign retirement accepted: %+v", wrong)
		}
	}
	current, err := c.GetGroupRoomForConversation(ctx, conversation)
	if err != nil || current.ID != newID || current.StateRevision != newRoom.StateRevision || current.Status != application.GroupRoomRinging {
		t.Fatalf("new room changed: %+v err=%v", current, err)
	}
	if err := c.client.PExpireAt(ctx, groupMembershipRetirementKey(conversation, 2), time.Now().Add(-time.Second)).Err(); err != nil {
		t.Fatal(err)
	}
	if _, err := c.GetGroupMembershipRetirement(ctx, conversation, 2); !errors.Is(err, application.ErrCallNotFound) {
		t.Fatalf("expired evidence lookup: %v", err)
	}
	if _, err := c.EndGroupRoomForMembershipChange(ctx, conversation, oldID, old.Generation, old.StateRevision, 2); err == nil {
		t.Fatal("expired retirement evidence allowed a retry")
	}
	// An observer sees the replacement rather than the retired room. A former
	// participant with a newer reservation is not falsely declared absent.
	if room, err := c.GetGroupRoomForConversation(ctx, conversation); err != nil || room.ID != newID {
		t.Fatalf("observer discovery after cutoff=%+v err=%v", room, err)
	}
	if _, status, err := c.SyncGroupRoomOwnership(ctx, conversation, oldID, old.Generation, 2, owner); err != nil || status != "room_unavailable" {
		t.Fatalf("owner with newer reservation=%q err=%v", status, err)
	}
	if _, status, err := c.SyncGroupRoomOwnership(ctx, conversation, oldID, old.Generation, 2, member); err != nil || status != "participant_absent" {
		t.Fatalf("released participant=%q err=%v", status, err)
	}
	if _, err := c.EndGroupRoom(ctx, newID, owner); err != nil {
		t.Fatal(err)
	}
	if _, err := c.GetGroupRoomForConversation(ctx, conversation); !errors.Is(err, application.ErrCallNotFound) {
		t.Fatalf("observer discovery after ending replacement: %v", err)
	}
	if _, status, err := c.SyncGroupRoomOwnership(ctx, conversation, oldID, old.Generation, 2, owner); err != nil || status != "participant_absent" {
		t.Fatalf("released owner=%q err=%v", status, err)
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
		_, startErr := directCoordinator.Start(ctx, application.Call{ID: callID, ConversationID: uuid.New(), CallerID: userID, RecipientID: recipientID, CallerDeviceID: deviceID, CallerConnectionID: connectionID}, token)
		directCoordinator.ReleaseCallAdmission(ctx, []uuid.UUID{userID, recipientID}, token)
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
		_, joinErr := groupCoordinator.JoinGroupRoom(ctx, roomID, joiningParticipant, 9, token)
		groupCoordinator.ReleaseCallAdmission(ctx, []uuid.UUID{joiningParticipant.UserID}, token)
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
	attempt, _, err := coordinator.PrepareGroupRoomStart(ctx, room.ConversationID, room.Participants[0])
	if err != nil {
		t.Fatal(err)
	}
	defer coordinator.client.Del(ctx, groupStartAttemptKey(attempt))
	if _, err := coordinator.StartPreparedGroupRoom(ctx, room, tokenB, attempt); !errors.Is(err, application.ErrCallBusy) {
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
