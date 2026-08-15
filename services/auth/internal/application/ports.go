package application

import (
	"context"
	"time"

	"github.com/google/uuid"

	"github.com/KovalMax/zwei/services/auth/internal/domain/user"
	sharedauth "github.com/KovalMax/zwei/services/shared/auth"
)

type Repository interface {
	CreateUserWithDevice(context.Context, CreateUserParams) (uuid.UUID, uuid.UUID, error)
	FindUserByEmail(context.Context, string) (user.User, error)
	EnsureDevice(context.Context, uuid.UUID, string, string) (uuid.UUID, error)
	CreateSession(context.Context, uuid.UUID, uuid.UUID, []byte, int64, time.Time) error
	RotateRefreshToken(context.Context, []byte) (user.Session, error)
	RevokeAllSessions(context.Context, uuid.UUID) error
	Profile(context.Context, uuid.UUID) (user.Profile, error)
	UpdateProfile(context.Context, uuid.UUID, *string, *string) error
	IsAdmin(context.Context, uuid.UUID) (bool, error)
	ListAdminUsers(context.Context) ([]user.AdminUser, error)
	SetKYCStatus(context.Context, uuid.UUID, user.KYCStatus) error
	PrepareActivation(context.Context, uuid.UUID, []byte, time.Time) (string, string, bool, error)
	VerifyActivation(context.Context, []byte, time.Time) error
	CreateInvitation(context.Context, string, []byte, uuid.UUID, time.Time) (user.Invitation, error)
	ListInvitations(context.Context) ([]user.Invitation, error)
	RevokeInvitation(context.Context, uuid.UUID) error
	CreateAdmin(context.Context, string, string, string) error
}

type CreateUserParams struct {
	Email          string
	PasswordHash   string
	DisplayName    string
	ClientDeviceID string
	DeviceName     string
	KYCStatus      user.KYCStatus
	EmailVerified  bool
	InvitationCode []byte
}

type EmailSender interface {
	SendActivation(context.Context, string, string, string) error
	SendInvitation(context.Context, string, string) error
}

type PasswordHasher interface {
	Hash(string) (string, error)
	Compare(string, string) error
}

type TokenIssuer interface {
	IssueAccess(sharedauth.Identity, time.Duration) (string, error)
	IssueWebSocketTicket(sharedauth.Identity, time.Duration) (string, error)
}
