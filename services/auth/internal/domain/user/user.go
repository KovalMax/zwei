package user

import "github.com/google/uuid"

// User is the authentication data required to verify a login.
type User struct {
	ID             uuid.UUID
	PasswordHash   string
	SessionVersion int64
}
