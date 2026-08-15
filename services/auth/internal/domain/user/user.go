package user

import (
	"time"

	"github.com/google/uuid"
)

type KYCStatus int16

const (
	KYCActive  KYCStatus = 1
	KYCPending KYCStatus = 2
	KYCBlocked KYCStatus = 3
)

func (s KYCStatus) Valid() bool {
	return s == KYCActive || s == KYCPending || s == KYCBlocked
}

// User is the authentication data required to verify a login.
type User struct {
	ID             uuid.UUID
	PasswordHash   string
	SessionVersion int64
	KYCStatus      KYCStatus
	IsAdmin        bool
	EmailVerified  bool
}

type AdminUser struct {
	ID            uuid.UUID `json:"id"`
	Email         string    `json:"email"`
	DisplayName   string    `json:"display_name"`
	KYCStatus     KYCStatus `json:"kyc_status"`
	CreatedAt     time.Time `json:"created_at"`
	EmailVerified bool      `json:"email_verified"`
}

type Invitation struct {
	ID         uuid.UUID  `json:"id"`
	Email      string     `json:"email"`
	ExpiresAt  time.Time  `json:"expires_at"`
	RedeemedAt *time.Time `json:"redeemed_at,omitempty"`
	RevokedAt  *time.Time `json:"revoked_at,omitempty"`
	CreatedAt  time.Time  `json:"created_at"`
}
