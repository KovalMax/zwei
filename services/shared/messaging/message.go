package messaging

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"time"

	"github.com/google/uuid"
)

// Message is the transport-neutral result of an accepted message submission.
type Message struct {
	ID              uuid.UUID   `json:"id"`
	ConversationID  uuid.UUID   `json:"conversation_id"`
	SenderID        uuid.UUID   `json:"sender_id"`
	ClientMessageID string      `json:"client_message_id"`
	Sequence        int64       `json:"sequence"`
	Body            string      `json:"body"`
	CreatedAt       time.Time   `json:"created_at"`
	Kind            string      `json:"kind"`
	ContentType     string      `json:"content_type"`
	Mentions        []Mention   `json:"mentions,omitempty"`
	RecipientID     uuid.UUID   `json:"-"`
	RecipientIDs    []uuid.UUID `json:"-"`
}

// Mention binds a UTF-16 body range to a stable conversation-member identity.
type Mention struct {
	UserID uuid.UUID `json:"user_id"`
	Start  int       `json:"start"`
	End    int       `json:"end"`
}

func (m *Mention) UnmarshalJSON(data []byte) error {
	type mentionJSON Mention
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var value mentionJSON
	if err := decoder.Decode(&value); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return fmt.Errorf("invalid mention value")
	}
	*m = Mention(value)
	return nil
}
