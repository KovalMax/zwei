package conversation

import (
	"time"

	"github.com/google/uuid"
)

// Conversation is the authenticated caller's view of a direct conversation.
type Conversation struct {
	ID               uuid.UUID `json:"id"`
	OtherUserID      uuid.UUID `json:"other_user_id"`
	OtherDisplayName string    `json:"other_display_name"`
	OtherEmail       string    `json:"other_email"`
	CreatedAt        time.Time `json:"created_at"`
	LastMessageAt    time.Time `json:"last_message_at"`
}
