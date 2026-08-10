package redis

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"
	"sync"
	"time"

	"github.com/KovalMax/zwei/services/shared/messaging"
	"github.com/google/uuid"
	redis "github.com/redis/go-redis/v9"
)

const (
	presenceChannel       = "zwei:presence"
	conversationChannel   = "zwei:conversation"
	typingChannel         = "zwei:typing"
	messageChannel        = "zwei:message"
	readChannel           = "zwei:read"
	presenceTTL           = 30 * time.Second
	websocketTicketTTL    = 30 * time.Second
	messageWindow         = time.Minute
	messageLimit          = 60
	typingStartTTL        = time.Second
	presenceRefreshWindow = time.Minute
	presenceRefreshLimit  = 30
	readWindow            = time.Minute
	readLimit             = 300
	callWindow            = time.Minute
	callLimit             = 30
	signalWindow          = time.Minute
	signalLimit           = 240
	connectionBudgetTTL   = 90 * time.Second
	connectionBudgetLimit = 8
)

type Change struct {
	UserID uuid.UUID `json:"user_id"`
	Online bool      `json:"online"`
}

type ConversationChange struct {
	ConversationID uuid.UUID   `json:"conversation_id"`
	UserIDs        []uuid.UUID `json:"user_ids"`
}

type TypingChange struct {
	ConversationID uuid.UUID `json:"conversation_id"`
	UserID         uuid.UUID `json:"user_id"`
	Started        bool      `json:"started"`
}

type MessageChange struct {
	Message     messaging.Message `json:"message"`
	RecipientID uuid.UUID         `json:"recipient_id"`
}

type ReadChange struct {
	ConversationID uuid.UUID `json:"conversation_id"`
	ReaderID       uuid.UUID `json:"reader_id"`
	RecipientID    uuid.UUID `json:"recipient_id"`
	Sequence       int64     `json:"sequence"`
}

type PresenceCoordinator struct {
	client            *redis.Client
	instanceID        string
	mu                sync.Mutex
	connections       map[string]uuid.UUID
	budgetConnections map[string]uuid.UUID
}

func NewPresenceCoordinator(rawURL string) (*PresenceCoordinator, error) {
	options, err := redis.ParseURL(rawURL)
	if err != nil {
		return nil, err
	}
	return &PresenceCoordinator{client: redis.NewClient(options), instanceID: uuid.NewString(), connections: make(map[string]uuid.UUID)}, nil
}

func (c *PresenceCoordinator) Ping(ctx context.Context) error { return c.client.Ping(ctx).Err() }
func (c *PresenceCoordinator) Close() error                   { return c.client.Close() }

// ConsumeWebSocketTicket atomically permits one upgrade for a signed ticket across all replicas.
func (c *PresenceCoordinator) ConsumeWebSocketTicket(ctx context.Context, ticket string) (bool, error) {
	return c.client.SetNX(ctx, websocketTicketKey(ticket), "1", websocketTicketTTL).Result()
}

func (c *PresenceCoordinator) AllowMessage(ctx context.Context, userID uuid.UUID) (bool, error) {
	return c.allow(ctx, messageRateKey(userID), messageWindow, messageLimit)
}

func (c *PresenceCoordinator) AllowTypingStart(ctx context.Context, userID, conversationID uuid.UUID) (bool, error) {
	return c.client.SetNX(ctx, typingRateKey(userID, conversationID), "1", typingStartTTL).Result()
}

func (c *PresenceCoordinator) AllowPresenceRefresh(ctx context.Context, userID uuid.UUID) (bool, error) {
	return c.allow(ctx, commandRateKey("presence-refresh", userID), presenceRefreshWindow, presenceRefreshLimit)
}

func (c *PresenceCoordinator) AllowRead(ctx context.Context, userID uuid.UUID) (bool, error) {
	return c.allow(ctx, commandRateKey("read", userID), readWindow, readLimit)
}

func (c *PresenceCoordinator) AllowCall(ctx context.Context, userID uuid.UUID) (bool, error) {
	return c.allow(ctx, commandRateKey("call", userID), callWindow, callLimit)
}

func (c *PresenceCoordinator) AllowSignal(ctx context.Context, userID uuid.UUID) (bool, error) {
	return c.allow(ctx, commandRateKey("signal", userID), signalWindow, signalLimit)
}

func (c *PresenceCoordinator) AllowConnection(ctx context.Context, userID uuid.UUID, connection string) (bool, error) {
	allowed, err := c.client.Eval(ctx, connectionBudgetScript, []string{connectionBudgetKey(userID)}, time.Now().Unix(), int(connectionBudgetTTL.Seconds()), connectionBudgetLimit, connection).Int()
	if err == nil && allowed == 1 {
		c.mu.Lock()
		if c.budgetConnections == nil {
			c.budgetConnections = make(map[string]uuid.UUID)
		}
		c.budgetConnections[connection] = userID
		c.mu.Unlock()
	}
	return allowed == 1, err
}

func (c *PresenceCoordinator) ReleaseConnection(ctx context.Context, userID uuid.UUID, connection string) error {
	c.mu.Lock()
	delete(c.budgetConnections, connection)
	c.mu.Unlock()
	return c.client.ZRem(ctx, connectionBudgetKey(userID), connection).Err()
}

func (c *PresenceCoordinator) Connect(ctx context.Context, userID uuid.UUID, connection string) (bool, error) {
	// Connection leases are per socket, while the returned transition is the user's global state.
	member := c.member(connection)
	c.mu.Lock()
	c.connections[member] = userID
	c.mu.Unlock()
	result, err := c.client.Eval(ctx, connectScript, []string{presenceSetKey(userID), presenceConnectionKey(userID, member)}, member, presenceTTL.Seconds()).Int()
	return result == 1, err
}

func (c *PresenceCoordinator) Disconnect(ctx context.Context, userID uuid.UUID, connection string) (bool, error) {
	member := c.member(connection)
	c.mu.Lock()
	delete(c.connections, member)
	c.mu.Unlock()
	result, err := c.client.Eval(ctx, disconnectScript, []string{presenceSetKey(userID), presenceConnectionKey(userID, member)}, member).Int()
	return result == 1, err
}

func (c *PresenceCoordinator) Online(ctx context.Context, userIDs []uuid.UUID) (map[uuid.UUID]bool, error) {
	// Online answers are user-scoped aggregates, not per-device connection status.
	pipe := c.client.Pipeline()
	commands := make([]*redis.Cmd, len(userIDs))
	for index, userID := range userIDs {
		commands[index] = pipe.Eval(ctx, countScript, []string{presenceSetKey(userID)}, "")
	}
	if _, err := pipe.Exec(ctx); err != nil {
		return nil, err
	}
	online := make(map[uuid.UUID]bool, len(userIDs))
	for index, userID := range userIDs {
		count, err := commands[index].Int()
		if err != nil {
			return nil, err
		}
		online[userID] = count > 0
	}
	return online, nil
}

func (c *PresenceCoordinator) Publish(ctx context.Context, userID uuid.UUID, online bool) error {
	payload, err := json.Marshal(Change{UserID: userID, Online: online})
	if err != nil {
		return err
	}
	return c.client.Publish(ctx, presenceChannel, payload).Err()
}

func (c *PresenceCoordinator) PublishConversation(ctx context.Context, conversationID uuid.UUID, userIDs []uuid.UUID) error {
	payload, err := json.Marshal(ConversationChange{ConversationID: conversationID, UserIDs: userIDs})
	if err != nil {
		return err
	}
	return c.client.Publish(ctx, conversationChannel, payload).Err()
}

func (c *PresenceCoordinator) PublishTyping(ctx context.Context, conversationID, userID uuid.UUID, started bool) error {
	payload, err := json.Marshal(TypingChange{ConversationID: conversationID, UserID: userID, Started: started})
	if err != nil {
		return err
	}
	return c.client.Publish(ctx, typingChannel, payload).Err()
}

func (c *PresenceCoordinator) PublishMessage(ctx context.Context, message messaging.Message) error {
	payload, err := json.Marshal(MessageChange{Message: message, RecipientID: message.RecipientID})
	if err != nil {
		return err
	}
	return c.client.Publish(ctx, messageChannel, payload).Err()
}

func (c *PresenceCoordinator) PublishRead(ctx context.Context, readerID, recipientID, conversationID uuid.UUID, sequence int64) error {
	payload, err := json.Marshal(ReadChange{ConversationID: conversationID, ReaderID: readerID, RecipientID: recipientID, Sequence: sequence})
	if err != nil {
		return err
	}
	return c.client.Publish(ctx, readChannel, payload).Err()
}

func (c *PresenceCoordinator) StartHeartbeat(ctx context.Context) {
	ticker := time.NewTicker(presenceTTL / 3)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			now := time.Now().Unix()
			c.mu.Lock()
			connections := make(map[string]uuid.UUID, len(c.connections))
			for member, userID := range c.connections {
				connections[member] = userID
			}
			budgetConnections := make(map[string]uuid.UUID, len(c.budgetConnections))
			for connection, userID := range c.budgetConnections {
				budgetConnections[connection] = userID
			}
			c.mu.Unlock()
			for member, userID := range connections {
				pipe := c.client.Pipeline()
				pipe.SAdd(ctx, presenceSetKey(userID), member)
				pipe.Set(ctx, presenceConnectionKey(userID, member), "1", presenceTTL)
				_, _ = pipe.Exec(ctx)
			}
			for connection, userID := range budgetConnections {
				pipe := c.client.Pipeline()
				pipe.ZRemRangeByScore(ctx, connectionBudgetKey(userID), "-inf", strconv.FormatInt(now, 10))
				pipe.ZAdd(ctx, connectionBudgetKey(userID), redis.Z{Score: float64(now + int64(connectionBudgetTTL.Seconds())), Member: connection})
				_, _ = pipe.Exec(ctx)
			}
		}
	}
}

func (c *PresenceCoordinator) Consume(ctx context.Context, handler func(Change)) error {
	subscription := c.client.Subscribe(ctx, presenceChannel)
	defer subscription.Close()
	if _, err := subscription.Receive(ctx); err != nil {
		return err
	}
	for {
		message, err := subscription.ReceiveMessage(ctx)
		if err != nil {
			return err
		}
		var change Change
		if json.Unmarshal([]byte(message.Payload), &change) == nil {
			handler(change)
		}
	}
}

func (c *PresenceCoordinator) ConsumeConversations(ctx context.Context, handler func(ConversationChange)) error {
	subscription := c.client.Subscribe(ctx, conversationChannel)
	defer subscription.Close()
	if _, err := subscription.Receive(ctx); err != nil {
		return err
	}
	for {
		message, err := subscription.ReceiveMessage(ctx)
		if err != nil {
			return err
		}
		var change ConversationChange
		if json.Unmarshal([]byte(message.Payload), &change) == nil {
			handler(change)
		}
	}
}

func (c *PresenceCoordinator) ConsumeTyping(ctx context.Context, handler func(TypingChange)) error {
	subscription := c.client.Subscribe(ctx, typingChannel)
	defer subscription.Close()
	if _, err := subscription.Receive(ctx); err != nil {
		return err
	}
	for {
		message, err := subscription.ReceiveMessage(ctx)
		if err != nil {
			return err
		}
		var change TypingChange
		if json.Unmarshal([]byte(message.Payload), &change) == nil {
			handler(change)
		}
	}
}

func (c *PresenceCoordinator) ConsumeMessages(ctx context.Context, handler func(MessageChange)) error {
	subscription := c.client.Subscribe(ctx, messageChannel)
	defer subscription.Close()
	if _, err := subscription.Receive(ctx); err != nil {
		return err
	}
	for {
		message, err := subscription.ReceiveMessage(ctx)
		if err != nil {
			return err
		}
		var change MessageChange
		if json.Unmarshal([]byte(message.Payload), &change) == nil {
			change.Message.RecipientID = change.RecipientID
			handler(change)
		}
	}
}

func (c *PresenceCoordinator) ConsumeReads(ctx context.Context, handler func(ReadChange)) error {
	subscription := c.client.Subscribe(ctx, readChannel)
	defer subscription.Close()
	if _, err := subscription.Receive(ctx); err != nil {
		return err
	}
	for {
		message, err := subscription.ReceiveMessage(ctx)
		if err != nil {
			return err
		}
		var change ReadChange
		if json.Unmarshal([]byte(message.Payload), &change) == nil {
			handler(change)
		}
	}
}

func (c *PresenceCoordinator) member(connection string) string {
	return c.instanceID + ":" + connection
}
func websocketTicketKey(ticket string) string {
	hash := sha256.Sum256([]byte(ticket))
	return "zwei:websocket-ticket:" + hex.EncodeToString(hash[:])
}
func messageRateKey(userID uuid.UUID) string { return "zwei:rate:message:" + userID.String() }
func commandRateKey(command string, userID uuid.UUID) string {
	return "zwei:rate:" + command + ":" + userID.String()
}
func connectionBudgetKey(userID uuid.UUID) string {
	return "zwei:websocket:connections:" + userID.String()
}
func typingRateKey(userID, conversationID uuid.UUID) string {
	return "zwei:rate:typing:" + userID.String() + ":" + conversationID.String()
}
func (c *PresenceCoordinator) allow(ctx context.Context, key string, window time.Duration, limit int) (bool, error) {
	allowed, err := c.client.Eval(ctx, rateLimitScript, []string{key}, int(window.Seconds()), limit).Int()
	return allowed == 1, err
}
func presenceSetKey(userID uuid.UUID) string { return fmt.Sprintf("zwei:presence:%s", userID) }
func presenceConnectionKey(userID uuid.UUID, member string) string {
	return fmt.Sprintf("zwei:presence:%s:%s", userID, member)
}

const connectScript = `redis.call('SET', KEYS[2], '1', 'EX', ARGV[2]); redis.call('SADD', KEYS[1], ARGV[1]); local count = 0; for _, member in ipairs(redis.call('SMEMBERS', KEYS[1])) do if redis.call('EXISTS', string.sub(KEYS[1], 1, -1) .. ':' .. member) == 1 then count = count + 1 else redis.call('SREM', KEYS[1], member) end end; if count == 1 then return 1 end; return 0`
const disconnectScript = `redis.call('DEL', KEYS[2]); redis.call('SREM', KEYS[1], ARGV[1]); local count = 0; for _, member in ipairs(redis.call('SMEMBERS', KEYS[1])) do if redis.call('EXISTS', string.sub(KEYS[1], 1, -1) .. ':' .. member) == 1 then count = count + 1 else redis.call('SREM', KEYS[1], member) end end; if count == 0 then return 1 end; return 0`
const countScript = `local count = 0; for _, member in ipairs(redis.call('SMEMBERS', KEYS[1])) do if redis.call('EXISTS', KEYS[1] .. ':' .. member) == 1 then count = count + 1 else redis.call('SREM', KEYS[1], member) end end; return count`
const rateLimitScript = `local count = redis.call('INCR', KEYS[1]); if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end; if count <= tonumber(ARGV[2]) then return 1 end; return 0`
const connectionBudgetScript = `local now = tonumber(ARGV[1]); redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now); if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then return 0 end; redis.call('ZADD', KEYS[1], now + tonumber(ARGV[2]), ARGV[4]); return 1`
