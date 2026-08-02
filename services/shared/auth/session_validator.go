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
	var currentVersion int64
	if err := v.reader.QueryRow(ctx, `SELECT session_version FROM users WHERE id = $1`, identity.UserID).Scan(&currentVersion); err != nil || currentVersion != identity.SessionVersion {
		return ErrSessionInvalid
	}
	return nil
}
