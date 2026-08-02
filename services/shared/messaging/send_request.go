package messaging

import "github.com/google/uuid"

// SendRequest contains the sender-derived and client-supplied message fields.
type SendRequest struct {
	SenderID        uuid.UUID
	ConversationID  uuid.UUID
	ClientMessageID string
	Body            string
}
