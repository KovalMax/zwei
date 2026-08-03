package redis

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/KovalMax/zwei/services/shared/messaging"
	"github.com/google/uuid"
	redis "github.com/redis/go-redis/v9"
)

const (
	presenceChannel     = "zwei:presence"
	conversationChannel = "zwei:conversation"
	typingChannel       = "zwei:typing"
	messageChannel      = "zwei:message"
	presenceTTL         = 30 * time.Second
	websocketTicketTTL  = 30 * time.Second
	messageWindow       = time.Minute
	messageLimit        = 60
	typingStartTTL      = time.Second
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

type PresenceCoordinator struct {
	client      *redis.Client
	instanceID  string
	mu          sync.Mutex
	connections map[string]uuid.UUID
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

func (c *PresenceCoordinator) Connect(ctx context.Context, userID uuid.UUID, connection string) (bool, error) {
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

func (c *PresenceCoordinator) StartHeartbeat(ctx context.Context) {
	ticker := time.NewTicker(presenceTTL / 3)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			c.mu.Lock()
			connections := make(map[string]uuid.UUID, len(c.connections))
			for member, userID := range c.connections {
				connections[member] = userID
			}
			c.mu.Unlock()
			for member, userID := range connections {
				pipe := c.client.Pipeline()
				pipe.SAdd(ctx, presenceSetKey(userID), member)
				pipe.Set(ctx, presenceConnectionKey(userID, member), "1", presenceTTL)
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

func (c *PresenceCoordinator) member(connection string) string {
	return c.instanceID + ":" + connection
}
func websocketTicketKey(ticket string) string {
	hash := sha256.Sum256([]byte(ticket))
	return "zwei:websocket-ticket:" + hex.EncodeToString(hash[:])
}
func messageRateKey(userID uuid.UUID) string { return "zwei:rate:message:" + userID.String() }
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
