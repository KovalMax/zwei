package conversation

import (
	"time"

	"github.com/google/uuid"
)

type Message struct {
	ID              uuid.UUID `json:"id"`
	ConversationID  uuid.UUID `json:"conversation_id"`
	SenderID        uuid.UUID `json:"sender_id"`
	ClientMessageID string    `json:"client_message_id"`
	Sequence        int64     `json:"sequence"`
	Body            string    `json:"body"`
	CreatedAt       time.Time `json:"created_at"`
	Kind            string    `json:"kind"`
	ContentType     string    `json:"content_type"`
	Mentions        []Mention `json:"mentions,omitempty"`
}

type Mention struct {
	UserID uuid.UUID `json:"user_id"`
	Start  int       `json:"start"`
	End    int       `json:"end"`
}
