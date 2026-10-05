package websockettransport

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync/atomic"
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

func TestServeHTTPReturnsVersionTwoRejectionForRejectedGroupCall(t *testing.T) {
	secret := []byte("01234567890123456789012345678901")
	consumer := &networkTicketConsumer{allow: true}
	handler := NewVersionedHandler(
		context.Background(),
		application.NewHub(nil, nil, nil, nil, nil, nil, nil),
		sharedauth.NewSessionValidator(sessionVersionReader{version: 3}, secret),
		consumer,
		map[string]struct{}{"https://chat.localhost": {}},
		2,
	)
	server := httptest.NewServer(handler)
	defer server.Close()

	conn, response, err := (&websocket.Dialer{HandshakeTimeout: time.Second}).Dial(
		websocketURL(server.URL, signedTicket(t, secret, "websocket", time.Now().Add(time.Minute))),
		http.Header{"Origin": []string{"https://chat.localhost"}},
	)
	if err != nil {
		if response != nil {
			response.Body.Close()
		}
		t.Fatalf("websocket upgrade: %v", err)
	}
	defer conn.Close()
	conn.SetReadDeadline(time.Now().Add(time.Second))
	if _, _, err := conn.ReadMessage(); err != nil { // initial presence snapshot
		t.Fatalf("read initial event: %v", err)
	}
	command := []byte(`{"version":2,"type":"group.call.start","request_id":"group-start-v2","payload":{"conversation_id":"` + uuid.NewString() + `"}}`)
	if err := conn.WriteMessage(websocket.TextMessage, command); err != nil {
		t.Fatal(err)
	}
	_, payload, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read rejected command event: %v", err)
	}
	var rejection struct {
		Version   int    `json:"version"`
		Type      string `json:"type"`
		RequestID string `json:"request_id"`
	}
	if err := json.Unmarshal(payload, &rejection); err != nil {
		t.Fatalf("decode rejection: %v", err)
	}
	if rejection.Version != 2 || rejection.Type != "call.rejected" || rejection.RequestID != "group-start-v2" {
		t.Fatalf("rejection = %+v, want v2 call.rejected for request group-start-v2", rejection)
	}
}

func TestServeHTTPRejectsScreenShareSignalsWithExtraWebRTCFields(t *testing.T) {
	const sdpValue = "must-not-echo-sdp-secret"
	const candidateValue = "must-not-echo-candidate-secret"
	tests := []struct {
		name     string
		protocol int
		command  string
		request  string
	}{
		{
			name:     "v1 direct call",
			protocol: 1,
			request:  "direct-screen-share-v1",
			command:  `{"version":1,"type":"call.signal","request_id":"direct-screen-share-v1","payload":{"call_id":"` + uuid.NewString() + `","signal":{"type":"screen-share-started","sdp":"` + sdpValue + `","candidate":{"candidate":"` + candidateValue + `"}}}}`,
		},
		{
			name:     "v2 group call",
			protocol: 2,
			request:  "group-screen-share-v2",
			command:  `{"version":2,"type":"group.call.signal","request_id":"group-screen-share-v2","payload":{"conversation_id":"` + uuid.NewString() + `","room_id":"` + uuid.NewString() + `","generation":1,"target_user_id":"` + uuid.NewString() + `","target_device_id":"peer-device","signal":{"type":"screen-share-stopped","sdp":"` + sdpValue + `","candidate":{"candidate":"` + candidateValue + `"}}}}`,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			secret := []byte("01234567890123456789012345678901")
			consumer := &networkTicketConsumer{allow: true}
			hub := application.NewHub(nil, nil, nil, nil, nil, nil, nil)
			handler := NewVersionedHandler(
				context.Background(), hub,
				sharedauth.NewSessionValidator(sessionVersionReader{version: 3}, secret),
				consumer,
				map[string]struct{}{"https://chat.localhost": {}},
				test.protocol,
			)
			server := httptest.NewServer(handler)
			defer server.Close()

			var logs bytes.Buffer
			previousLogger := slog.Default()
			slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
			t.Cleanup(func() { slog.SetDefault(previousLogger) })

			conn, response, err := (&websocket.Dialer{HandshakeTimeout: time.Second}).Dial(
				websocketURL(server.URL, signedTicket(t, secret, "websocket", time.Now().Add(time.Minute))),
				http.Header{"Origin": []string{"https://chat.localhost"}},
			)
			if err != nil {
				if response != nil {
					response.Body.Close()
				}
				t.Fatalf("websocket upgrade: %v", err)
			}
			defer conn.Close()
			if err := conn.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
				t.Fatal(err)
			}
			if _, _, err := conn.ReadMessage(); err != nil { // initial presence snapshot
				t.Fatalf("read initial event: %v", err)
			}
			if err := conn.WriteMessage(websocket.TextMessage, []byte(test.command)); err != nil {
				t.Fatal(err)
			}
			_, event, err := conn.ReadMessage()
			if err != nil {
				t.Fatalf("read rejection: %v", err)
			}

			var rejection struct {
				Version   int             `json:"version"`
				Type      string          `json:"type"`
				RequestID string          `json:"request_id"`
				Payload   json.RawMessage `json:"payload"`
			}
			if err := json.Unmarshal(event, &rejection); err != nil {
				t.Fatalf("decode rejection: %v", err)
			}
			if rejection.Version != test.protocol || rejection.Type != "call.rejected" || rejection.RequestID != test.request {
				t.Fatalf("rejection = %+v, want correlated call.rejected at protocol %d", rejection, test.protocol)
			}
			if bytes.Contains(event, []byte(sdpValue)) || bytes.Contains(event, []byte(candidateValue)) || bytes.Contains(logs.Bytes(), []byte(sdpValue)) || bytes.Contains(logs.Bytes(), []byte(candidateValue)) {
				t.Fatalf("signal data was echoed or logged; event=%s logs=%s", event, logs.String())
			}
			var publicPayload map[string]any
			if err := json.Unmarshal(rejection.Payload, &publicPayload); err != nil {
				t.Fatalf("decode public rejection payload: %v", err)
			}
			if _, hasSignal := publicPayload["signal"]; hasSignal {
				t.Fatalf("rejection exposed signal payload: %s", event)
			}

			// The only post-snapshot event is the correlated rejection. Invalid
			// signal shapes are rejected before a limiter or either call router runs.
			_ = conn.SetReadDeadline(time.Now().Add(50 * time.Millisecond))
			if _, extra, err := conn.ReadMessage(); err == nil {
				t.Fatalf("unexpected additional event/send side effect: %s", extra)
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

func TestOpenWebSocketClosesAfterSessionVersionRevocation(t *testing.T) {
	secret := []byte("01234567890123456789012345678901")
	version := &atomic.Int64{}
	version.Store(3)
	consumer := &networkTicketConsumer{allow: true}
	handler := NewHandler(context.Background(), application.NewHub(nil, nil, nil, nil, nil, nil, nil), sharedauth.NewSessionValidator(atomicSessionVersionReader{version: version}, secret), consumer, map[string]struct{}{"https://chat.localhost": {}})
	handler.sessionCheckInterval = 10 * time.Millisecond
	server := httptest.NewServer(handler)
	defer server.Close()
	conn, response, err := (&websocket.Dialer{HandshakeTimeout: time.Second}).Dial(websocketURL(server.URL, signedTicket(t, secret, "websocket", time.Now().Add(time.Minute))), http.Header{"Origin": []string{"https://chat.localhost"}})
	if err != nil {
		if response != nil {
			t.Fatalf("websocket upgrade: %v (%s)", err, response.Status)
		}
		t.Fatalf("websocket upgrade: %v", err)
	}
	defer conn.Close()
	version.Store(4)
	_ = conn.SetReadDeadline(time.Now().Add(time.Second))
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			var networkError net.Error
			if errors.As(err, &networkError) && networkError.Timeout() {
				t.Fatal("socket remained authorized until the test deadline")
			}
			return
		}
	}
}

func TestPublicRejectionMessageHidesInternalErrors(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want string
	}{
		{name: "internal", err: &application.RequestError{RequestID: "req", Err: errors.New("redis password=secret connection refused")}, want: "call unavailable"},
		{name: "not found", err: &application.RequestError{RequestID: "req", Err: application.ErrCallNotFound}, want: "call not found"},
		{name: "not allowed", err: &application.RequestError{RequestID: "req", Err: application.ErrCallNotAllowed}, want: "call not allowed"},
		{name: "busy", err: &application.RequestError{RequestID: "req", Err: application.ErrCallBusy}, want: "user is already in a call"},
		{name: "group room full", err: &application.RequestError{RequestID: "req", Err: application.ErrGroupRoomFull}, want: "group call is full (maximum 4 participants)"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := publicRejectionMessage(test.err); got != test.want {
				t.Fatalf("publicRejectionMessage() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestSendJSONQueueOverflowDefersCleanupUntilGroupStripeIsReleased(t *testing.T) {
	identity := sharedauth.Identity{UserID: uuid.New(), DeviceID: "device"}
	budget := &countingConnectionBudget{}
	hub := application.NewHubWithGroupCallAuthorizer(nil, nil, testGroupAuthorizer{}, nil, nil, nil, nil, nil, nil, nil)
	clientReady := make(chan *client, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		socket, err := (&websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		conn := &client{
			socket: socket, identity: identity, hub: hub, send: make(chan []byte, 16),
			closeRequest: make(chan struct{}, 1), budget: budget, connectionID: "connection",
			protocol: 2,
		}
		hub.Add(r.Context(), conn)
		clientReady <- conn
	}))
	defer server.Close()

	peer, _, err := (&websocket.Dialer{}).Dial(websocketURL(server.URL, "unused"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer peer.Close()
	conn := <-clientReady
	// Hub.Add enqueues the initial presence snapshot; fill the remaining slots.
	for len(conn.send) < cap(conn.send) {
		if !conn.SendJSON(struct{}{}) {
			t.Fatal("could not fill socket queue")
		}
	}
	for i := 0; i < cap(conn.send); i++ {
		<-conn.send
	}
	for i := 0; i < cap(conn.send); i++ {
		conn.send <- []byte(`{}`)
	}

	delivered := make(chan struct{})
	go func() {
		hub.DeliverGroupRoom(context.Background(), application.GroupRoomChange{
			Type: "ended",
			Room: application.GroupRoom{
				ID: uuid.New(), ConversationID: uuid.New(), MembershipRevision: 1, Status: application.GroupRoomEnded,
				Participants: []application.GroupParticipant{{UserID: identity.UserID, DeviceID: identity.DeviceID, ConnectionID: conn.connectionID}},
			},
			RecipientUserIDs:             []uuid.UUID{identity.UserID},
			MembershipProjectionRevision: 2,
			MembershipProjectionDeleted:  true,
		})
		close(delivered)
	}()
	select {
	case <-delivered:
		// DeliverGroupRoom returning proves SendJSON did not synchronously call
		// Hub.Remove (which can re-enter this same conversation stripe).
	case <-time.After(time.Second):
		t.Fatal("queue-overflow send blocked while group conversation stripe was held")
	}

	go conn.writePump(context.Background())
	deadline := time.Now().Add(time.Second)
	for budget.calls.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if got := budget.calls.Load(); got != 1 {
		t.Fatalf("connection budget releases = %d, want exactly 1", got)
	}
	_ = peer.SetReadDeadline(time.Now().Add(time.Second))
	for {
		if _, _, err := peer.ReadMessage(); err != nil {
			var networkError net.Error
			if errors.As(err, &networkError) && networkError.Timeout() {
				t.Fatal("overflowed socket remained open after deferred cleanup")
			}
			break
		}
	}
	conn.Close()
	conn.Close()
	if got := budget.calls.Load(); got != 1 {
		t.Fatalf("connection budget releases after repeated close = %d, want 1", got)
	}
}

type countingConnectionBudget struct {
	calls atomic.Int64
}

type testGroupAuthorizer struct{}

func (testGroupAuthorizer) BeginGroupCall(context.Context, uuid.UUID, uuid.UUID) (application.GroupCallLease, error) {
	return nil, errors.New("unexpected group call authorization")
}

func (*countingConnectionBudget) AllowConnection(context.Context, uuid.UUID, string) (bool, error) {
	return true, nil
}

func (b *countingConnectionBudget) ReleaseConnection(context.Context, uuid.UUID, string) error {
	b.calls.Add(1)
	return nil
}

type sessionVersionReader struct{ version int64 }

type atomicSessionVersionReader struct{ version *atomic.Int64 }

func (r atomicSessionVersionReader) QueryRow(context.Context, string, ...any) pgx.Row {
	return sessionVersionRow{version: r.version.Load()}
}

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
