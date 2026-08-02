package application

import (
	"context"
	"time"

	"github.com/google/uuid"

	"github.com/KovalMax/zwei/services/auth/internal/domain/user"
	sharedauth "github.com/KovalMax/zwei/services/shared/auth"
)

type Repository interface {
	CreateUserWithDevice(context.Context, string, string, string, string, string) (uuid.UUID, uuid.UUID, error)
	FindUserByEmail(context.Context, string) (user.User, error)
	EnsureDevice(context.Context, uuid.UUID, string, string) (uuid.UUID, error)
	CreateSession(context.Context, uuid.UUID, uuid.UUID, []byte, int64, time.Time) error
	RotateRefreshToken(context.Context, []byte) (user.Session, error)
	RevokeAllSessions(context.Context, uuid.UUID) error
	Profile(context.Context, uuid.UUID) (user.Profile, error)
	UpdateProfile(context.Context, uuid.UUID, *string, *string) error
}

type PasswordHasher interface {
	Hash(string) (string, error)
	Compare(string, string) error
}

type TokenIssuer interface {
	IssueAccess(sharedauth.Identity, time.Duration) (string, error)
	IssueWebSocketTicket(sharedauth.Identity, time.Duration) (string, error)
}
