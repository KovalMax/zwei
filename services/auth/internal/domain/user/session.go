package user

import "github.com/google/uuid"

// Session identifies the account and device recovered from a refresh token.
type Session struct {
	ID             uuid.UUID
	UserID         uuid.UUID
	DeviceID       uuid.UUID
	SessionVersion int64
}
