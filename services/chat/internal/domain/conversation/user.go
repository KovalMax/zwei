package conversation

import "github.com/google/uuid"

// User is the minimal searchable profile used to start a conversation.
type User struct {
	ID          uuid.UUID `json:"id"`
	DisplayName string    `json:"display_name"`
	Email       string    `json:"email"`
}
