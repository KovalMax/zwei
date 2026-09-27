package auth

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestWebSocketTicketCannotAuthenticateAsBearer(t *testing.T) {
	secret := []byte("01234567890123456789012345678901")
	userID := uuid.New()
	ticket, err := jwt.NewWithClaims(jwt.SigningMethodHS256, Claims{
		SessionVersion: 7,
		DeviceID:       "browser-1",
		Purpose:        "websocket",
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   userID.String(),
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Minute)),
		},
	}).SignedString(secret)
	if err != nil {
		t.Fatal(err)
	}

	authorization := "Bearer " + ticket
	if _, err := ParseBearerHeader(authorization, secret); err == nil {
		t.Fatal("ParseBearerHeader accepted a purpose-bound websocket ticket")
	}

	reader := &testSessionVersionReader{version: 7}
	validator := NewSessionValidator(reader, secret)
	if _, err := validator.AuthenticateBearer(context.Background(), authorization); err == nil {
		t.Fatal("AuthenticateBearer accepted a purpose-bound websocket ticket")
	}
	if reader.calls != 0 {
		t.Fatalf("bearer authentication queried session state for a rejected token: %d queries", reader.calls)
	}

	identity, err := ParseWebSocketTicket(ticket, secret)
	if err != nil {
		t.Fatalf("ParseWebSocketTicket rejected a websocket ticket: %v", err)
	}
	if identity.UserID != userID {
		t.Fatalf("unexpected parsed identity: %+v", identity)
	}

	identity, err = validator.AuthenticateWebSocketTicket(context.Background(), ticket)
	if err != nil {
		t.Fatalf("AuthenticateWebSocketTicket rejected a valid session: %v", err)
	}
	if identity.UserID != userID || reader.calls != 1 {
		t.Fatalf("websocket ticket was not validated against session state: identity=%+v queries=%d", identity, reader.calls)
	}
}

type testSessionVersionReader struct {
	version int64
	calls   int
}

func (r *testSessionVersionReader) QueryRow(context.Context, string, ...any) pgx.Row {
	r.calls++
	return testSessionVersionRow{version: r.version}
}

type testSessionVersionRow struct{ version int64 }

func (r testSessionVersionRow) Scan(dest ...any) error {
	if len(dest) != 1 {
		return errors.New("unexpected scan destination")
	}
	version, ok := dest[0].(*int64)
	if !ok {
		return errors.New("unexpected scan destination type")
	}
	*version = r.version
	return nil
}
