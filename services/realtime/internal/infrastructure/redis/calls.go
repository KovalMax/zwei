package redis

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"
	redis "github.com/redis/go-redis/v9"

	"github.com/KovalMax/zwei/services/realtime/internal/application"
)

const (
	callChannel   = "zwei:call"
	callRingTTL   = 30 * time.Second
	callActiveTTL = 2 * time.Hour
	callEndedTTL  = time.Minute
)

func (c *PresenceCoordinator) Start(ctx context.Context, call application.Call) (application.Call, error) {
	expiresAt := time.Now().Add(callRingTTL).UTC()
	result, err := c.client.Eval(ctx, startCallScript, []string{callKey(call.ID), callUserKey(call.CallerID), callUserKey(call.RecipientID), callExpiryKey()}, call.ID.String(), call.ConversationID.String(), call.CallerID.String(), call.RecipientID.String(), call.CallerDeviceID, expiresAt.Format(time.RFC3339Nano), expiresAt.UnixMilli(), time.Now().UTC().Format(time.RFC3339Nano)).Int()
	if err != nil {
		return application.Call{}, err
	}
	if result != 1 {
		return application.Call{}, callResultError(result)
	}
	return c.call(ctx, call.ID)
}

func (c *PresenceCoordinator) Accept(ctx context.Context, callID, userID uuid.UUID, deviceID string) (application.Call, error) {
	return c.transitionCall(ctx, acceptCallScript, callID, userID, deviceID)
}
func (c *PresenceCoordinator) Decline(ctx context.Context, callID, userID uuid.UUID, deviceID string) (application.Call, error) {
	return c.transitionCall(ctx, declineCallScript, callID, userID, deviceID)
}
func (c *PresenceCoordinator) Cancel(ctx context.Context, callID, userID uuid.UUID, deviceID string) (application.Call, error) {
	return c.transitionCall(ctx, cancelCallScript, callID, userID, deviceID)
}
func (c *PresenceCoordinator) End(ctx context.Context, callID, userID uuid.UUID, deviceID string) (application.Call, error) {
	return c.transitionCall(ctx, endCallScript, callID, userID, deviceID)
}

func (c *PresenceCoordinator) transitionCall(ctx context.Context, script string, callID, userID uuid.UUID, deviceID string) (application.Call, error) {
	activeUntil := time.Now().Add(callActiveTTL).UTC()
	result, err := c.client.Eval(ctx, script, []string{callKey(callID), callUserKey(userID), callExpiryKey()}, userID.String(), deviceID, activeUntil.Format(time.RFC3339Nano), activeUntil.UnixMilli(), int(callActiveTTL.Seconds()), int(callEndedTTL.Seconds()), time.Now().UTC().Format(time.RFC3339Nano)).Int()
	if err != nil {
		return application.Call{}, err
	}
	if result != 1 {
		return application.Call{}, callResultError(result)
	}
	return c.call(ctx, callID)
}

func (c *PresenceCoordinator) EndByDevice(ctx context.Context, userID uuid.UUID, deviceID string) ([]application.Call, error) {
	callID, err := c.client.Get(ctx, callDeviceKey(userID, deviceID)).Result()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	id, err := uuid.Parse(callID)
	if err != nil {
		return nil, nil
	}
	call, err := c.End(ctx, id, userID, deviceID)
	if err == application.ErrCallNotFound || err == application.ErrCallNotAllowed {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return []application.Call{call}, nil
}

func (c *PresenceCoordinator) Get(ctx context.Context, callID uuid.UUID) (application.Call, error) {
	return c.call(ctx, callID)
}

func (c *PresenceCoordinator) call(ctx context.Context, callID uuid.UUID) (application.Call, error) {
	values, err := c.client.HGetAll(ctx, callKey(callID)).Result()
	if err != nil {
		return application.Call{}, err
	}
	if len(values) == 0 {
		return application.Call{}, application.ErrCallNotFound
	}
	conversationID, err := uuid.Parse(values["conversation_id"])
	if err != nil {
		return application.Call{}, application.ErrCallNotFound
	}
	callerID, err := uuid.Parse(values["caller_id"])
	if err != nil {
		return application.Call{}, application.ErrCallNotFound
	}
	recipientID, err := uuid.Parse(values["recipient_id"])
	if err != nil {
		return application.Call{}, application.ErrCallNotFound
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, values["expires_at"])
	if err != nil {
		return application.Call{}, application.ErrCallNotFound
	}
	return application.Call{ID: callID, ConversationID: conversationID, CallerID: callerID, RecipientID: recipientID, CallerDeviceID: values["caller_device_id"], AcceptedDeviceID: values["accepted_device_id"], Status: values["status"], ExpiresAt: expiresAt}, nil
}

func (c *PresenceCoordinator) PublishCall(ctx context.Context, change application.CallChange) error {
	change.Source = c.instanceID
	payload, err := json.Marshal(change)
	if err != nil {
		return err
	}
	return c.client.Publish(ctx, callChannel, payload).Err()
}

func (c *PresenceCoordinator) ConsumeCalls(ctx context.Context, handler func(application.CallChange)) error {
	subscription := c.client.Subscribe(ctx, callChannel)
	defer subscription.Close()
	if _, err := subscription.Receive(ctx); err != nil {
		return err
	}
	for {
		message, err := subscription.ReceiveMessage(ctx)
		if err != nil {
			return err
		}
		var change application.CallChange
		if json.Unmarshal([]byte(message.Payload), &change) == nil && change.Source != c.instanceID {
			handler(change)
		}
	}
}

func (c *PresenceCoordinator) ExpireCalls(ctx context.Context) ([]application.Call, error) {
	now := time.Now().UnixMilli()
	ids, err := c.client.Eval(ctx, expireCallsScript, []string{callExpiryKey()}, now).StringSlice()
	if err != nil {
		return nil, err
	}
	calls := make([]application.Call, 0, len(ids))
	for _, rawID := range ids {
		callID, err := uuid.Parse(rawID)
		if err != nil {
			continue
		}
		call, err := c.call(ctx, callID)
		if err == nil {
			calls = append(calls, call)
		}
	}
	return calls, nil
}

func callResultError(result int) error {
	switch result {
	case 2:
		return application.ErrCallNotFound
	case 3:
		return application.ErrCallNotAllowed
	case 4:
		return application.ErrCallBusy
	case 5:
		return application.ErrCallTaken
	default:
		return application.ErrCallUnavailable
	}
}

func callKey(callID uuid.UUID) string     { return "zwei:call:" + callID.String() }
func callUserKey(userID uuid.UUID) string { return "zwei:call:user:" + userID.String() }
func callDeviceKey(userID uuid.UUID, deviceID string) string {
	return "zwei:call:device:" + userID.String() + ":" + deviceID
}
func callExpiryKey() string { return "zwei:calls:expires" }

// All state transitions use Redis scripts so no replica can observe two winners for a user or acceptance.
const startCallScript = `local function deviceOnline(userID, deviceID) if not deviceID then return false end; local presenceKey = 'zwei:presence:' .. userID; local suffix = ':' .. deviceID; for _, member in ipairs(redis.call('SMEMBERS', presenceKey)) do if string.sub(member, -string.len(suffix)) == suffix then if redis.call('EXISTS', presenceKey .. ':' .. member) == 1 then return true end; redis.call('SREM', presenceKey, member) end end; return false end; local function removeIfMatches(key, id) if redis.call('GET', key) == id then redis.call('DEL', key) end end; local function recoverStaleCall(id) local key = 'zwei:call:' .. id; if redis.call('EXISTS', key) == 0 then removeIfMatches(KEYS[2], id); removeIfMatches(KEYS[3], id); return true end; local status = redis.call('HGET', key, 'status'); local stale = status ~= 'active' and status ~= 'ringing'; local caller = redis.call('HGET', key, 'caller_id'); local recipient = redis.call('HGET', key, 'recipient_id'); local callerDevice = redis.call('HGET', key, 'caller_device_id'); local acceptedDevice = redis.call('HGET', key, 'accepted_device_id'); if status == 'active' and (not caller or not recipient or not deviceOnline(caller, callerDevice) or not deviceOnline(recipient, acceptedDevice)) then stale = true end; if status == 'ringing' and (not caller or not deviceOnline(caller, callerDevice)) then stale = true end; if not stale then return false end; redis.call('HSET', key, 'status', 'ended'); redis.call('EXPIRE', key, 60); removeIfMatches('zwei:call:user:' .. (caller or ''), id); removeIfMatches('zwei:call:user:' .. (recipient or ''), id); if caller and callerDevice then removeIfMatches('zwei:call:device:' .. caller .. ':' .. callerDevice, id) end; if recipient and acceptedDevice then removeIfMatches('zwei:call:device:' .. recipient .. ':' .. acceptedDevice, id) end; redis.call('ZREM', KEYS[4], id); return true end; if redis.call('EXISTS', KEYS[2]) == 1 or redis.call('EXISTS', KEYS[3]) == 1 then local existing = redis.call('GET', KEYS[2]); if not existing then existing = redis.call('GET', KEYS[3]) end; recoverStaleCall(existing) end; if redis.call('EXISTS', KEYS[2]) == 1 or redis.call('EXISTS', KEYS[3]) == 1 then return 4 end; redis.call('HSET', KEYS[1], 'conversation_id', ARGV[2], 'caller_id', ARGV[3], 'recipient_id', ARGV[4], 'caller_device_id', ARGV[5], 'status', 'ringing', 'expires_at', ARGV[6]); redis.call('EXPIRE', KEYS[1], 60); redis.call('SET', KEYS[2], ARGV[1], 'EX', 30); redis.call('SET', KEYS[3], ARGV[1], 'EX', 30); redis.call('SET', 'zwei:call:device:' .. ARGV[3] .. ':' .. ARGV[5], ARGV[1], 'EX', 30); redis.call('ZADD', KEYS[4], ARGV[7], ARGV[1]); return 1`
const acceptCallScript = `if redis.call('EXISTS', KEYS[1]) == 0 then return 2 end; if redis.call('HGET', KEYS[1], 'status') ~= 'ringing' or redis.call('HGET', KEYS[1], 'expires_at') <= ARGV[7] then return 5 end; if redis.call('HGET', KEYS[1], 'recipient_id') ~= ARGV[1] then return 3 end; local id = string.sub(KEYS[1], 11); local caller = redis.call('HGET', KEYS[1], 'caller_id'); local callerDevice = redis.call('HGET', KEYS[1], 'caller_device_id'); redis.call('HSET', KEYS[1], 'accepted_device_id', ARGV[2], 'status', 'active', 'expires_at', ARGV[3]); redis.call('EXPIRE', KEYS[1], ARGV[5]); redis.call('SET', 'zwei:call:user:' .. caller, id, 'EX', ARGV[5]); redis.call('SET', KEYS[2], id, 'EX', ARGV[5]); redis.call('SET', 'zwei:call:device:' .. caller .. ':' .. callerDevice, id, 'EX', ARGV[5]); redis.call('SET', 'zwei:call:device:' .. ARGV[1] .. ':' .. ARGV[2], id, 'EX', ARGV[5]); redis.call('ZADD', KEYS[3], ARGV[4], id); return 1`
const declineCallScript = `if redis.call('EXISTS', KEYS[1]) == 0 then return 2 end; if redis.call('HGET', KEYS[1], 'status') ~= 'ringing' then return 5 end; if redis.call('HGET', KEYS[1], 'recipient_id') ~= ARGV[1] then return 3 end; local caller = redis.call('HGET', KEYS[1], 'caller_id'); local callerDevice = redis.call('HGET', KEYS[1], 'caller_device_id'); local id = string.sub(KEYS[1], 11); redis.call('HSET', KEYS[1], 'status', 'ended'); redis.call('EXPIRE', KEYS[1], ARGV[6]); if redis.call('GET', 'zwei:call:user:' .. caller) == id then redis.call('DEL', 'zwei:call:user:' .. caller) end; if redis.call('GET', KEYS[2]) == id then redis.call('DEL', KEYS[2]) end; if redis.call('GET', 'zwei:call:device:' .. caller .. ':' .. callerDevice) == id then redis.call('DEL', 'zwei:call:device:' .. caller .. ':' .. callerDevice) end; redis.call('ZREM', KEYS[3], id); return 1`
const cancelCallScript = `if redis.call('EXISTS', KEYS[1]) == 0 then return 2 end; if redis.call('HGET', KEYS[1], 'status') ~= 'ringing' then return 5 end; if redis.call('HGET', KEYS[1], 'caller_id') ~= ARGV[1] or redis.call('HGET', KEYS[1], 'caller_device_id') ~= ARGV[2] then return 3 end; local recipient = redis.call('HGET', KEYS[1], 'recipient_id'); local id = string.sub(KEYS[1], 11); redis.call('HSET', KEYS[1], 'status', 'ended'); redis.call('EXPIRE', KEYS[1], ARGV[6]); if redis.call('GET', KEYS[2]) == id then redis.call('DEL', KEYS[2]) end; if redis.call('GET', 'zwei:call:user:' .. recipient) == id then redis.call('DEL', 'zwei:call:user:' .. recipient) end; if redis.call('GET', 'zwei:call:device:' .. ARGV[1] .. ':' .. ARGV[2]) == id then redis.call('DEL', 'zwei:call:device:' .. ARGV[1] .. ':' .. ARGV[2]) end; redis.call('ZREM', KEYS[3], id); return 1`
const endCallScript = `if redis.call('EXISTS', KEYS[1]) == 0 then return 2 end; local caller = redis.call('HGET', KEYS[1], 'caller_id'); local recipient = redis.call('HGET', KEYS[1], 'recipient_id'); local callerDevice = redis.call('HGET', KEYS[1], 'caller_device_id'); local acceptedDevice = redis.call('HGET', KEYS[1], 'accepted_device_id'); if (ARGV[1] ~= caller or ARGV[2] ~= callerDevice) and (ARGV[1] ~= recipient or ARGV[2] ~= acceptedDevice) then return 3 end; if redis.call('HGET', KEYS[1], 'status') == 'ended' then return 2 end; local id = string.sub(KEYS[1], 11); redis.call('HSET', KEYS[1], 'status', 'ended'); redis.call('EXPIRE', KEYS[1], ARGV[6]); if redis.call('GET', 'zwei:call:user:' .. caller) == id then redis.call('DEL', 'zwei:call:user:' .. caller) end; if redis.call('GET', 'zwei:call:user:' .. recipient) == id then redis.call('DEL', 'zwei:call:user:' .. recipient) end; if redis.call('GET', 'zwei:call:device:' .. caller .. ':' .. callerDevice) == id then redis.call('DEL', 'zwei:call:device:' .. caller .. ':' .. callerDevice) end; if acceptedDevice and redis.call('GET', 'zwei:call:device:' .. recipient .. ':' .. acceptedDevice) == id then redis.call('DEL', 'zwei:call:device:' .. recipient .. ':' .. acceptedDevice) end; redis.call('ZREM', KEYS[3], id); return 1`
const expireCallsScript = `local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1]); for _, id in ipairs(ids) do local key = 'zwei:call:' .. id; if redis.call('EXISTS', key) == 1 then local caller = redis.call('HGET', key, 'caller_id'); local recipient = redis.call('HGET', key, 'recipient_id'); local callerDevice = redis.call('HGET', key, 'caller_device_id'); local acceptedDevice = redis.call('HGET', key, 'accepted_device_id'); redis.call('HSET', key, 'status', 'ended'); redis.call('EXPIRE', key, 60); if redis.call('GET', 'zwei:call:user:' .. caller) == id then redis.call('DEL', 'zwei:call:user:' .. caller) end; if redis.call('GET', 'zwei:call:user:' .. recipient) == id then redis.call('DEL', 'zwei:call:user:' .. recipient) end; if redis.call('GET', 'zwei:call:device:' .. caller .. ':' .. callerDevice) == id then redis.call('DEL', 'zwei:call:device:' .. caller .. ':' .. callerDevice) end; if acceptedDevice and redis.call('GET', 'zwei:call:device:' .. recipient .. ':' .. acceptedDevice) == id then redis.call('DEL', 'zwei:call:device:' .. recipient .. ':' .. acceptedDevice) end; end; redis.call('ZREM', KEYS[1], id); end; return ids`

var _ application.CallCoordinator = (*PresenceCoordinator)(nil)
var _ application.CallConsumer = (*PresenceCoordinator)(nil)
var _ application.CallExpiryCoordinator = (*PresenceCoordinator)(nil)
