package application

import (
	"context"

	"github.com/google/uuid"
)

const (
	RateBucketSearch             = "search"
	RateBucketConversationList   = "conversation-list"
	RateBucketConversationCreate = "conversation-create"
	RateBucketConversationGet    = "conversation-get"
	RateBucketHistory            = "history"
	RateBucketMessage            = "message"
)

// RequestLimiter is the shared user-scoped admission port for chat HTTP use cases.
type RequestLimiter interface {
	Allow(context.Context, uuid.UUID, string) (bool, error)
}
