package messaging

import (
	"time"

	"github.com/google/uuid"
)

// Message is the transport-neutral result of an accepted message submission.
type Message struct {
	ID              uuid.UUID `json:"id"`
	ConversationID  uuid.UUID `json:"conversation_id"`
	SenderID        uuid.UUID `json:"sender_id"`
	ClientMessageID string    `json:"client_message_id"`
	Sequence        int64     `json:"sequence"`
	Body            string    `json:"body"`
	CreatedAt       time.Time `json:"created_at"`
	RecipientID     uuid.UUID `json:"-"`
}
