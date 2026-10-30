package redis

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	redis "github.com/redis/go-redis/v9"

	"github.com/KovalMax/zwei/services/realtime/internal/application"
)

func TestPreparedStartExpiryIndexFailureIsBoundedIntegration(t *testing.T) {
	url := os.Getenv("ZWEI_TEST_REDIS_URL")
	if url == "" {
		t.Skip("set ZWEI_TEST_REDIS_URL to run Redis integration tests")
	}
	for _, replaceReservation := range []bool{false, true} {
		t.Run(map[bool]string{false: "reservations expire", true: "newer reservation survives"}[replaceReservation], func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			c, err := NewPresenceCoordinator(url)
			if err != nil {
				t.Fatal(err)
			}
			defer c.Close()
			owner := application.GroupParticipant{UserID: uuid.New(), DeviceID: "device", ConnectionID: "socket"}
			conversation, roomID := uuid.New(), uuid.New()
			roomKey := groupRoomKey(roomID)
			conversationKey, userKey := groupRoomConversationKey(conversation), groupRoomUserKey(owner.UserID)
			// Use a unique expiry-index key, not the shared production index.
			badIndex := "zwei:test:wrong-expiry-type:" + uuid.NewString()
			defer c.client.Del(ctx, roomKey, conversationKey, userKey, badIndex, groupStartConnectionKey(owner))
			attempt, _, err := c.PrepareGroupRoomStart(ctx, conversation, owner)
			if err != nil {
				t.Fatal(err)
			}
			defer c.client.Del(ctx, groupStartAttemptKey(attempt))
			token, err := c.AcquireCallAdmission(ctx, []uuid.UUID{owner.UserID})
			if err != nil {
				t.Fatal(err)
			}
			defer c.ReleaseCallAdmission(ctx, []uuid.UUID{owner.UserID}, token)
			if err := c.client.Set(ctx, badIndex, "wrong type", time.Minute).Err(); err != nil {
				t.Fatal(err)
			}
			now := time.Now().UTC()
			expires, ringExpires := now.Add(groupRoomActiveTTL), now.Add(groupRoomRingingTTL)
			// Run the actual start script with short TTLs, so this test observes
			// expiry without compensation or waiting for the production lease.
			err = c.client.Eval(ctx, startPreparedGroupRoomScript, []string{roomKey, conversationKey, userKey, badIndex, groupStartAttemptKey(attempt), groupStartConnectionKey(owner)}, roomID.String(), conversation.String(), 1, 1, owner.UserID.String(), owner.DeviceID, owner.ConnectionID, uuid.Nil.String(), expires.Format(time.RFC3339Nano), expires.UnixMilli(), 2, int(groupRoomRingingTTL.Seconds()), token, 2, ringExpires.Format(time.RFC3339Nano)).Err()
			if err == nil || !strings.Contains(err.Error(), "WRONGTYPE") {
				t.Fatalf("start must fail at expiry index: %v", err)
			}
			for _, key := range []string{roomKey, conversationKey, userKey} {
				ttl, err := c.client.PTTL(ctx, key).Result()
				if err != nil || ttl <= 0 || ttl > 2*time.Second {
					t.Fatalf("partial state %s not bounded: ttl=%s err=%v", key, ttl, err)
				}
			}
			// A later heartbeat must not persist the unindexed room if the
			// expiry index is still broken. Force it into the renewal window.
			if err := c.client.HSet(ctx, roomKey, "expires_at_unix_ms", now.Add(time.Minute).UnixMilli()).Err(); err != nil {
				t.Fatal(err)
			}
			err = c.client.Eval(ctx, renewOwnedGroupRoomScript, []string{userKey, badIndex}, owner.UserID.String(), owner.ConnectionID, now.UnixMilli(), expires.Format(time.RFC3339Nano), expires.UnixMilli(), 2).Err()
			if err == nil || !strings.Contains(err.Error(), "WRONGTYPE") {
				t.Fatalf("heartbeat must fail at expiry index: %v", err)
			}
			if ttl, err := c.client.PTTL(ctx, roomKey).Result(); err != nil || ttl <= 0 || ttl > 2*time.Second {
				t.Fatalf("heartbeat persisted unindexed room: ttl=%s err=%v", ttl, err)
			}
			newRoom := uuid.NewString()
			if replaceReservation {
				newRoomKey := "zwei:group-call:room:" + newRoom
				defer c.client.Del(ctx, newRoomKey)
				if err := c.client.HSet(ctx, newRoomKey, "status", "ringing", "conversation_id", conversation.String()).Err(); err != nil {
					t.Fatal(err)
				}
				if err := c.client.Expire(ctx, newRoomKey, 8*time.Second).Err(); err != nil {
					t.Fatal(err)
				}
				for _, key := range []string{conversationKey, userKey} {
					if err := c.client.Set(ctx, key, newRoom, 8*time.Second).Err(); err != nil {
						t.Fatal(err)
					}
				}
			}
			deadline := time.Now().Add(4 * time.Second)
			for {
				keys := []string{roomKey}
				if !replaceReservation {
					keys = append(keys, conversationKey, userKey)
				}
				remaining, err := c.client.Exists(ctx, keys...).Result()
				if err != nil {
					t.Fatal(err)
				}
				if remaining == 0 {
					break
				}
				if time.Now().After(deadline) {
					t.Fatalf("partial state did not expire: remaining=%d", remaining)
				}
				time.Sleep(20 * time.Millisecond)
			}
			if replaceReservation {
				for _, key := range []string{conversationKey, userKey} {
					if got, err := c.client.Get(ctx, key).Result(); err != nil || got != newRoom {
						t.Fatalf("newer reservation changed: %q, %v", got, err)
					}
				}
				if status, err := c.client.HGet(ctx, "zwei:group-call:room:"+newRoom, "status").Result(); err != nil || status != "ringing" {
					t.Fatalf("newer room changed: %q, %v", status, err)
				}
			}
		})
	}
}

func TestGroupStartAttemptFencingIntegration(t *testing.T) {
	url := os.Getenv("ZWEI_TEST_REDIS_URL")
	if url == "" {
		t.Skip("set ZWEI_TEST_REDIS_URL to run Redis integration tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, err := NewPresenceCoordinator(url)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	owner := application.GroupParticipant{UserID: uuid.New(), DeviceID: uuid.NewString(), ConnectionID: uuid.NewString()}
	conversation := uuid.New()
	room := application.GroupRoom{ID: uuid.New(), ConversationID: conversation, MembershipRevision: 1, Generation: 1, Participants: []application.GroupParticipant{owner}}
	var attempts []uuid.UUID
	roomIDs := []uuid.UUID{room.ID}
	defer func() {
		keys := []string{groupRoomConversationKey(conversation), groupRoomUserKey(owner.UserID), groupStartConnectionKey(owner)}
		for _, id := range roomIDs {
			keys = append(keys, groupRoomKey(id))
			c.client.ZRem(ctx, groupRoomExpiryKey, id.String())
		}
		for _, id := range attempts {
			keys = append(keys, groupStartAttemptKey(id))
		}
		c.client.Del(ctx, keys...)
	}()
	prepare := func() uuid.UUID {
		id, _, err := c.PrepareGroupRoomStart(ctx, conversation, owner)
		if err != nil {
			t.Fatal(err)
		}
		attempts = append(attempts, id)
		return id
	}
	token, err := c.AcquireCallAdmission(ctx, []uuid.UUID{owner.UserID})
	if err != nil {
		t.Fatal(err)
	}
	defer c.ReleaseCallAdmission(ctx, []uuid.UUID{owner.UserID}, token)
	id := prepare()
	other := owner
	other.DeviceID = "other-device"
	if _, _, err := c.CancelGroupRoomStart(ctx, conversation, other, id); err == nil {
		t.Fatal("sibling socket cancelled permit")
	}
	if _, retired, err := c.CancelGroupRoomStart(ctx, conversation, owner, id); err != nil || retired != "confirmed" {
		t.Fatalf("cancel prepared: retired=%v err=%v", retired, err)
	}
	if _, err := c.StartPreparedGroupRoom(ctx, room, token, id); err == nil {
		t.Fatal("cancelled permit started room")
	}
	expired := prepare()
	if err := c.client.Del(ctx, groupStartAttemptKey(expired)).Err(); err != nil {
		t.Fatal(err)
	}
	if _, err := c.StartPreparedGroupRoom(ctx, room, token, expired); err == nil {
		t.Fatal("expired permit started room")
	}
	id = prepare()
	if _, err := c.StartPreparedGroupRoom(ctx, room, token, id); err != nil {
		t.Fatal(err)
	}
	if _, err := c.StartPreparedGroupRoom(ctx, room, token, id); err == nil {
		t.Fatal("permit was reused")
	}
	participant := application.GroupParticipant{UserID: uuid.New(), DeviceID: "joiner", ConnectionID: uuid.NewString()}
	joinToken, err := c.AcquireCallAdmission(ctx, []uuid.UUID{participant.UserID})
	if err != nil {
		t.Fatal(err)
	}
	defer c.ReleaseCallAdmission(ctx, []uuid.UUID{participant.UserID}, joinToken)
	defer c.client.Del(ctx, groupRoomUserKey(participant.UserID))
	if _, err := c.JoinGroupRoom(ctx, room.ID, participant, 1, joinToken); err != nil {
		t.Fatal(err)
	}
	if ttl, err := c.client.TTL(ctx, groupStartAttemptKey(id)).Result(); err != nil || ttl < time.Hour {
		t.Fatalf("started permit not extended with room: ttl=%s err=%v", ttl, err)
	}
	ttls, err := c.client.Eval(ctx, `return {redis.call('PTTL',KEYS[1]), redis.call('PTTL',KEYS[2]), redis.call('PTTL',KEYS[3])}`, []string{groupRoomKey(room.ID), groupRoomConversationKey(conversation), groupStartAttemptKey(id)}).Int64Slice()
	// The room survives an expiry-sweeper outage; reservation indexes remain
	// bounded, while the sweeper retains and acknowledges the terminal snapshot.
	if err != nil || len(ttls) != 3 || ttls[0] != -1 || ttls[1] < int64(time.Hour/time.Millisecond) || ttls[2] < int64(time.Hour/time.Millisecond) {
		t.Fatalf("room/index/permit lifetime invariant = %v, %v", ttls, err)
	}
	ended, retired, err := c.CancelGroupRoomStart(ctx, conversation, owner, id)
	if err != nil || retired != "retired" || ended.ID != room.ID || ended.Status != application.GroupRoomEnded {
		t.Fatalf("cancel started: room=%+v retired=%v err=%v", ended, retired, err)
	}
	if _, retired, err := c.CancelGroupRoomStart(ctx, conversation, owner, id); err != nil || retired != "retired" {
		t.Fatalf("repeat cancel: retired=%v err=%v", retired, err)
	}
	// Neither ordering of concurrent cancellation and start may leave a room
	// alive after both operations have returned.
	room.ID = uuid.New()
	roomIDs = append(roomIDs, room.ID)
	tracing := prepare()
	startDone := make(chan error, 1)
	go func() {
		_, err := c.StartPreparedGroupRoom(ctx, room, token, tracing)
		startDone <- err
	}()
	reconnected := owner
	reconnected.ConnectionID = "reconnected-socket"
	_, _, err = c.CancelGroupRoomStart(ctx, conversation, reconnected, tracing)
	if err != nil {
		t.Fatal(err)
	}
	<-startDone
	if exists, err := c.client.Exists(ctx, groupRoomConversationKey(conversation)).Result(); err != nil || exists != 0 {
		t.Fatalf("concurrent cancel left live reservation: exists=%d err=%v", exists, err)
	}
	disconnected := prepare()
	if _, err := c.RemoveGroupConnection(ctx, owner.UserID, owner.DeviceID, owner.ConnectionID); err != nil {
		t.Fatal(err)
	}
	if _, err := c.StartPreparedGroupRoom(ctx, room, token, disconnected); err == nil {
		t.Fatal("disconnected socket permit started room")
	}
}

func TestGroupStartConnectionIndexBoundedIntegration(t *testing.T) {
	url := os.Getenv("ZWEI_TEST_REDIS_URL")
	if url == "" {
		t.Skip("set ZWEI_TEST_REDIS_URL to run Redis integration tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, err := NewPresenceCoordinator(url)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	owner := application.GroupParticipant{UserID: uuid.New(), DeviceID: "device", ConnectionID: uuid.NewString()}
	conversation := uuid.New()
	index := groupStartConnectionKey(owner)
	var ids []uuid.UUID
	defer func() {
		keys := []string{index}
		for _, id := range ids {
			keys = append(keys, groupStartAttemptKey(id))
		}
		c.client.Del(ctx, keys...)
	}()
	for i := 0; i < groupStartAttemptLimit; i++ {
		id, _, err := c.PrepareGroupRoomStart(ctx, conversation, owner)
		if err != nil {
			t.Fatalf("prepare %d: %v", i, err)
		}
		ids = append(ids, id)
	}
	for i := 0; i < 100; i++ {
		if _, _, err := c.PrepareGroupRoomStart(ctx, conversation, owner); err == nil {
			t.Fatal("unbounded prepare accepted")
		}
	}
	if n, err := c.client.ZCard(ctx, index).Result(); err != nil || n != groupStartAttemptLimit {
		t.Fatalf("index size=%d err=%v", n, err)
	}
	// Simulate Redis expiry of one permit and its past-due index score without
	// waiting for wall-clock TTLs; the next prepare must reclaim the slot.
	if err := c.client.Del(ctx, groupStartAttemptKey(ids[1])).Err(); err != nil {
		t.Fatal(err)
	}
	if err := c.client.ZAdd(ctx, index, redis.Z{Score: 0, Member: groupStartAttemptKey(ids[1])}).Err(); err != nil {
		t.Fatal(err)
	}
	reclaimed, _, err := c.PrepareGroupRoomStart(ctx, conversation, owner)
	if err != nil {
		t.Fatalf("expired entry did not free capacity: %v", err)
	}
	ids = append(ids, reclaimed)
	if _, _, err := c.CancelGroupRoomStart(ctx, conversation, owner, ids[0]); err != nil {
		t.Fatal(err)
	}
	replacement, _, err := c.PrepareGroupRoomStart(ctx, conversation, owner)
	if err != nil {
		t.Fatalf("cancel did not free capacity: %v", err)
	}
	ids = append(ids, replacement)
	if _, err := c.RemoveGroupConnection(ctx, owner.UserID, owner.DeviceID, owner.ConnectionID); err != nil {
		t.Fatal(err)
	}
	if n, err := c.client.Exists(ctx, index).Result(); err != nil || n != 0 {
		t.Fatalf("disconnect index exists=%d err=%v", n, err)
	}
	if state, err := c.client.HGet(ctx, groupStartAttemptKey(replacement), "state").Result(); err != nil || state != "cancelled" {
		t.Fatalf("disconnect state=%q err=%v", state, err)
	}
}

func TestGroupStartRecoveryIntegration(t *testing.T) {
	url := os.Getenv("ZWEI_TEST_REDIS_URL")
	if url == "" {
		t.Skip("set ZWEI_TEST_REDIS_URL to run Redis integration tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, err := NewPresenceCoordinator(url)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	owner := application.GroupParticipant{UserID: uuid.New(), DeviceID: "device", ConnectionID: "old-socket"}
	reconnected := owner
	reconnected.ConnectionID = "new-socket"
	conversation := uuid.New()
	room := application.GroupRoom{ID: uuid.New(), ConversationID: conversation, MembershipRevision: 1, Generation: 1, Participants: []application.GroupParticipant{owner}}
	id, deadline, err := c.PrepareGroupRoomStart(ctx, conversation, owner)
	if err != nil {
		t.Fatal(err)
	}
	storedDeadline, err := c.client.Do(ctx, "PEXPIRETIME", groupStartAttemptKey(id)).Int64()
	if err != nil || storedDeadline != deadline.UnixMilli() {
		t.Fatalf("Redis expiry=%d returned deadline=%s err=%v", storedDeadline, deadline, err)
	}
	defer c.client.Del(ctx, groupStartAttemptKey(id), groupStartConnectionKey(owner), groupRoomKey(room.ID), groupRoomConversationKey(conversation), groupRoomUserKey(owner.UserID))
	defer c.client.ZRem(ctx, groupRoomExpiryKey, room.ID.String())
	token, err := c.AcquireCallAdmission(ctx, []uuid.UUID{owner.UserID})
	if err != nil {
		t.Fatal(err)
	}
	defer c.ReleaseCallAdmission(ctx, []uuid.UUID{owner.UserID}, token)
	wrongSocketRoom := room
	wrongSocketRoom.Participants = []application.GroupParticipant{reconnected}
	if _, err := c.StartPreparedGroupRoom(ctx, wrongSocketRoom, token, id); err == nil {
		t.Fatal("reconnected socket started original permit")
	}
	if _, outcome, err := c.CancelGroupRoomStart(ctx, conversation, reconnected, uuid.New()); err != nil || outcome != "unknown" {
		t.Fatalf("sibling without capability: outcome=%q err=%v", outcome, err)
	}
	if _, err := c.StartPreparedGroupRoom(ctx, room, token, id); err != nil {
		t.Fatal(err)
	}
	if _, outcome, err := c.CancelGroupRoomStart(ctx, conversation, reconnected, uuid.New()); err != nil || outcome != "unknown" {
		t.Fatalf("unrelated capability against live room: outcome=%q err=%v", outcome, err)
	}
	if current, err := c.GetGroupRoom(ctx, room.ID); err != nil || current.Status != application.GroupRoomRinging {
		t.Fatalf("unrelated capability changed room: status=%q err=%v", current.Status, err)
	}
	// Even if the permit has disappeared, the immutable room binding and
	// conversation reservation identify exactly the room created by it.
	if err := c.client.Del(ctx, groupStartAttemptKey(id)).Err(); err != nil {
		t.Fatal(err)
	}
	foreign := reconnected
	foreign.DeviceID = "other-device"
	if _, outcome, err := c.CancelGroupRoomStart(ctx, conversation, foreign, id); err != nil || outcome != "unknown" {
		t.Fatalf("foreign device recovery=%q err=%v", outcome, err)
	}
	ended, outcome, err := c.CancelGroupRoomStart(ctx, conversation, reconnected, id)
	if err != nil || outcome != "retired" || ended.ID != room.ID || ended.Status != application.GroupRoomEnded {
		t.Fatalf("recovery room=%+v outcome=%q err=%v", ended, outcome, err)
	}
	// Simulate a lost acknowledgement: the same capability must still return
	// the original terminal snapshot so publication can be retried.
	ttl, err := c.client.PTTL(ctx, groupStartAttemptKey(id)).Result()
	if err != nil || ttl <= 0 || ttl > groupRoomEndedTTL {
		t.Fatalf("recovery evidence must be bounded: ttl=%s err=%v", ttl, err)
	}
	newRoom := uuid.New()
	defer c.client.Del(ctx, groupRoomKey(newRoom))
	if err := c.client.Set(ctx, groupRoomConversationKey(conversation), newRoom.String(), time.Minute).Err(); err != nil {
		t.Fatal(err)
	}
	if err := c.client.HSet(ctx, groupRoomKey(newRoom), "status", "ringing").Err(); err != nil {
		t.Fatal(err)
	}
	repeated, outcome, err := c.CancelGroupRoomStart(ctx, conversation, reconnected, id)
	if err != nil || outcome != "retired" || repeated.ID != room.ID || repeated.StateRevision != ended.StateRevision {
		t.Fatalf("repeated cancellation room=%+v outcome=%q err=%v", repeated, outcome, err)
	}
	if later, err := c.client.PTTL(ctx, groupStartAttemptKey(id)).Result(); err != nil || later <= 0 || later > ttl {
		t.Fatalf("retry refreshed evidence lifetime: before=%s after=%s err=%v", ttl, later, err)
	}
	if _, err := c.StartPreparedGroupRoom(ctx, room, token, id); err == nil {
		t.Fatal("reconstructed cancellation permitted a delayed start")
	}
	if current, err := c.client.Get(ctx, groupRoomConversationKey(conversation)).Result(); err != nil || current != newRoom.String() {
		t.Fatalf("repeat changed new room reservation=%q err=%v", current, err)
	}
	for _, candidate := range []struct {
		conversation uuid.UUID
		owner        application.GroupParticipant
	}{{uuid.New(), reconnected}, {conversation, foreign}, {conversation, application.GroupParticipant{UserID: uuid.New(), DeviceID: owner.DeviceID, ConnectionID: "socket"}}} {
		if _, outcome, err := c.CancelGroupRoomStart(ctx, candidate.conversation, candidate.owner, id); err == nil || outcome == "retired" {
			t.Fatalf("foreign cancellation outcome=%q err=%v", outcome, err)
		}
	}
	// Losing either half of the evidence is not proof of retirement.
	snapshot, err := c.client.HGetAll(ctx, groupRoomKey(room.ID)).Result()
	if err != nil || len(snapshot) == 0 {
		t.Fatalf("read terminal snapshot: %v", err)
	}
	if err := c.client.Del(ctx, groupRoomKey(room.ID)).Err(); err != nil {
		t.Fatal(err)
	}
	if _, outcome, err := c.CancelGroupRoomStart(ctx, conversation, reconnected, id); err != nil || outcome != "unknown" {
		t.Fatalf("missing terminal snapshot: %q %v", outcome, err)
	}
	if err := c.client.HSet(ctx, groupRoomKey(room.ID), snapshot).Err(); err != nil {
		t.Fatal(err)
	}
	if err := c.client.PExpireAt(ctx, groupStartAttemptKey(id), time.Now().Add(-time.Second)).Err(); err != nil {
		t.Fatal(err)
	}
	if _, outcome, err := c.CancelGroupRoomStart(ctx, conversation, reconnected, id); err != nil || outcome != "unknown" {
		t.Fatalf("expired evidence: %q %v", outcome, err)
	}
}

func TestExpiredGroupStartCancellationFencesDelayedStart(t *testing.T) {
	url := os.Getenv("ZWEI_TEST_REDIS_URL")
	if url == "" {
		t.Skip("set ZWEI_TEST_REDIS_URL to run Redis integration tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, err := NewPresenceCoordinator(url)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	owner := application.GroupParticipant{UserID: uuid.New(), DeviceID: "device", ConnectionID: "original"}
	reconnected := owner
	reconnected.ConnectionID = "reconnected"
	conversation := uuid.New()
	room := application.GroupRoom{ID: uuid.New(), ConversationID: conversation, MembershipRevision: 1, Generation: 1, Participants: []application.GroupParticipant{owner}}
	id, _, err := c.PrepareGroupRoomStart(ctx, conversation, owner)
	if err != nil {
		t.Fatal(err)
	}
	defer c.client.Del(ctx, groupStartAttemptKey(id), groupStartConnectionKey(owner), groupRoomKey(room.ID), groupRoomConversationKey(conversation), groupRoomUserKey(owner.UserID))
	defer c.client.ZRem(ctx, groupRoomExpiryKey, room.ID.String())
	token, err := c.AcquireCallAdmission(ctx, []uuid.UUID{owner.UserID})
	if err != nil {
		t.Fatal(err)
	}
	defer c.ReleaseCallAdmission(ctx, []uuid.UUID{owner.UserID}, token)
	if err := c.client.Del(ctx, groupStartAttemptKey(id)).Err(); err != nil {
		t.Fatal(err)
	}
	startDone := make(chan error, 1)
	go func() {
		_, err := c.StartPreparedGroupRoom(ctx, room, token, id)
		startDone <- err
	}()
	for i := 0; i < 2; i++ {
		if _, outcome, err := c.CancelGroupRoomStart(ctx, conversation, reconnected, id); err != nil || outcome != "unknown" {
			t.Fatalf("expired cancellation %d = %q, %v", i, outcome, err)
		}
	}
	if err := <-startDone; err == nil {
		t.Fatal("expired and fenced permit started")
	}
	if exists, err := c.client.Exists(ctx, groupRoomConversationKey(conversation)).Result(); err != nil || exists != 0 {
		t.Fatalf("late start left reservation %d, %v", exists, err)
	}
}

func TestGroupStartCancellationPartialEvidenceIntegration(t *testing.T) {
	url := os.Getenv("ZWEI_TEST_REDIS_URL")
	if url == "" {
		t.Skip("set ZWEI_TEST_REDIS_URL to run Redis integration tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, err := NewPresenceCoordinator(url)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	owner := application.GroupParticipant{UserID: uuid.New(), DeviceID: "device", ConnectionID: "socket"}
	conversation, id, roomID := uuid.New(), uuid.New(), uuid.New()
	roomKey, attemptKey, index := groupRoomKey(roomID), groupStartAttemptKey(id), groupRoomConversationKey(conversation)
	defer c.client.Del(ctx, roomKey, attemptKey, index, groupRoomUserKey(owner.UserID))
	if err := c.client.Set(ctx, index, roomID.String(), time.Minute).Err(); err != nil {
		t.Fatal(err)
	}
	for _, fields := range []map[string]any{
		{},
		{"conversation_id": conversation.String(), "status": "ringing", "starter_user": owner.UserID.String(), "starter_device": owner.DeviceID},
		{"conversation_id": conversation.String(), "status": "ringing", "start_attempt_key": attemptKey, "starter_user": owner.UserID.String(), "starter_device": "foreign"},
		{"conversation_id": conversation.String(), "status": "ended", "start_attempt_key": attemptKey, "starter_user": owner.UserID.String(), "starter_device": owner.DeviceID},
	} {
		if err := c.client.Del(ctx, roomKey).Err(); err != nil {
			t.Fatal(err)
		}
		if len(fields) > 0 {
			if err := c.client.HSet(ctx, roomKey, fields).Err(); err != nil {
				t.Fatal(err)
			}
		}
		if _, outcome, err := c.CancelGroupRoomStart(ctx, conversation, owner, id); err != nil || outcome != "unknown" {
			t.Fatalf("partial evidence %v: outcome=%q err=%v", fields, outcome, err)
		}
		if n, err := c.client.Exists(ctx, attemptKey).Result(); err != nil || n != 0 {
			t.Fatalf("partial evidence created attempt: exists=%d err=%v", n, err)
		}
	}
}
