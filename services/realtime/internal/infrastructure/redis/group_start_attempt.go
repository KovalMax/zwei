package redis

import (
	"context"
	"crypto/sha256"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/KovalMax/zwei/services/realtime/internal/application"
)

const (
	groupStartAttemptTTL   = 30 * time.Second
	groupStartAttemptLimit = 32
)

func groupStartAttemptKey(id uuid.UUID) string {
	sum := sha256.Sum256(id[:])
	return fmt.Sprintf("zwei:group-call:attempt:sha256:%x", sum)
}

func groupStartConnectionKey(owner application.GroupParticipant) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s:%q:%q", owner.UserID, owner.DeviceID, owner.ConnectionID)))
	return fmt.Sprintf("zwei:group-call:attempts-by-connection:v2:%x", sum)
}

// PrepareGroupRoomStart issues a socket-bound, single-use permit. Redis expiry
// is authoritative, including the returned client-facing deadline.
func (c *PresenceCoordinator) PrepareGroupRoomStart(ctx context.Context, conversationID uuid.UUID, owner application.GroupParticipant) (uuid.UUID, time.Time, error) {
	if conversationID == uuid.Nil || owner.UserID == uuid.Nil || owner.DeviceID == "" || owner.ConnectionID == "" {
		return uuid.Nil, time.Time{}, application.ErrCallNotAllowed
	}
	id, err := uuid.NewRandom()
	if err != nil {
		return uuid.Nil, time.Time{}, err
	}
	result, err := c.client.Eval(ctx, prepareGroupStartScript, []string{groupStartAttemptKey(id), groupStartConnectionKey(owner)}, conversationID.String(), owner.UserID.String(), owner.DeviceID, owner.ConnectionID, int(groupStartAttemptTTL.Seconds()), groupStartAttemptLimit).Int64()
	if err != nil {
		return uuid.Nil, time.Time{}, err
	}
	if result <= 0 {
		return uuid.Nil, time.Time{}, application.ErrCallUnavailable
	}
	return id, time.UnixMilli(result).UTC(), nil
}

// StartPreparedGroupRoom checks the permit and admission in the same Redis
// operation that creates the room. A cancelled or expired permit cannot start.
func (c *PresenceCoordinator) StartPreparedGroupRoom(ctx context.Context, room application.GroupRoom, admissionToken string, attemptID uuid.UUID) (application.GroupRoom, error) {
	if len(room.Participants) != 1 || room.ID == uuid.Nil || room.ConversationID == uuid.Nil || room.MembershipRevision <= 0 || room.Generation <= 0 || room.Participants[0].UserID == uuid.Nil || room.Participants[0].DeviceID == "" || room.Participants[0].ConnectionID == "" || admissionToken == "" || attemptID == uuid.Nil {
		return application.GroupRoom{}, application.ErrCallNotAllowed
	}
	owner := room.Participants[0]
	now := time.Now().UTC()
	expires := now.Add(groupRoomActiveTTL)
	ringExpires := now.Add(groupRoomRingingTTL)
	result, err := c.client.Eval(ctx, startPreparedGroupRoomScript, []string{groupRoomKey(room.ID), groupRoomConversationKey(room.ConversationID), groupRoomUserKey(owner.UserID), groupRoomExpiryKey, groupStartAttemptKey(attemptID), groupStartConnectionKey(owner)}, room.ID.String(), room.ConversationID.String(), room.MembershipRevision, room.Generation, owner.UserID.String(), owner.DeviceID, owner.ConnectionID, room.SupportRef.String(), expires.Format(time.RFC3339Nano), expires.UnixMilli(), int((groupRoomActiveTTL + groupRoomEndedTTL).Seconds()), int(groupRoomRingingTTL.Seconds()), admissionToken, int((groupRoomActiveTTL + groupRoomEndedTTL).Seconds()), ringExpires.Format(time.RFC3339Nano)).Int()
	if err != nil {
		return application.GroupRoom{}, err
	}
	if result != 1 {
		return application.GroupRoom{}, callResultError(result)
	}
	return c.groupRoom(ctx, room.ID)
}

// CancelGroupRoomStart treats the opaque attempt ID as a capability, while
// additionally binding recovery to the authenticated user and device.
func (c *PresenceCoordinator) CancelGroupRoomStart(ctx context.Context, conversationID uuid.UUID, owner application.GroupParticipant, attemptID uuid.UUID) (application.GroupRoom, string, error) {
	if conversationID == uuid.Nil || attemptID == uuid.Nil || owner.UserID == uuid.Nil || owner.DeviceID == "" || owner.ConnectionID == "" {
		return application.GroupRoom{}, "", application.ErrCallNotAllowed
	}
	result, err := c.client.Eval(ctx, cancelGroupStartScript, []string{groupStartAttemptKey(attemptID), groupRoomConversationKey(conversationID), groupRoomUserKey(owner.UserID)}, conversationID.String(), owner.UserID.String(), owner.DeviceID, int(groupRoomEndedTTL.Seconds()), int(groupStartAttemptTTL.Seconds())).StringSlice()
	if err != nil {
		return application.GroupRoom{}, "", err
	}
	if len(result) != 2 || result[0] == "denied" {
		return application.GroupRoom{}, "", application.ErrCallNotAllowed
	}
	if result[0] == "confirmed" || result[0] == "unknown" {
		return application.GroupRoom{}, result[0], nil
	}
	if result[0] != "retired" {
		return application.GroupRoom{}, "", application.ErrCallUnavailable
	}
	id, err := uuid.Parse(result[1])
	if err != nil {
		return application.GroupRoom{}, "", application.ErrCallUnavailable
	}
	room, err := c.groupRoom(ctx, id)
	return room, "retired", err
}

const prepareGroupStartScript = `if redis.call('EXISTS', KEYS[1]) ~= 0 then return 0 end
local now = redis.call('TIME'); local ms = now[1] * 1000 + math.floor(now[2] / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ms)
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[6]) then return 0 end
redis.call('HSET', KEYS[1], 'conversation', ARGV[1], 'user', ARGV[2], 'device', ARGV[3], 'connection', ARGV[4], 'index_key', KEYS[2], 'state', 'prepared')
local deadline = ms + ARGV[5] * 1000
redis.call('PEXPIREAT', KEYS[1], deadline); redis.call('ZADD', KEYS[2], deadline, KEYS[1]); redis.call('PEXPIREAT', KEYS[2], deadline); return deadline`

const disconnectGroupAttemptsScript = `for _, key in ipairs(redis.call('ZRANGE', KEYS[1], 0, -1)) do if redis.call('HGET', key, 'state') == 'prepared' then redis.call('HSET', key, 'state', 'cancelled') end end; redis.call('DEL', KEYS[1]); return 1`

const startPreparedGroupRoomScript = `
if redis.call('HGET', KEYS[5], 'state') ~= 'prepared' or redis.call('HGET', KEYS[5], 'conversation') ~= ARGV[2] or redis.call('HGET', KEYS[5], 'user') ~= ARGV[5] or redis.call('HGET', KEYS[5], 'device') ~= ARGV[6] or redis.call('HGET', KEYS[5], 'connection') ~= ARGV[7] then return 3 end
if ARGV[13] == '' or redis.call('GET', 'zwei:call:admission:' .. ARGV[5]) ~= ARGV[13] then return 4 end
if redis.call('EXISTS', KEYS[1]) == 1 then return 6 end
if redis.call('EXISTS', KEYS[2]) == 1 or redis.call('EXISTS', KEYS[3]) == 1 or redis.call('EXISTS', 'zwei:call:user:' .. ARGV[5]) == 1 then return 4 end
-- Reserve the conversation before creating a room: a partial script error
-- must leave a detectable reservation rather than an unindexed live room.
redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[11])
redis.call('SET', KEYS[3], ARGV[1], 'EX', ARGV[11])
local participant = cjson.encode({{user_id=ARGV[5], device_id=ARGV[6]}})
redis.call('HSET', KEYS[1], 'conversation_id', ARGV[2], 'membership_revision', ARGV[3], 'generation', ARGV[4], 'state_revision', 1, 'status', 'ringing', 'expires_at', ARGV[9], 'expires_at_unix_ms', ARGV[10], 'ring_expires_at', ARGV[15], 'participants', participant, 'connections', ARGV[5] .. '|' .. ARGV[6] .. '|' .. ARGV[7], 'support_ref', ARGV[8], 'start_attempt_key', KEYS[5], 'starter_user', ARGV[5], 'starter_device', ARGV[6])
-- A script error cannot roll back HSET. Keep a bounded fallback until the
-- expiry sweeper can see this room, then retain it for terminal fan-out.
redis.call('EXPIRE', KEYS[1], ARGV[11]); redis.call('ZADD', KEYS[4], ARGV[10], ARGV[1]); redis.call('PERSIST', KEYS[1])
redis.call('HSET', KEYS[5], 'state', 'started', 'room', ARGV[1]); redis.call('ZREM', KEYS[6], KEYS[5]); redis.call('EXPIRE', KEYS[5], ARGV[14]); return 1`

const cancelGroupStartScript = `
local exists = redis.call('EXISTS', KEYS[1]) == 1
local state = exists and redis.call('HGET', KEYS[1], 'state') or ''
-- Missing state cannot prove that the caller possessed an issued permit, or
-- that a reservation was not lost. Fail closed until a signed deadline exists.
if not exists and redis.call('EXISTS', KEYS[2]) == 0 then return {'unknown', ''} end
if exists and (redis.call('HGET', KEYS[1], 'conversation') ~= ARGV[1] or redis.call('HGET', KEYS[1], 'user') ~= ARGV[2] or redis.call('HGET', KEYS[1], 'device') ~= ARGV[3]) then return {'denied', ''} end
if state == 'prepared' then
  local index = redis.call('HGET', KEYS[1], 'index_key'); if not index then return {'unknown', ''} end
  redis.call('HSET', KEYS[1], 'state', 'cancelled'); redis.call('ZREM', index, KEYS[1])
  local indexed = redis.call('GET', KEYS[2]); if not indexed then return {'confirmed', ''} end
  local indexedKey = 'zwei:group-call:room:' .. indexed
  if redis.call('HGET', indexedKey, 'start_attempt_key') ~= KEYS[1] then return {'unknown', ''} end
  redis.call('HSET', KEYS[1], 'room', indexed); state = 'cancelled'
end
if state == 'cancelled' and not redis.call('HGET', KEYS[1], 'room') then if redis.call('EXISTS', KEYS[2]) == 1 then return {'unknown', ''} end; return {'confirmed', ''} end
if exists and state ~= 'started' and state ~= 'cancelled' then return {'unknown', ''} end
local roomID = exists and redis.call('HGET', KEYS[1], 'room') or redis.call('GET', KEYS[2])
if not roomID then return {'unknown', ''} end
local roomKey = 'zwei:group-call:room:' .. roomID
if redis.call('EXISTS', roomKey) == 0 or redis.call('HGET', roomKey, 'conversation_id') ~= ARGV[1] or redis.call('HGET', roomKey, 'start_attempt_key') ~= KEYS[1] or redis.call('HGET', roomKey, 'starter_user') ~= ARGV[2] or redis.call('HGET', roomKey, 'starter_device') ~= ARGV[3] then return {'unknown', ''} end
local status = redis.call('HGET', roomKey, 'status')
if status == 'ended' then if state == 'cancelled' then return {'retired', roomID} end; if not exists then return {'unknown', ''} end; return {'confirmed', ''} end
if status ~= 'ringing' and status ~= 'active' then return {'unknown', ''} end
if redis.call('GET', KEYS[2]) ~= roomID then return {'unknown', ''} end
if exists then redis.call('HSET', KEYS[1], 'state', 'cancelled') end
local connections = redis.call('HGET', roomKey, 'connections') or ''
local participants = cjson.decode(redis.call('HGET', roomKey, 'participants'))
for _, p in ipairs(participants) do local k = 'zwei:group-call:user:' .. p.user_id; if redis.call('GET', k) == roomID then redis.call('DEL', k) end end
local conversationKey = 'zwei:group-call:conversation:' .. ARGV[1]
if redis.call('GET', conversationKey) == roomID then redis.call('DEL', conversationKey) end
redis.call('HINCRBY', roomKey, 'state_revision', 1)
redis.call('HSET', roomKey, 'ended_participants', redis.call('HGET', roomKey, 'participants'), 'ended_connections', connections, 'participants', '[]', 'connections', '', 'status', 'ended')
redis.call('HDEL', roomKey, 'presenter'); redis.call('EXPIRE', roomKey, ARGV[4])
-- Reconstruct only after an exact indexed live room was retired. The bounded
-- binding allows retries without treating partial or unrelated state as proof.
if not exists then
  redis.call('HSET', KEYS[1], 'conversation', ARGV[1], 'user', ARGV[2], 'device', ARGV[3], 'state', 'cancelled', 'room', roomID)
  redis.call('EXPIRE', KEYS[1], ARGV[4])
end
redis.call('ZREM', 'zwei:group-call:expirations', roomID)
return {'retired', roomID}`
