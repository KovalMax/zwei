package websockettransport

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5"

	"github.com/KovalMax/zwei/services/realtime/internal/application"
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

func TestServeHTTPRejectsInvalidExpiredAndWrongPurposeTickets(t *testing.T) {
	secret := []byte("01234567890123456789012345678901")
	tests := []struct {
		name   string
		ticket string
	}{
		{name: "invalid", ticket: "not-a-ticket"},
		{name: "expired", ticket: signedTicket(t, secret, "websocket", time.Now().Add(-time.Minute))},
		{name: "wrong purpose", ticket: signedTicket(t, secret, "access", time.Now().Add(time.Minute))},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			consumer := &networkTicketConsumer{allow: true}
			handler := newNetworkHandler(secret, consumer)
			server := httptest.NewServer(handler)
			defer server.Close()

			response, err := http.Get(server.URL + "?ticket=" + url.QueryEscape(test.ticket))
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			if response.StatusCode != http.StatusUnauthorized {
				t.Fatalf("status = %d, want %d", response.StatusCode, http.StatusUnauthorized)
			}
			if consumer.consumeCalls != 0 {
				t.Fatalf("ticket consumer calls = %d, want 0", consumer.consumeCalls)
			}
		})
	}
}

func TestServeHTTPRejectsUntrustedOriginAndReleasesConnectionBudget(t *testing.T) {
	secret := []byte("01234567890123456789012345678901")
	consumer := &networkTicketConsumer{allow: true}
	handler := newNetworkHandler(secret, consumer)
	server := httptest.NewServer(handler)
	defer server.Close()

	dialer := websocket.Dialer{HandshakeTimeout: time.Second}
	conn, response, err := dialer.Dial(websocketURL(server.URL, signedTicket(t, secret, "websocket", time.Now().Add(time.Minute))), http.Header{"Origin": []string{"https://untrusted.example"}})
	if conn != nil {
		conn.Close()
	}
	if err == nil {
		t.Fatal("untrusted origin unexpectedly upgraded")
	}
	if response == nil || response.StatusCode != http.StatusForbidden {
		if response == nil {
			t.Fatalf("handshake response is nil: %v", err)
		}
		t.Fatalf("status = %d, want %d", response.StatusCode, http.StatusForbidden)
	}
	response.Body.Close()
	if consumer.releaseCalls != 1 {
		t.Fatalf("released connections = %d, want 1", consumer.releaseCalls)
	}
}

func TestServeHTTPRejectsConnectionBudgetOverflow(t *testing.T) {
	secret := []byte("01234567890123456789012345678901")
	consumer := &networkTicketConsumer{allow: false}
	handler := newNetworkHandler(secret, consumer)
	server := httptest.NewServer(handler)
	defer server.Close()

	dialer := websocket.Dialer{HandshakeTimeout: time.Second}
	conn, response, err := dialer.Dial(websocketURL(server.URL, signedTicket(t, secret, "websocket", time.Now().Add(time.Minute))), http.Header{"Origin": []string{"https://chat.localhost"}})
	if conn != nil {
		conn.Close()
	}
	if err == nil {
		t.Fatal("connection budget overflow unexpectedly upgraded")
	}
	if response == nil || response.StatusCode != http.StatusTooManyRequests {
		if response == nil {
			t.Fatalf("handshake response is nil: %v", err)
		}
		t.Fatalf("status = %d, want %d", response.StatusCode, http.StatusTooManyRequests)
	}
	response.Body.Close()
	if response.Header.Get("Retry-After") != "60" {
		t.Fatalf("Retry-After = %q, want 60", response.Header.Get("Retry-After"))
	}
	if consumer.releaseCalls != 0 {
		t.Fatalf("released connections = %d, want 0", consumer.releaseCalls)
	}
}

func TestServeHTTPClosesConnectionForInvalidBinaryAndOversizedFrames(t *testing.T) {
	tests := []struct {
		name        string
		messageType int
		payload     []byte
		closeCode   int
	}{
		{name: "binary", messageType: websocket.BinaryMessage, payload: []byte(`{"version":1}`), closeCode: websocket.CloseUnsupportedData},
		{name: "invalid json", messageType: websocket.TextMessage, payload: []byte("{"), closeCode: websocket.CloseUnsupportedData},
		{name: "oversized", messageType: websocket.TextMessage, payload: bytes.Repeat([]byte("x"), maxFrameSize+1), closeCode: websocket.CloseMessageTooBig},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			secret := []byte("01234567890123456789012345678901")
			consumer := &networkTicketConsumer{allow: true}
			handler := newNetworkHandler(secret, consumer)
			server := httptest.NewServer(handler)
			defer server.Close()

			dialer := websocket.Dialer{HandshakeTimeout: time.Second}
			conn, response, err := dialer.Dial(websocketURL(server.URL, signedTicket(t, secret, "websocket", time.Now().Add(time.Minute))), http.Header{"Origin": []string{"https://chat.localhost"}})
			if err != nil {
				if response != nil {
					response.Body.Close()
				}
				t.Fatal(err)
			}
			defer conn.Close()
			conn.SetReadDeadline(time.Now().Add(2 * time.Second))
			if _, _, err := conn.ReadMessage(); err != nil {
				t.Fatalf("read presence snapshot: %v", err)
			}

			if err := conn.WriteMessage(test.messageType, test.payload); err != nil {
				t.Fatal(err)
			}
			_, _, err = conn.ReadMessage()
			var closeError *websocket.CloseError
			if !errors.As(err, &closeError) {
				t.Fatalf("read close error = %v", err)
			}
			if closeError.Code != test.closeCode {
				t.Fatalf("close code = %d, want %d", closeError.Code, test.closeCode)
			}
		})
	}
}

func newNetworkHandler(secret []byte, consumer *networkTicketConsumer) *Handler {
	return NewHandler(
		context.Background(),
		application.NewHub(nil, nil, nil, nil, nil, nil, nil),
		sharedauth.NewSessionValidator(sessionVersionReader{version: 3}, secret),
		consumer,
		map[string]struct{}{"https://chat.localhost": {}},
	)
}

func signedTicket(t *testing.T, secret []byte, purpose string, expiresAt time.Time) string {
	t.Helper()
	ticket, err := jwt.NewWithClaims(jwt.SigningMethodHS256, sharedauth.Claims{
		SessionVersion: 3,
		DeviceID:       "browser-device",
		Purpose:        purpose,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   uuid.NewString(),
			ExpiresAt: jwt.NewNumericDate(expiresAt),
		},
	}).SignedString(secret)
	if err != nil {
		t.Fatal(err)
	}
	return ticket
}

func websocketURL(rawServerURL, ticket string) string {
	return "ws" + rawServerURL[len("http"):] + "?ticket=" + url.QueryEscape(ticket)
}

type networkTicketConsumer struct {
	consumeCalls int
	allow        bool
	releaseCalls int
}

func (c *networkTicketConsumer) ConsumeWebSocketTicket(context.Context, string) (bool, error) {
	c.consumeCalls++
	return true, nil
}

func (c *networkTicketConsumer) AllowConnection(context.Context, uuid.UUID, string) (bool, error) {
	return c.allow, nil
}

func (c *networkTicketConsumer) ReleaseConnection(context.Context, uuid.UUID, string) error {
	c.releaseCalls++
	return nil
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
