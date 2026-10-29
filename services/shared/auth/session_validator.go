package auth

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

var ErrSessionInvalid = errors.New("invalid or revoked session")

type sessionVersionReader interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

// SessionValidator verifies that a signed identity belongs to the current session version.
type SessionValidator struct {
	reader sessionVersionReader
	secret []byte
}

func NewSessionValidator(reader sessionVersionReader, secret []byte) *SessionValidator {
	return &SessionValidator{reader: reader, secret: secret}
}

func (v *SessionValidator) AuthenticateBearer(ctx context.Context, authorization string) (Identity, error) {
	identity, err := ParseBearerHeader(authorization, v.secret)
	if err != nil {
		return Identity{}, err
	}
	return identity, v.Validate(ctx, identity, false)
}

func (v *SessionValidator) AuthenticateWebSocketTicket(ctx context.Context, ticket string) (Identity, error) {
	identity, err := ParseWebSocketTicket(ticket, v.secret)
	if err != nil {
		return Identity{}, err
	}
	return identity, v.Validate(ctx, identity, true)
}

func (v *SessionValidator) Validate(ctx context.Context, identity Identity, requireDevice bool) error {
	if identity.UserID == uuid.Nil || (requireDevice && identity.DeviceID == "") {
		return ErrSessionInvalid
	}
	if identity.BrowserID == uuid.Nil || identity.BrowserGeneration == uuid.Nil {
		return ErrSessionInvalid
	}
	var active bool
	err := v.reader.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM users u JOIN browser_auth_heads h ON h.user_id = u.id WHERE u.id = $1 AND u.session_version = $2 AND h.browser_id = $3 AND h.generation = $4 AND h.current_refresh_hash IS NOT NULL)`, identity.UserID, identity.SessionVersion, identity.BrowserID, identity.BrowserGeneration).Scan(&active)
	if err != nil || !active {
		return ErrSessionInvalid
	}
	return nil
}
