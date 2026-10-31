package redis

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	redis "github.com/redis/go-redis/v9"

	"github.com/KovalMax/zwei/services/realtime/internal/application"
)

const (
	groupRoomRingingTTL = 30 * time.Second
	groupRoomActiveTTL  = 2 * time.Hour
	groupRoomEndedTTL   = time.Minute
	groupRoomChannel    = "zwei:group-call"
	groupRoomExpiryKey  = "zwei:group-call:expirations"
)

func (c *PresenceCoordinator) JoinGroupRoom(ctx context.Context, roomID uuid.UUID, participant application.GroupParticipant, revision int64, admissionToken string) (application.GroupRoom, error) {
	if admissionToken == "" {
		return application.GroupRoom{}, application.ErrCallNotAllowed
	}
	now := time.Now()
	result, err := c.client.Eval(ctx, joinGroupRoomWithAttemptScript, []string{groupRoomKey(roomID), groupRoomUserKey(participant.UserID), groupRoomExpiryKey}, participant.UserID.String(), participant.DeviceID, participant.ConnectionID, revision, "", 0, int((groupRoomActiveTTL + groupRoomEndedTTL).Seconds()), int((groupRoomActiveTTL + groupRoomEndedTTL).Seconds()), now.UnixMilli(), admissionToken, application.GroupRoomCapacity).Int()
	if err != nil {
		return application.GroupRoom{}, err
	}
	if result != 1 {
		return application.GroupRoom{}, groupRoomResultError(result)
	}
	return c.groupRoom(ctx, roomID)
}

func groupRoomResultError(result int) error {
	if result == 7 {
		return application.ErrGroupRoomFull
	}
	return callResultError(result)
}

func (c *PresenceCoordinator) LeaveGroupRoom(ctx context.Context, roomID uuid.UUID, participant application.GroupParticipant) (application.GroupRoom, error) {
	result, err := c.client.Eval(ctx, leaveGroupRoomScript, []string{groupRoomKey(roomID), groupRoomUserKey(participant.UserID), groupRoomConversationKey(uuid.Nil)}, participant.UserID.String(), participant.DeviceID, participant.ConnectionID, int(groupRoomEndedTTL.Seconds())).Int()
	if err != nil {
		return application.GroupRoom{}, err
	}
	if result != 1 {
		return application.GroupRoom{}, callResultError(result)
	}
	return c.groupRoom(ctx, roomID)
}

func (c *PresenceCoordinator) EndGroupRoom(ctx context.Context, roomID uuid.UUID, participant application.GroupParticipant) (application.GroupRoom, error) {
	result, err := c.client.Eval(ctx, endGroupRoomScript, []string{groupRoomKey(roomID), groupRoomUserKey(participant.UserID)}, participant.UserID.String(), participant.DeviceID, participant.ConnectionID, int(groupRoomEndedTTL.Seconds())).Int()
	if err != nil {
		return application.GroupRoom{}, err
	}
	if result != 1 {
		return application.GroupRoom{}, callResultError(result)
	}
	return c.groupRoom(ctx, roomID)
}

// AbortGroupRoomStart compensates one attempted start only. Both the room
// generation and its initiating socket must still match before any index is
// removed, so a delayed compensation cannot end a newer conversation room.
func (c *PresenceCoordinator) AbortGroupRoomStart(ctx context.Context, roomID uuid.UUID, generation int64, participant application.GroupParticipant) error {
	result, err := c.client.Eval(ctx, abortGroupRoomStartScript, []string{groupRoomKey(roomID)}, roomID.String(), generation, participant.UserID.String(), participant.DeviceID, participant.ConnectionID, int(groupRoomEndedTTL.Seconds())).Int()
	if err != nil {
		return err
	}
	if result != 1 {
		return callResultError(result)
	}
	return nil
}

func (c *PresenceCoordinator) GetGroupRoom(ctx context.Context, roomID uuid.UUID) (application.GroupRoom, error) {
	return c.groupRoom(ctx, roomID)
}

// renewOwnedGroupRoom is called only while the heartbeat holds the local socket
// ownership lock. Redis verifies the exact socket and current reservation in
// the same turn as expiry renewal, so disconnect/end cannot resurrect a room.
func (c *PresenceCoordinator) renewOwnedGroupRoom(ctx context.Context, userID uuid.UUID, connectionID string, now time.Time) error {
	deadline := now.UTC().Add(groupRoomActiveTTL)
	return c.client.Eval(ctx, renewOwnedGroupRoomScript, []string{groupRoomUserKey(userID), groupRoomExpiryKey}, userID.String(), connectionID, now.UnixMilli(), deadline.Format(time.RFC3339Nano), deadline.UnixMilli(), int((groupRoomActiveTTL + groupRoomEndedTTL).Seconds())).Err()
}

const renewOwnedGroupRoomScript = `
local roomID = redis.call('GET', KEYS[1]); if not roomID then return 0 end
local roomKey = 'zwei:group-call:room:' .. roomID
if redis.call('EXISTS', roomKey) == 0 or redis.call('HGET', roomKey, 'status') == 'ended' then return 0 end
local expiry = tonumber(redis.call('HGET', roomKey, 'expires_at_unix_ms')); if not expiry or expiry <= tonumber(ARGV[3]) then return 0 end
local owned = false
for connection in string.gmatch(redis.call('HGET', roomKey, 'connections') or '', '[^,]+') do
  local user, device, socket = string.match(connection, '^([^|]+)|([^|]+)|(.+)$')
  if user == ARGV[1] and socket == ARGV[2] then owned = true; break end
end
if not owned then return 0 end
-- Renew only in the latter half of the lease; normal heartbeats do not change
-- the advertised deadline and a failed replica leaves a bounded stale room.
if expiry - tonumber(ARGV[3]) > 3600000 then return 0 end
local conversationKey = 'zwei:group-call:conversation:' .. redis.call('HGET', roomKey, 'conversation_id')
if redis.call('GET', conversationKey) ~= roomID then return 0 end
-- A partially created room may still have its fallback TTL. Do not remove it
-- unless the expiry index accepted the renewed deadline.
redis.call('ZADD', KEYS[2], ARGV[5], roomID)
redis.call('HSET', roomKey, 'expires_at', ARGV[4], 'expires_at_unix_ms', ARGV[5])
redis.call('PERSIST', roomKey); redis.call('EXPIRE', conversationKey, ARGV[6])
for _, p in ipairs(cjson.decode(redis.call('HGET', roomKey, 'participants'))) do
  local key = 'zwei:group-call:user:' .. p.user_id
  if redis.call('GET', key) == roomID then redis.call('EXPIRE', key, ARGV[6]) end
end
local attempt = redis.call('HGET', roomKey, 'start_attempt_key')
if attempt and redis.call('HGET', attempt, 'room') == roomID then redis.call('EXPIRE', attempt, ARGV[6]) end
return 1`

// GroupReservationAbsent checks only the authenticated user's reservation key.
func (c *PresenceCoordinator) GroupReservationAbsent(ctx context.Context, userID uuid.UUID) (bool, error) {
	count, err := c.client.Exists(ctx, groupRoomUserKey(userID)).Result()
	return count == 0 && err == nil, err
}

// SyncGroupRoomOwnership reads the room and this user's reservation in one
// Redis turn. Classification never mutates or transfers a reservation.
func (c *PresenceCoordinator) SyncGroupRoomOwnership(ctx context.Context, conversationID, roomID uuid.UUID, generation, revision int64, participant application.GroupParticipant) (application.GroupRoom, string, error) {
	result, err := c.client.Eval(ctx, `return {redis.call('HGETALL', KEYS[1]), redis.call('EXISTS', KEYS[2]), redis.call('GET', KEYS[2]) or ''}`, []string{groupRoomKey(roomID), groupRoomUserKey(participant.UserID)}).Slice()
	if err != nil {
		return application.GroupRoom{}, "", err
	}
	if len(result) != 3 {
		return application.GroupRoom{}, "", application.ErrCallUnavailable
	}
	fields, ok := result[0].([]interface{})
	if !ok || len(fields)%2 != 0 {
		return application.GroupRoom{}, "", application.ErrCallUnavailable
	}
	values := make(map[string]string, len(fields)/2)
	for i := 0; i < len(fields); i += 2 {
		key, keyOK := fields[i].(string)
		value, valueOK := fields[i+1].(string)
		if !keyOK || !valueOK {
			return application.GroupRoom{}, "", application.ErrCallUnavailable
		}
		values[key] = value
	}
	exists, ok := result[1].(int64)
	reservation, reservationOK := result[2].(string)
	if !ok || !reservationOK || (exists != 0 && exists != 1) {
		return application.GroupRoom{}, "", application.ErrCallUnavailable
	}
	if len(values) == 0 {
		if exists == 0 {
			return application.GroupRoom{}, "participant_absent", nil
		}
		return application.GroupRoom{}, "room_unavailable", nil
	}
	room, err := decodeGroupRoom(roomID, values)
	if err != nil {
		return application.GroupRoom{}, "room_unavailable", nil
	}
	// A retained live roster contradicts a missing reservation regardless of
	// which conversation, generation, or membership revision was requested.
	// Ended tombstones can retain former participants after releasing them.
	if exists == 0 && room.Status != application.GroupRoomEnded {
		for _, current := range room.Participants {
			if current.UserID == participant.UserID {
				return application.GroupRoom{}, "room_unavailable", nil
			}
		}
	}
	if room.ConversationID != conversationID || room.Generation != generation || room.MembershipRevision != revision {
		if exists == 0 {
			return application.GroupRoom{}, "participant_absent", nil
		}
		return application.GroupRoom{}, "room_unavailable", nil
	}
	if room.Status != application.GroupRoomActive && room.Status != application.GroupRoomRinging && room.Status != application.GroupRoomEnded {
		return application.GroupRoom{}, "room_unavailable", nil
	}
	if room.Status == application.GroupRoomEnded || !room.ExpiresAt.After(time.Now()) {
		if exists == 0 {
			return application.GroupRoom{}, "participant_absent", nil
		}
		return application.GroupRoom{}, "room_unavailable", nil
	}
	if groupParticipantInRoom(room, participant) && exists == 1 && reservation == roomID.String() {
		return room, "active", nil
	}
	if exists == 1 {
		return application.GroupRoom{}, "owned_elsewhere", nil
	}
	return application.GroupRoom{}, "participant_absent", nil
}

func groupParticipantInRoom(room application.GroupRoom, participant application.GroupParticipant) bool {
	for _, current := range room.Participants {
		if current.UserID == participant.UserID && current.DeviceID == participant.DeviceID && current.ConnectionID == participant.ConnectionID {
			return true
		}
	}
	return false
}

func (c *PresenceCoordinator) GetGroupRoomForConversation(ctx context.Context, conversationID uuid.UUID) (application.GroupRoom, error) {
	rawID, err := c.client.Get(ctx, groupRoomConversationKey(conversationID)).Result()
	if err == redis.Nil {
		return application.GroupRoom{}, application.ErrCallNotFound
	}
	if err != nil {
		return application.GroupRoom{}, err
	}
	roomID, err := uuid.Parse(rawID)
	if err != nil {
		return application.GroupRoom{}, application.ErrCallNotFound
	}
	room, err := c.groupRoom(ctx, roomID)
	if err != nil {
		return application.GroupRoom{}, err
	}
	if room.ConversationID != conversationID {
		return application.GroupRoom{}, application.ErrCallNotFound
	}
	return room, nil
}

func (c *PresenceCoordinator) SetGroupPresenter(ctx context.Context, roomID uuid.UUID, participant application.GroupParticipant, presenting bool) (application.GroupRoom, error) {
	result, err := c.client.Eval(ctx, setGroupPresenterScript, []string{groupRoomKey(roomID)}, participant.UserID.String(), participant.DeviceID, participant.ConnectionID, boolString(presenting)).Int()
	if err != nil {
		return application.GroupRoom{}, err
	}
	if result != 1 {
		return application.GroupRoom{}, callResultError(result)
	}
	return c.groupRoom(ctx, roomID)
}

func (c *PresenceCoordinator) RemoveGroupConnection(ctx context.Context, userID uuid.UUID, deviceID, connectionID string) ([]application.GroupRoom, error) {
	owner := application.GroupParticipant{UserID: userID, DeviceID: deviceID, ConnectionID: connectionID}
	if err := c.client.Eval(ctx, disconnectGroupAttemptsScript, []string{groupStartConnectionKey(owner)}).Err(); err != nil {
		return nil, err
	}
	roomID, err := c.client.Get(ctx, groupRoomUserKey(userID)).Result()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	id, err := uuid.Parse(roomID)
	if err != nil {
		return nil, nil
	}
	room, err := c.LeaveGroupRoom(ctx, id, application.GroupParticipant{UserID: userID, DeviceID: deviceID, ConnectionID: connectionID})
	if err == application.ErrCallNotFound || err == application.ErrCallNotAllowed {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return []application.GroupRoom{room}, nil
}

func (c *PresenceCoordinator) EndGroupRoomForMembershipChange(ctx context.Context, conversationID, roomID uuid.UUID, generation, roomRevision, membershipRevision int64) (application.GroupRoom, error) {
	result, err := c.client.Eval(ctx, endGroupRoomForMembershipChangeScript, []string{groupRoomKey(roomID), groupRoomConversationKey(conversationID), groupMembershipRetirementKey(conversationID, membershipRevision)}, generation, roomRevision, membershipRevision, int(groupRoomEndedTTL.Seconds())).Int64Slice()
	if err != nil {
		return application.GroupRoom{}, err
	}
	if len(result) != 2 {
		return application.GroupRoom{}, application.ErrCallUnavailable
	}
	if result[0] != 1 {
		return application.GroupRoom{}, callResultError(int(result[0]))
	}
	return application.GroupRoom{ID: roomID, Generation: generation, Status: application.GroupRoomEnded, StateRevision: result[1]}, nil
}

func groupMembershipRetirementKey(conversationID uuid.UUID, revision int64) string {
	return fmt.Sprintf("zwei:group-call:membership-retired:%s:%d", conversationID, revision)
}

func (c *PresenceCoordinator) GetGroupMembershipRetirement(ctx context.Context, conversationID uuid.UUID, revision int64) (application.GroupRoom, error) {
	if conversationID == uuid.Nil || revision <= 0 {
		return application.GroupRoom{}, application.ErrCallNotAllowed
	}
	result, err := c.client.Eval(ctx, `local id = redis.call('GET', KEYS[1]); if not id then return {} end; return {id, redis.call('HGETALL', 'zwei:group-call:room:' .. id)}`, []string{groupMembershipRetirementKey(conversationID, revision)}).Slice()
	if err != nil {
		return application.GroupRoom{}, err
	}
	if len(result) == 0 {
		return application.GroupRoom{}, application.ErrCallNotFound
	}
	if len(result) != 2 {
		return application.GroupRoom{}, application.ErrCallUnavailable
	}
	rawID, ok := result[0].(string)
	fields, fieldsOK := result[1].([]interface{})
	id, parseErr := uuid.Parse(rawID)
	if !ok || !fieldsOK || parseErr != nil || id == uuid.Nil || len(fields) == 0 || len(fields)%2 != 0 {
		return application.GroupRoom{}, application.ErrCallUnavailable
	}
	values := make(map[string]string, len(fields)/2)
	for i := 0; i < len(fields); i += 2 {
		key, keyOK := fields[i].(string)
		value, valueOK := fields[i+1].(string)
		if !keyOK || !valueOK {
			return application.GroupRoom{}, application.ErrCallUnavailable
		}
		values[key] = value
	}
	previousRevision, err := strconv.ParseInt(values["membership_retirement_previous_revision"], 10, 64)
	if err != nil || values["conversation_id"] != conversationID.String() || values["status"] != application.GroupRoomEnded || values["membership_retirement_revision"] != strconv.FormatInt(revision, 10) || values["ended_participants"] == "" || values["ended_connections"] == "" {
		return application.GroupRoom{}, application.ErrCallUnavailable
	}
	values["participants"], values["connections"], values["presenter"] = values["ended_participants"], values["ended_connections"], ""
	room, err := decodeGroupRoom(id, values)
	if err != nil || room.Generation <= 0 || room.MembershipRevision >= revision || room.StateRevision != previousRevision+1 || len(room.Participants) == 0 {
		return application.GroupRoom{}, application.ErrCallUnavailable
	}
	for _, participant := range room.Participants {
		if participant.UserID == uuid.Nil || participant.DeviceID == "" || participant.ConnectionID == "" {
			return application.GroupRoom{}, application.ErrCallUnavailable
		}
	}
	return room, nil
}

// ExpireGroupRooms atomically claims rooms whose logical lifetime elapsed.
// The expiry index permits best-effort terminal fan-out while the bounded
// snapshot remains available; it is not a delivery guarantee.
func (c *PresenceCoordinator) ExpireGroupRooms(ctx context.Context, limit int) ([]application.GroupRoom, error) {
	if limit <= 0 {
		return nil, nil
	}
	claim := uuid.NewString()
	ids, err := c.client.Eval(ctx, expireGroupRoomsScript, []string{groupRoomExpiryKey}, time.Now().UnixMilli(), limit, claim, int64((10 * time.Second).Milliseconds()), int(groupRoomEndedTTL.Seconds())).StringSlice()
	if err != nil {
		return nil, err
	}
	rooms := make([]application.GroupRoom, 0, len(ids))
	for _, rawID := range ids {
		roomID, err := uuid.Parse(rawID)
		if err != nil {
			continue
		}
		room, err := c.groupRoom(ctx, roomID)
		if err != nil {
			return nil, err
		}
		room.ExpiryClaimToken = claim
		rooms = append(rooms, room)
	}
	return rooms, nil
}

// AckExpiredGroupRoom acknowledges only the exact claim and terminal revision.
// A late worker cannot acknowledge a claim subsequently acquired by a replica.
func (c *PresenceCoordinator) AckExpiredGroupRoom(ctx context.Context, room application.GroupRoom) error {
	if room.ExpiryClaimToken == "" {
		return application.ErrCallNotAllowed
	}
	result, err := c.client.Eval(ctx, ackExpiredGroupRoomScript, []string{groupRoomKey(room.ID), groupRoomExpiryKey}, room.ID.String(), room.Generation, room.StateRevision, room.ExpiryClaimToken, int(groupRoomEndedTTL.Seconds())).Int()
	if err != nil {
		return err
	}
	if result != 1 {
		return application.ErrCallUnavailable
	}
	return nil
}

const ackExpiredGroupRoomScript = `if redis.call('HGET', KEYS[1], 'status') ~= 'ended' or redis.call('HGET', KEYS[1], 'generation') ~= ARGV[2] or redis.call('HGET', KEYS[1], 'state_revision') ~= ARGV[3] or redis.call('HGET', KEYS[1], 'expiry_claim') ~= ARGV[4] then return 0 end; redis.call('HDEL', KEYS[1], 'expiry_claim', 'expiry_pending'); if redis.call('TTL', KEYS[1]) == -1 then redis.call('EXPIRE', KEYS[1], ARGV[5]) end; redis.call('ZREM', KEYS[2], ARGV[1]); return 1`

func (c *PresenceCoordinator) PublishGroupRoom(ctx context.Context, change application.GroupRoomChange) error {
	change.Source = c.instanceID
	payload, err := json.Marshal(change)
	if err != nil {
		return err
	}
	subscribers, err := c.client.Publish(ctx, groupRoomChannel, payload).Result()
	if err != nil {
		return err
	}
	if subscribers == 0 {
		return errors.New("group call event has no subscribers")
	}
	return nil
}

func (c *PresenceCoordinator) ConsumeGroupRooms(ctx context.Context, handler func(context.Context, application.GroupRoomChange)) error {
	subscription := c.client.Subscribe(ctx, groupRoomChannel)
	defer subscription.Close()
	if _, err := subscription.Receive(ctx); err != nil {
		return err
	}
	for {
		message, err := subscription.ReceiveMessage(ctx)
		if err != nil {
			return err
		}
		var change application.GroupRoomChange
		if json.Unmarshal([]byte(message.Payload), &change) == nil && change.Source != c.instanceID {
			handler(ctx, change)
		}
	}
}

func (c *PresenceCoordinator) groupRoom(ctx context.Context, roomID uuid.UUID) (application.GroupRoom, error) {
	values, err := c.client.HGetAll(ctx, groupRoomKey(roomID)).Result()
	if err != nil {
		return application.GroupRoom{}, err
	}
	return decodeGroupRoom(roomID, values)
}

func decodeGroupRoom(roomID uuid.UUID, values map[string]string) (application.GroupRoom, error) {
	if len(values) == 0 {
		return application.GroupRoom{}, application.ErrCallNotFound
	}
	conversationID, err := uuid.Parse(values["conversation_id"])
	if err != nil {
		return application.GroupRoom{}, application.ErrCallNotFound
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, values["expires_at"])
	if err != nil {
		return application.GroupRoom{}, application.ErrCallNotFound
	}
	supportRef, _ := uuid.Parse(values["support_ref"])
	room := application.GroupRoom{ID: roomID, SupportRef: supportRef, ConversationID: conversationID, Status: values["status"], ExpiresAt: expiresAt}
	if values["ring_expires_at"] != "" {
		room.RingExpiresAt, err = time.Parse(time.RFC3339Nano, values["ring_expires_at"])
		if err != nil {
			return application.GroupRoom{}, application.ErrCallNotFound
		}
	} else {
		room.RingExpiresAt = expiresAt // Legacy ringing rooms used a single deadline.
	}
	if err := json.Unmarshal([]byte(values["participants"]), &room.Participants); err != nil {
		return application.GroupRoom{}, application.ErrCallNotFound
	}
	connections := make(map[string]string)
	for _, value := range strings.Split(values["connections"], ",") {
		parts := strings.SplitN(value, "|", 3)
		if len(parts) == 3 {
			connections[parts[0]+":"+parts[1]] = parts[2]
		}
	}
	for index := range room.Participants {
		room.Participants[index].ConnectionID = connections[room.Participants[index].UserID.String()+":"+room.Participants[index].DeviceID]
	}
	if values["presenter"] != "" {
		var presenter application.GroupParticipant
		if json.Unmarshal([]byte(values["presenter"]), &presenter) == nil {
			presenter.ConnectionID = connections[presenter.UserID.String()+":"+presenter.DeviceID]
			room.Presenter = &presenter
		}
	}
	if err := json.Unmarshal([]byte(values["membership_revision"]), &room.MembershipRevision); err != nil {
		return application.GroupRoom{}, application.ErrCallNotFound
	}
	if err := json.Unmarshal([]byte(values["generation"]), &room.Generation); err != nil {
		return application.GroupRoom{}, application.ErrCallNotFound
	}
	if values["state_revision"] == "" {
		// Legacy ephemeral rooms predate revisions; subsequent Redis mutations
		// increment the implicit zero value to one.
		room.StateRevision = 0
	} else if err := json.Unmarshal([]byte(values["state_revision"]), &room.StateRevision); err != nil || room.StateRevision <= 0 {
		return application.GroupRoom{}, application.ErrCallNotFound
	}
	sort.Slice(room.Participants, func(i, j int) bool {
		return room.Participants[i].UserID.String() < room.Participants[j].UserID.String()
	})
	return room, nil
}

func groupRoomKey(roomID uuid.UUID) string { return "zwei:group-call:room:" + roomID.String() }
func groupRoomConversationKey(conversationID uuid.UUID) string {
	return "zwei:group-call:conversation:" + conversationID.String()
}
func groupRoomUserKey(userID uuid.UUID) string { return "zwei:group-call:user:" + userID.String() }
func boolString(value bool) string {
	if value {
		return "1"
	}
	return "0"
}

// The scripts update the room and all reservation indexes in one Redis turn.
// The transport supplies current PostgreSQL membership revision on start/join.
const startGroupRoomScript = `if ARGV[13] == '' or redis.call('GET', 'zwei:call:admission:' .. ARGV[5]) ~= ARGV[13] then return 4 end; if redis.call('EXISTS', KEYS[1]) == 1 then return 6 end; if redis.call('EXISTS', KEYS[2]) == 1 or redis.call('EXISTS', KEYS[3]) == 1 or redis.call('EXISTS', 'zwei:call:user:' .. ARGV[5]) == 1 then return 4 end; local participant = '[{"user_id":"' .. ARGV[5] .. '","device_id":"' .. ARGV[6] .. '"}]'; redis.call('HSET', KEYS[1], 'conversation_id', ARGV[2], 'membership_revision', ARGV[3], 'generation', ARGV[4], 'state_revision', 1, 'status', 'ringing', 'expires_at', ARGV[9], 'expires_at_unix_ms', ARGV[10], 'participants', participant, 'connections', ARGV[5] .. '|' .. ARGV[6] .. '|' .. ARGV[7], 'support_ref', ARGV[8]); redis.call('EXPIRE', KEYS[1], ARGV[11]); redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[11]); redis.call('SET', KEYS[3], ARGV[1], 'EX', ARGV[11]); redis.call('ZADD', KEYS[4], ARGV[10], ARGV[1]); return 1`

var joinGroupRoomWithAttemptScript = `if redis.call('EXISTS', KEYS[1]) == 0 then return 2 end; local attempt = redis.call('HGET', KEYS[1], 'start_attempt_key'); if attempt and (redis.call('HGET', attempt, 'state') ~= 'started' or redis.call('HGET', attempt, 'room') ~= string.sub(KEYS[1], 22)) then return 3 end; ARGV[5] = redis.call('HGET', KEYS[1], 'expires_at'); ARGV[6] = redis.call('HGET', KEYS[1], 'expires_at_unix_ms'); if not ARGV[5] or not tonumber(ARGV[6]) then return 2 end; local remaining = math.max(1, math.ceil((tonumber(ARGV[6]) - tonumber(ARGV[9])) / 1000) + 60); ARGV[7] = remaining; ARGV[8] = remaining; ` + strings.TrimSuffix(joinGroupRoomScript, "return 1") + `redis.call('PERSIST', KEYS[1]); if attempt then redis.call('EXPIRE', attempt, ARGV[7]) end; return 1`

const joinGroupRoomScript = `if ARGV[10] == '' or redis.call('GET', 'zwei:call:admission:' .. ARGV[1]) ~= ARGV[10] then return 4 end; if redis.call('EXISTS', KEYS[1]) == 0 then return 2 end; if redis.call('HGET', KEYS[1], 'status') == 'ended' then return 6 end; if tonumber(redis.call('HGET', KEYS[1], 'expires_at_unix_ms')) <= tonumber(ARGV[9]) then return 2 end; if redis.call('EXISTS', KEYS[2]) == 1 or redis.call('GET', 'zwei:call:admission:' .. ARGV[1]) ~= ARGV[10] or redis.call('EXISTS', 'zwei:call:user:' .. ARGV[1]) == 1 then return 4 end; if redis.call('HGET', KEYS[1], 'membership_revision') ~= ARGV[4] then return 3 end; local participants = cjson.decode(redis.call('HGET', KEYS[1], 'participants')); if #participants >= tonumber(ARGV[11]) then return 7 end; local roomID = string.sub(KEYS[1], 22); local conversationKey = 'zwei:group-call:conversation:' .. redis.call('HGET', KEYS[1], 'conversation_id'); local indexedRoom = redis.call('GET', conversationKey); if indexedRoom and indexedRoom ~= roomID then return 4 end; if not indexedRoom then local restored = redis.call('SET', conversationKey, roomID, 'EX', ARGV[7], 'NX'); if not restored and redis.call('GET', conversationKey) ~= roomID then return 4 end end; table.insert(participants, {user_id=ARGV[1], device_id=ARGV[2]}); redis.call('HSETNX', KEYS[1], 'state_revision', 1); redis.call('HINCRBY', KEYS[1], 'state_revision', 1); redis.call('HSET', KEYS[1], 'participants', cjson.encode(participants), 'connections', redis.call('HGET', KEYS[1], 'connections') .. ',' .. ARGV[1] .. '|' .. ARGV[2] .. '|' .. ARGV[3], 'status', 'active', 'expires_at', ARGV[5], 'expires_at_unix_ms', ARGV[6]); redis.call('EXPIRE', KEYS[1], ARGV[7]); redis.call('SET', KEYS[2], roomID, 'EX', ARGV[8]); for _, current in ipairs(participants) do local userKey = 'zwei:group-call:user:' .. current.user_id; if redis.call('GET', userKey) == roomID then redis.call('EXPIRE', userKey, ARGV[8]) end end; redis.call('EXPIRE', conversationKey, ARGV[7]); redis.call('ZADD', KEYS[3], ARGV[6], roomID); return 1`

const leaveGroupRoomScript = `if redis.call('EXISTS', KEYS[1]) == 0 then return 2 end; local token = ARGV[1] .. '|' .. ARGV[2] .. '|' .. ARGV[3]; local connections = redis.call('HGET', KEYS[1], 'connections'); if not string.find(',' .. connections .. ',', ',' .. token .. ',', 1, true) then return 3 end; local participants = cjson.decode(redis.call('HGET', KEYS[1], 'participants')); local kept = {}; local keptConnections = {}; for _, participant in ipairs(participants) do if participant.user_id ~= ARGV[1] or participant.device_id ~= ARGV[2] then table.insert(kept, participant); local prefix = participant.user_id .. '|' .. participant.device_id .. '|'; for connection in string.gmatch(connections, '[^,]+') do if string.sub(connection, 1, string.len(prefix)) == prefix then table.insert(keptConnections, connection) end end end end; local presenter = redis.call('HGET', KEYS[1], 'presenter'); if presenter and presenter ~= '' then local decoded = cjson.decode(presenter); if decoded.user_id == ARGV[1] and decoded.device_id == ARGV[2] then redis.call('HDEL', KEYS[1], 'presenter') end end; local roomID = string.sub(KEYS[1], 22); if redis.call('GET', KEYS[2]) == roomID then redis.call('DEL', KEYS[2]) end; redis.call('HINCRBY', KEYS[1], 'state_revision', 1); if #kept == 0 then redis.call('HSET', KEYS[1], 'ended_participants', redis.call('HGET', KEYS[1], 'participants'), 'ended_connections', connections, 'participants', '[]', 'connections', '', 'status', 'ended'); redis.call('EXPIRE', KEYS[1], ARGV[4]); local conversationKey = 'zwei:group-call:conversation:' .. redis.call('HGET', KEYS[1], 'conversation_id'); if redis.call('GET', conversationKey) == roomID then redis.call('DEL', conversationKey) end; redis.call('ZREM', 'zwei:group-call:expirations', roomID); else redis.call('HSET', KEYS[1], 'participants', cjson.encode(kept), 'connections', table.concat(keptConnections, ',')) end; return 1`
const endGroupRoomScript = `if redis.call('EXISTS', KEYS[1]) == 0 then return 2 end; local token = ARGV[1] .. '|' .. ARGV[2] .. '|' .. ARGV[3]; local connections = redis.call('HGET', KEYS[1], 'connections'); if not string.find(',' .. connections .. ',', ',' .. token .. ',', 1, true) then return 3 end; local participants = cjson.decode(redis.call('HGET', KEYS[1], 'participants')); local roomID = string.sub(KEYS[1], 22); for _, participant in ipairs(participants) do local userKey = 'zwei:group-call:user:' .. participant.user_id; if redis.call('GET', userKey) == roomID then redis.call('DEL', userKey) end end; redis.call('HINCRBY', KEYS[1], 'state_revision', 1); redis.call('HSET', KEYS[1], 'ended_participants', redis.call('HGET', KEYS[1], 'participants'), 'ended_connections', connections, 'participants', '[]', 'connections', '', 'status', 'ended'); redis.call('EXPIRE', KEYS[1], ARGV[4]); local conversationKey = 'zwei:group-call:conversation:' .. redis.call('HGET', KEYS[1], 'conversation_id'); if redis.call('GET', conversationKey) == roomID then redis.call('DEL', conversationKey) end; redis.call('ZREM', 'zwei:group-call:expirations', roomID); return 1`
const setGroupPresenterScript = `if redis.call('EXISTS', KEYS[1]) == 0 then return 2 end; local token = ARGV[1] .. '|' .. ARGV[2] .. '|' .. ARGV[3]; if not string.find(',' .. redis.call('HGET', KEYS[1], 'connections') .. ',', ',' .. token .. ',', 1, true) then return 3 end; if ARGV[4] == '1' then redis.call('HSET', KEYS[1], 'presenter', '{"user_id":"' .. ARGV[1] .. '","device_id":"' .. ARGV[2] .. '"}') else local presenter = redis.call('HGET', KEYS[1], 'presenter'); if presenter and presenter ~= '' then local decoded = cjson.decode(presenter); if decoded.user_id ~= ARGV[1] or decoded.device_id ~= ARGV[2] then return 3 end end; redis.call('HDEL', KEYS[1], 'presenter') end; redis.call('HINCRBY', KEYS[1], 'state_revision', 1); return 1`
const endGroupRoomForMembershipChangeScript = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {2, 0} end
local roomID = string.sub(KEYS[1], 22)
if 'zwei:group-call:conversation:' .. (redis.call('HGET', KEYS[1], 'conversation_id') or '') ~= KEYS[2] then return {2, 0} end
local recorded = redis.call('GET', KEYS[3])
if redis.call('HGET', KEYS[1], 'status') == 'ended' and recorded == roomID and redis.call('HGET', KEYS[1], 'generation') == ARGV[1] and redis.call('HGET', KEYS[1], 'membership_retirement_revision') == ARGV[3] and redis.call('HGET', KEYS[1], 'membership_retirement_previous_revision') == ARGV[2] and tonumber(redis.call('HGET', KEYS[1], 'state_revision')) == tonumber(ARGV[2]) + 1 then
  return {1, tonumber(redis.call('HGET', KEYS[1], 'state_revision'))}
end
if redis.call('GET', KEYS[2]) ~= roomID then return {2, 0} end
if recorded or redis.call('HGET', KEYS[1], 'generation') ~= ARGV[1] or tonumber(redis.call('HGET', KEYS[1], 'state_revision') or '0') ~= tonumber(ARGV[2]) or tonumber(redis.call('HGET', KEYS[1], 'membership_revision')) >= tonumber(ARGV[3]) or redis.call('HGET', KEYS[1], 'status') == 'ended' then return {3, 0} end
local connections = redis.call('HGET', KEYS[1], 'connections')
for _, participant in ipairs(cjson.decode(redis.call('HGET', KEYS[1], 'participants'))) do local key = 'zwei:group-call:user:' .. participant.user_id; if redis.call('GET', key) == roomID then redis.call('DEL', key) end end
local terminalRevision = redis.call('HINCRBY', KEYS[1], 'state_revision', 1)
redis.call('HSET', KEYS[1], 'ended_participants', redis.call('HGET', KEYS[1], 'participants'), 'ended_connections', connections, 'participants', '[]', 'connections', '', 'status', 'ended', 'membership_retirement_revision', ARGV[3], 'membership_retirement_previous_revision', ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[4]); redis.call('SET', KEYS[3], roomID, 'EX', ARGV[4]); redis.call('DEL', KEYS[2]); redis.call('ZREM', 'zwei:group-call:expirations', roomID)
return {1, terminalRevision}`
const abortGroupRoomStartScript = `if redis.call('EXISTS', KEYS[1]) == 0 then return 2 end; if redis.call('HGET', KEYS[1], 'generation') ~= ARGV[2] then return 3 end; local owner = ARGV[3] .. '|' .. ARGV[4] .. '|' .. ARGV[5]; local connections = redis.call('HGET', KEYS[1], 'connections') or ''; if not string.find(',' .. connections .. ',', ',' .. owner .. ',', 1, true) then return 3 end; if redis.call('HGET', KEYS[1], 'status') == 'ended' then return 2 end; local roomID = ARGV[1]; local participants = cjson.decode(redis.call('HGET', KEYS[1], 'participants')); for _, participant in ipairs(participants) do local userKey = 'zwei:group-call:user:' .. participant.user_id; if redis.call('GET', userKey) == roomID then redis.call('DEL', userKey) end end; local conversationKey = 'zwei:group-call:conversation:' .. redis.call('HGET', KEYS[1], 'conversation_id'); if redis.call('GET', conversationKey) == roomID then redis.call('DEL', conversationKey) end; redis.call('HINCRBY', KEYS[1], 'state_revision', 1); redis.call('HSET', KEYS[1], 'ended_participants', redis.call('HGET', KEYS[1], 'participants'), 'ended_connections', connections, 'participants', '[]', 'connections', '', 'status', 'ended'); redis.call('HDEL', KEYS[1], 'presenter'); redis.call('EXPIRE', KEYS[1], ARGV[6]); redis.call('ZREM', 'zwei:group-call:expirations', roomID); return 1`
const expireGroupRoomsScript = `
local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[2]); local claimed = {}
for _, roomID in ipairs(ids) do
  local roomKey = 'zwei:group-call:room:' .. roomID
  if redis.call('EXISTS', roomKey) == 0 then redis.call('ZREM', KEYS[1], roomID)
  else
    local status = redis.call('HGET', roomKey, 'status')
    local pending = redis.call('HGET', roomKey, 'expiry_pending') == '1'
    local deadline = tonumber(redis.call('HGET', roomKey, 'expires_at_unix_ms'))
    if status ~= 'ended' and deadline and deadline <= tonumber(ARGV[1]) then
      local connections = redis.call('HGET', roomKey, 'connections')
      for _, participant in ipairs(cjson.decode(redis.call('HGET', roomKey, 'participants'))) do
        local key = 'zwei:group-call:user:' .. participant.user_id; if redis.call('GET', key) == roomID then redis.call('DEL', key) end
      end
      local key = 'zwei:group-call:conversation:' .. redis.call('HGET', roomKey, 'conversation_id'); if redis.call('GET', key) == roomID then redis.call('DEL', key) end
      redis.call('HINCRBY', roomKey, 'state_revision', 1)
      redis.call('HSET', roomKey, 'ended_participants', redis.call('HGET', roomKey, 'participants'), 'ended_connections', connections, 'status', 'ended', 'expiry_pending', '1')
      redis.call('HDEL', roomKey, 'presenter'); redis.call('EXPIRE', roomKey, ARGV[5]); pending = true
    end
    if pending then
      -- Legacy pending rooms may predate bounded retention. Set a deadline
      -- once, never on a retry of an already bounded snapshot.
      if redis.call('TTL', roomKey) == -1 then redis.call('EXPIRE', roomKey, ARGV[5]) end
      redis.call('HSET', roomKey, 'expiry_claim', ARGV[3]); redis.call('ZADD', KEYS[1], tonumber(ARGV[1]) + tonumber(ARGV[4]), roomID); table.insert(claimed, roomID)
    elseif status == 'ended' then redis.call('ZREM', KEYS[1], roomID)
    elseif deadline then redis.call('ZADD', KEYS[1], deadline, roomID)
    end
  end
end
return claimed`

var _ application.GroupRoomCoordinator = (*PresenceCoordinator)(nil)
var _ application.GroupRoomConsumer = (*PresenceCoordinator)(nil)
