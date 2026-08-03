package websockettransport

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	sharedauth "github.com/KovalMax/zwei/services/shared/auth"
)

func TestAuthenticateConsumesWebSocketTicketOnce(t *testing.T) {
	secret := []byte("01234567890123456789012345678901")
	userID := uuid.New()
	ticket, err := jwt.NewWithClaims(jwt.SigningMethodHS256, sharedauth.Claims{
		SessionVersion: 3,
		DeviceID:       "browser-device",
		Purpose:        "websocket",
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   userID.String(),
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Minute)),
		},
	}).SignedString(secret)
	if err != nil {
		t.Fatal(err)
	}
	handler := NewHandler(context.Background(), nil, sharedauth.NewSessionValidator(sessionVersionReader{version: 3}, secret), &ticketConsumer{}, nil)
	identity, err := handler.authenticate(context.Background(), ticket)
	if err != nil {
		t.Fatalf("authenticate() error = %v", err)
	}
	if identity.UserID != userID {
		t.Fatalf("user ID = %s, want %s", identity.UserID, userID)
	}
	if _, err := handler.authenticate(context.Background(), ticket); err == nil {
		t.Fatal("reused ticket was accepted")
	}
}

type ticketConsumer struct{ used bool }

func (c *ticketConsumer) ConsumeWebSocketTicket(context.Context, string) (bool, error) {
	if c.used {
		return false, nil
	}
	c.used = true
	return true, nil
}

type sessionVersionReader struct{ version int64 }

func (r sessionVersionReader) QueryRow(context.Context, string, ...any) pgx.Row {
	return sessionVersionRow{version: r.version}
}

type sessionVersionRow struct{ version int64 }

func (r sessionVersionRow) Scan(dest ...any) error {
	if len(dest) != 1 {
		return errors.New("unexpected scan destination")
	}
	*dest[0].(*int64) = r.version
	return nil
}
