package redis

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	redis "github.com/redis/go-redis/v9"

	"github.com/KovalMax/zwei/services/chat/internal/application"
)

type policy struct {
	window time.Duration
	limit  int
}

var policies = map[string]policy{
	application.RateBucketSearch:             {window: time.Minute, limit: 60},
	application.RateBucketConversationList:   {window: time.Minute, limit: 120},
	application.RateBucketConversationCreate: {window: time.Minute, limit: 20},
	application.RateBucketConversationGet:    {window: time.Minute, limit: 120},
	application.RateBucketHistory:            {window: time.Minute, limit: 120},
	application.RateBucketMessage:            {window: time.Minute, limit: 60},
}

type RequestLimiter struct{ client *redis.Client }

func NewRequestLimiter(rawURL string) (*RequestLimiter, error) {
	options, err := redis.ParseURL(rawURL)
	if err != nil {
		return nil, err
	}
	return &RequestLimiter{client: redis.NewClient(options)}, nil
}

func (l *RequestLimiter) Ping(ctx context.Context) error { return l.client.Ping(ctx).Err() }
func (l *RequestLimiter) Close() error                   { return l.client.Close() }

func (l *RequestLimiter) Allow(ctx context.Context, userID uuid.UUID, bucket string) (bool, error) {
	config, ok := policies[bucket]
	if !ok {
		return false, errors.New("unknown chat rate-limit bucket")
	}
	return l.allow(ctx, "zwei:rate:chat:"+bucket+":"+userID.String(), config.window, config.limit)
}

func (l *RequestLimiter) allow(ctx context.Context, key string, window time.Duration, limit int) (bool, error) {
	allowed, err := l.client.Eval(ctx, rateLimitScript, []string{key}, int(window.Seconds()), limit).Int()
	return allowed == 1, err
}

const rateLimitScript = `local count = redis.call('INCR', KEYS[1]); if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end; if count <= tonumber(ARGV[2]) then return 1 end; return 0`

var _ application.RequestLimiter = (*RequestLimiter)(nil)
