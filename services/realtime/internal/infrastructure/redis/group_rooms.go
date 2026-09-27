package redis

import (
	"context"
	"encoding/json"
	"sort"
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

func (c *PresenceCoordinator) StartGroupRoom(ctx context.Context, room application.GroupRoom, admissionToken string) (application.GroupRoom, error) {
	if len(room.Participants) != 1 || room.ID == uuid.Nil || room.ConversationID == uuid.Nil || room.MembershipRevision <= 0 || room.Generation <= 0 || room.Participants[0].UserID == uuid.Nil || room.Participants[0].DeviceID == "" || room.Participants[0].ConnectionID == "" {
		return application.GroupRoom{}, application.ErrCallNotAllowed
	}
	if admissionToken == "" {
		return application.GroupRoom{}, application.ErrCallNotAllowed
	}
	expiresAt := time.Now().Add(groupRoomRingingTTL).UTC()
	result, err := c.client.Eval(ctx, startGroupRoomScript, []string{groupRoomKey(room.ID), groupRoomConversationKey(room.ConversationID), groupRoomUserKey(room.Participants[0].UserID), groupRoomExpiryKey}, room.ID.String(), room.ConversationID.String(), room.MembershipRevision, room.Generation, room.Participants[0].UserID.String(), room.Participants[0].DeviceID, room.Participants[0].ConnectionID, expiresAt.Format(time.RFC3339Nano), expiresAt.UnixMilli(), int((groupRoomRingingTTL + groupRoomEndedTTL).Seconds()), int(groupRoomRingingTTL.Seconds()), admissionToken).Int()
	if err != nil {
		return application.GroupRoom{}, err
	}
	if result != 1 {
		return application.GroupRoom{}, callResultError(result)
	}
	return c.groupRoom(ctx, room.ID)
}

func (c *PresenceCoordinator) JoinGroupRoom(ctx context.Context, roomID uuid.UUID, participant application.GroupParticipant, revision int64, admissionToken string) (application.GroupRoom, error) {
	if admissionToken == "" {
		return application.GroupRoom{}, application.ErrCallNotAllowed
	}
	expiresAt := time.Now().Add(groupRoomActiveTTL).UTC()
	result, err := c.client.Eval(ctx, joinGroupRoomScript, []string{groupRoomKey(roomID), groupRoomUserKey(participant.UserID), groupRoomExpiryKey}, participant.UserID.String(), participant.DeviceID, participant.ConnectionID, revision, expiresAt.Format(time.RFC3339Nano), expiresAt.UnixMilli(), int((groupRoomActiveTTL + groupRoomEndedTTL).Seconds()), int(groupRoomActiveTTL.Seconds()), time.Now().UnixMilli(), admissionToken).Int()
	if err != nil {
		return application.GroupRoom{}, err
	}
	if result != 1 {
		return application.GroupRoom{}, callResultError(result)
	}
	return c.groupRoom(ctx, roomID)
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

// SyncGroupRoom returns an active roster only to the socket that owns an active
// participant in the requested generation. Every other outcome is a minimal
// terminal result; callers must not infer room or roster existence from it.
func (c *PresenceCoordinator) SyncGroupRoom(ctx context.Context, roomID uuid.UUID, generation int64, participant application.GroupParticipant) (application.GroupRoom, bool, error) {
	room, err := c.groupRoom(ctx, roomID)
	if err != nil {
		if err == application.ErrCallNotFound {
			return application.GroupRoom{ID: roomID, Generation: generation, Status: application.GroupRoomEnded}, false, nil
		}
		return application.GroupRoom{}, false, err
	}
	if room.Generation != generation || room.Status != application.GroupRoomActive || !groupParticipantInRoom(room, participant) {
		return application.GroupRoom{ID: roomID, Generation: generation, Status: application.GroupRoomEnded}, false, nil
	}
	return room, true, nil
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
	return c.groupRoom(ctx, roomID)
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
	rawID, err := c.client.Get(ctx, groupRoomConversationKey(conversationID)).Result()
	if err == redis.Nil {
		return application.GroupRoom{}, application.ErrCallNotFound
	}
	if err != nil {
		return application.GroupRoom{}, err
	}
	currentRoomID, err := uuid.Parse(rawID)
	if err != nil || currentRoomID != roomID {
		return application.GroupRoom{}, application.ErrCallNotFound
	}
	result, err := c.client.Eval(ctx, endGroupRoomForMembershipChangeScript, []string{groupRoomKey(roomID), groupRoomConversationKey(conversationID)}, generation, roomRevision, membershipRevision, int(groupRoomEndedTTL.Seconds())).Int()
	if err != nil {
		return application.GroupRoom{}, err
	}
	if result != 1 {
		return application.GroupRoom{}, callResultError(result)
	}
	return c.groupRoom(ctx, roomID)
}

// ExpireGroupRooms atomically claims rooms whose logical lifetime elapsed.
// The expiry index makes terminal fan-out possible before the retained room
// snapshot is discarded; ordinary key TTL alone cannot provide that snapshot.
func (c *PresenceCoordinator) ExpireGroupRooms(ctx context.Context, limit int) ([]application.GroupRoom, error) {
	if limit <= 0 {
		return nil, nil
	}
	ids, err := c.client.Eval(ctx, expireGroupRoomsScript, []string{groupRoomExpiryKey}, time.Now().UnixMilli(), limit, int(groupRoomEndedTTL.Seconds())).StringSlice()
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
		if err == nil {
			rooms = append(rooms, room)
		}
	}
	return rooms, nil
}

func (c *PresenceCoordinator) PublishGroupRoom(ctx context.Context, change application.GroupRoomChange) error {
	change.Source = c.instanceID
	payload, err := json.Marshal(change)
	if err != nil {
		return err
	}
	return c.client.Publish(ctx, groupRoomChannel, payload).Err()
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
	room := application.GroupRoom{ID: roomID, ConversationID: conversationID, Status: values["status"], ExpiresAt: expiresAt}
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
const startGroupRoomScript = `if ARGV[12] == '' or redis.call('GET', 'zwei:call:admission:' .. ARGV[5]) ~= ARGV[12] then return 4 end; if redis.call('EXISTS', KEYS[1]) == 1 then return 6 end; if redis.call('EXISTS', KEYS[2]) == 1 or redis.call('EXISTS', KEYS[3]) == 1 or redis.call('EXISTS', 'zwei:call:user:' .. ARGV[5]) == 1 then return 4 end; local participant = '[{"user_id":"' .. ARGV[5] .. '","device_id":"' .. ARGV[6] .. '"}]'; redis.call('HSET', KEYS[1], 'conversation_id', ARGV[2], 'membership_revision', ARGV[3], 'generation', ARGV[4], 'state_revision', 1, 'status', 'ringing', 'expires_at', ARGV[8], 'expires_at_unix_ms', ARGV[9], 'participants', participant, 'connections', ARGV[5] .. '|' .. ARGV[6] .. '|' .. ARGV[7]); redis.call('EXPIRE', KEYS[1], ARGV[10]); redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[10]); redis.call('SET', KEYS[3], ARGV[1], 'EX', ARGV[10]); redis.call('ZADD', KEYS[4], ARGV[9], ARGV[1]); return 1`
const joinGroupRoomScript = `if ARGV[10] == '' or redis.call('GET', 'zwei:call:admission:' .. ARGV[1]) ~= ARGV[10] then return 4 end; if redis.call('EXISTS', KEYS[1]) == 0 then return 2 end; if redis.call('HGET', KEYS[1], 'status') == 'ended' then return 6 end; if tonumber(redis.call('HGET', KEYS[1], 'expires_at_unix_ms')) <= tonumber(ARGV[9]) then return 2 end; if redis.call('EXISTS', KEYS[2]) == 1 or redis.call('GET', 'zwei:call:admission:' .. ARGV[1]) ~= ARGV[10] or redis.call('EXISTS', 'zwei:call:user:' .. ARGV[1]) == 1 then return 4 end; if redis.call('HGET', KEYS[1], 'membership_revision') ~= ARGV[4] then return 3 end; local participants = cjson.decode(redis.call('HGET', KEYS[1], 'participants')); if #participants >= 4 then return 6 end; table.insert(participants, {user_id=ARGV[1], device_id=ARGV[2]}); redis.call('HSETNX', KEYS[1], 'state_revision', 1); redis.call('HINCRBY', KEYS[1], 'state_revision', 1); redis.call('HSET', KEYS[1], 'participants', cjson.encode(participants), 'connections', redis.call('HGET', KEYS[1], 'connections') .. ',' .. ARGV[1] .. '|' .. ARGV[2] .. '|' .. ARGV[3], 'status', 'active', 'expires_at', ARGV[5], 'expires_at_unix_ms', ARGV[6]); redis.call('EXPIRE', KEYS[1], ARGV[7]); redis.call('SET', KEYS[2], string.sub(KEYS[1], 22), 'EX', ARGV[8]); redis.call('ZADD', KEYS[3], ARGV[6], string.sub(KEYS[1], 22)); return 1`
const leaveGroupRoomScript = `if redis.call('EXISTS', KEYS[1]) == 0 then return 2 end; local token = ARGV[1] .. '|' .. ARGV[2] .. '|' .. ARGV[3]; local connections = redis.call('HGET', KEYS[1], 'connections'); if not string.find(',' .. connections .. ',', ',' .. token .. ',', 1, true) then return 3 end; local participants = cjson.decode(redis.call('HGET', KEYS[1], 'participants')); local kept = {}; local keptConnections = {}; for _, participant in ipairs(participants) do if participant.user_id ~= ARGV[1] or participant.device_id ~= ARGV[2] then table.insert(kept, participant); local prefix = participant.user_id .. '|' .. participant.device_id .. '|'; for connection in string.gmatch(connections, '[^,]+') do if string.sub(connection, 1, string.len(prefix)) == prefix then table.insert(keptConnections, connection) end end end end; local presenter = redis.call('HGET', KEYS[1], 'presenter'); if presenter and presenter ~= '' then local decoded = cjson.decode(presenter); if decoded.user_id == ARGV[1] and decoded.device_id == ARGV[2] then redis.call('HDEL', KEYS[1], 'presenter') end end; local roomID = string.sub(KEYS[1], 22); if redis.call('GET', KEYS[2]) == roomID then redis.call('DEL', KEYS[2]) end; redis.call('HINCRBY', KEYS[1], 'state_revision', 1); if #kept == 0 then redis.call('HSET', KEYS[1], 'ended_participants', redis.call('HGET', KEYS[1], 'participants'), 'ended_connections', connections, 'participants', '[]', 'connections', '', 'status', 'ended'); redis.call('EXPIRE', KEYS[1], ARGV[4]); redis.call('DEL', 'zwei:group-call:conversation:' .. redis.call('HGET', KEYS[1], 'conversation_id')); redis.call('ZREM', 'zwei:group-call:expirations', roomID); else redis.call('HSET', KEYS[1], 'participants', cjson.encode(kept), 'connections', table.concat(keptConnections, ',')) end; return 1`
const endGroupRoomScript = `if redis.call('EXISTS', KEYS[1]) == 0 then return 2 end; local token = ARGV[1] .. '|' .. ARGV[2] .. '|' .. ARGV[3]; local connections = redis.call('HGET', KEYS[1], 'connections'); if not string.find(',' .. connections .. ',', ',' .. token .. ',', 1, true) then return 3 end; local participants = cjson.decode(redis.call('HGET', KEYS[1], 'participants')); local roomID = string.sub(KEYS[1], 22); for _, participant in ipairs(participants) do local userKey = 'zwei:group-call:user:' .. participant.user_id; if redis.call('GET', userKey) == roomID then redis.call('DEL', userKey) end end; redis.call('HINCRBY', KEYS[1], 'state_revision', 1); redis.call('HSET', KEYS[1], 'ended_participants', redis.call('HGET', KEYS[1], 'participants'), 'ended_connections', connections, 'participants', '[]', 'connections', '', 'status', 'ended'); redis.call('EXPIRE', KEYS[1], ARGV[4]); redis.call('DEL', 'zwei:group-call:conversation:' .. redis.call('HGET', KEYS[1], 'conversation_id')); redis.call('ZREM', 'zwei:group-call:expirations', roomID); return 1`
const setGroupPresenterScript = `if redis.call('EXISTS', KEYS[1]) == 0 then return 2 end; local token = ARGV[1] .. '|' .. ARGV[2] .. '|' .. ARGV[3]; if not string.find(',' .. redis.call('HGET', KEYS[1], 'connections') .. ',', ',' .. token .. ',', 1, true) then return 3 end; if ARGV[4] == '1' then redis.call('HSET', KEYS[1], 'presenter', '{"user_id":"' .. ARGV[1] .. '","device_id":"' .. ARGV[2] .. '"}') else local presenter = redis.call('HGET', KEYS[1], 'presenter'); if presenter and presenter ~= '' then local decoded = cjson.decode(presenter); if decoded.user_id ~= ARGV[1] or decoded.device_id ~= ARGV[2] then return 3 end end; redis.call('HDEL', KEYS[1], 'presenter') end; redis.call('HINCRBY', KEYS[1], 'state_revision', 1); return 1`
const endGroupRoomForMembershipChangeScript = `if redis.call('EXISTS', KEYS[1]) == 0 then return 2 end; if redis.call('GET', KEYS[2]) ~= string.sub(KEYS[1], 22) or redis.call('HGET', KEYS[1], 'generation') ~= ARGV[1] or tonumber(redis.call('HGET', KEYS[1], 'state_revision') or '0') ~= tonumber(ARGV[2]) or tonumber(redis.call('HGET', KEYS[1], 'membership_revision')) >= tonumber(ARGV[3]) or redis.call('HGET', KEYS[1], 'status') == 'ended' then return 3 end; local roomID = string.sub(KEYS[1], 22); local connections = redis.call('HGET', KEYS[1], 'connections'); for _, participant in ipairs(cjson.decode(redis.call('HGET', KEYS[1], 'participants'))) do local key = 'zwei:group-call:user:' .. participant.user_id; if redis.call('GET', key) == roomID then redis.call('DEL', key) end end; redis.call('HINCRBY', KEYS[1], 'state_revision', 1); redis.call('HSET', KEYS[1], 'ended_participants', redis.call('HGET', KEYS[1], 'participants'), 'ended_connections', connections, 'participants', '[]', 'connections', '', 'status', 'ended'); redis.call('EXPIRE', KEYS[1], ARGV[4]); redis.call('DEL', KEYS[2]); redis.call('ZREM', 'zwei:group-call:expirations', roomID); return 1`
const abortGroupRoomStartScript = `if redis.call('EXISTS', KEYS[1]) == 0 then return 2 end; if redis.call('HGET', KEYS[1], 'generation') ~= ARGV[2] then return 3 end; local owner = ARGV[3] .. '|' .. ARGV[4] .. '|' .. ARGV[5]; local connections = redis.call('HGET', KEYS[1], 'connections') or ''; if not string.find(',' .. connections .. ',', ',' .. owner .. ',', 1, true) then return 3 end; if redis.call('HGET', KEYS[1], 'status') == 'ended' then return 2 end; local roomID = ARGV[1]; local participants = cjson.decode(redis.call('HGET', KEYS[1], 'participants')); for _, participant in ipairs(participants) do local userKey = 'zwei:group-call:user:' .. participant.user_id; if redis.call('GET', userKey) == roomID then redis.call('DEL', userKey) end end; local conversationKey = 'zwei:group-call:conversation:' .. redis.call('HGET', KEYS[1], 'conversation_id'); if redis.call('GET', conversationKey) == roomID then redis.call('DEL', conversationKey) end; redis.call('HINCRBY', KEYS[1], 'state_revision', 1); redis.call('HSET', KEYS[1], 'ended_participants', redis.call('HGET', KEYS[1], 'participants'), 'ended_connections', connections, 'participants', '[]', 'connections', '', 'status', 'ended'); redis.call('HDEL', KEYS[1], 'presenter'); redis.call('EXPIRE', KEYS[1], ARGV[6]); redis.call('ZREM', 'zwei:group-call:expirations', roomID); return 1`
const expireGroupRoomsScript = `local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[2]); local expired = {}; for _, roomID in ipairs(ids) do redis.call('ZREM', KEYS[1], roomID); local roomKey = 'zwei:group-call:room:' .. roomID; if redis.call('EXISTS', roomKey) == 1 and redis.call('HGET', roomKey, 'status') ~= 'ended' and tonumber(redis.call('HGET', roomKey, 'expires_at_unix_ms')) <= tonumber(ARGV[1]) then local connections = redis.call('HGET', roomKey, 'connections'); for _, participant in ipairs(cjson.decode(redis.call('HGET', roomKey, 'participants'))) do local userKey = 'zwei:group-call:user:' .. participant.user_id; if redis.call('GET', userKey) == roomID then redis.call('DEL', userKey) end end; local conversationKey = 'zwei:group-call:conversation:' .. redis.call('HGET', roomKey, 'conversation_id'); if redis.call('GET', conversationKey) == roomID then redis.call('DEL', conversationKey) end; redis.call('HINCRBY', roomKey, 'state_revision', 1); redis.call('HSET', roomKey, 'ended_participants', redis.call('HGET', roomKey, 'participants'), 'ended_connections', connections, 'status', 'ended'); redis.call('HDEL', roomKey, 'presenter'); redis.call('EXPIRE', roomKey, ARGV[3]); table.insert(expired, roomID) end end; return expired`

var _ application.GroupRoomCoordinator = (*PresenceCoordinator)(nil)
var _ application.GroupRoomConsumer = (*PresenceCoordinator)(nil)
