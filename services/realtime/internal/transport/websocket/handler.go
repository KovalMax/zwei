package websockettransport

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"

	"github.com/KovalMax/zwei/services/realtime/internal/application"
	sharedauth "github.com/KovalMax/zwei/services/shared/auth"
)

const (
	// WebRTC SDP can exceed the message-chat frame budget. Signals remain bounded
	// by Hub validation and are never logged.
	maxFrameSize = 32 * 1024
	writeTimeout = 10 * time.Second
	readTimeout  = 60 * time.Second
	pingInterval = 30 * time.Second
)

type Handler struct {
	hub                  *application.Hub
	sessions             *sharedauth.SessionValidator
	tickets              TicketConsumer
	origins              map[string]struct{}
	context              context.Context
	protocol             int
	sessionCheckInterval time.Duration
}

type TicketConsumer interface {
	ConsumeWebSocketTicket(context.Context, string) (bool, error)
}

func NewHandler(ctx context.Context, hub *application.Hub, sessions *sharedauth.SessionValidator, tickets TicketConsumer, origins map[string]struct{}) *Handler {
	return NewVersionedHandler(ctx, hub, sessions, tickets, origins, application.ProtocolVersion)
}

func NewVersionedHandler(ctx context.Context, hub *application.Hub, sessions *sharedauth.SessionValidator, tickets TicketConsumer, origins map[string]struct{}, protocol int) *Handler {
	return &Handler{context: ctx, hub: hub, sessions: sessions, tickets: tickets, origins: origins, protocol: protocol, sessionCheckInterval: pingInterval}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	identity, err := h.authenticate(r.Context(), r.URL.Query().Get("ticket"))
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	connectionID := uuid.NewString()
	budget, hasBudget := h.tickets.(application.ConnectionBudget)
	if hasBudget {
		allowed, err := budget.AllowConnection(r.Context(), identity.UserID, connectionID)
		if err != nil {
			http.Error(w, "connection budget unavailable", http.StatusServiceUnavailable)
			return
		}
		if !allowed {
			w.Header().Set("Retry-After", "60")
			http.Error(w, "connection limit exceeded", http.StatusTooManyRequests)
			return
		}
	}
	upgrader := websocket.Upgrader{ReadBufferSize: 1024, WriteBufferSize: 1024, CheckOrigin: func(request *http.Request) bool { _, ok := h.origins[request.Header.Get("Origin")]; return ok }}
	socket, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		if hasBudget {
			_ = budget.ReleaseConnection(context.Background(), identity.UserID, connectionID)
		}
		return
	}
	client := &client{socket: socket, identity: identity, hub: h.hub, send: make(chan []byte, 16), closeRequest: make(chan struct{}, 1), budget: budget, connectionID: connectionID, protocol: h.protocol, sessions: h.sessions, sessionCheckInterval: h.sessionCheckInterval}
	h.hub.Add(r.Context(), client)
	go client.writePump(h.context)
	client.readPump(h.context)
}

func (h *Handler) authenticate(ctx context.Context, ticket string) (sharedauth.Identity, error) {
	identity, err := h.sessions.AuthenticateWebSocketTicket(ctx, ticket)
	if err != nil {
		return sharedauth.Identity{}, err
	}
	consumed, err := h.tickets.ConsumeWebSocketTicket(ctx, ticket)
	if err != nil || !consumed {
		return sharedauth.Identity{}, errors.New("invalid websocket ticket")
	}
	return identity, nil
}

type client struct {
	socket       *websocket.Conn
	identity     sharedauth.Identity
	hub          *application.Hub
	send         chan []byte
	closeRequest chan struct{}
	once         sync.Once
	sendMu       sync.Mutex
	closed       bool
	budget       application.ConnectionBudget
	connectionID string
	protocol     int
	sessions     interface {
		Validate(context.Context, sharedauth.Identity, bool) error
	}
	sessionCheckInterval time.Duration
}

func (c *client) Identity() sharedauth.Identity { return c.identity }
func (c *client) ConnectionID() string          { return c.connectionID }
func (c *client) ProtocolVersion() int          { return c.protocol }
func (c *client) Close() {
	c.sendMu.Lock()
	c.closed = true
	c.sendMu.Unlock()
	c.once.Do(func() {
		c.hub.Remove(context.Background(), c)
		if c.budget != nil {
			_ = c.budget.ReleaseConnection(context.Background(), c.identity.UserID, c.connectionID)
		}
		_ = c.socket.Close()
	})
}
func (c *client) SendJSON(value any) bool {
	payload, err := json.Marshal(value)
	if err != nil {
		return false
	}
	if c.protocol != application.ProtocolVersion {
		var envelope map[string]json.RawMessage
		if json.Unmarshal(payload, &envelope) == nil && envelope["version"] != nil {
			version, marshalErr := json.Marshal(c.protocol)
			if marshalErr != nil {
				return false
			}
			envelope["version"] = version
			payload, err = json.Marshal(envelope)
			if err != nil {
				return false
			}
		}
	}
	c.sendMu.Lock()
	if c.closed {
		c.sendMu.Unlock()
		return false
	}
	select {
	case c.send <- payload:
		c.sendMu.Unlock()
		return true
	default:
		// Queue admission can be called while the application owns a group
		// conversation stripe. Defer lifecycle cleanup to the owned write pump
		// rather than calling Hub.Remove on this stack.
		select {
		case c.closeRequest <- struct{}{}:
		default:
		}
		c.sendMu.Unlock()
		return false
	}
}
func (c *client) readPump(ctx context.Context) {
	defer c.Close()
	c.socket.SetReadLimit(maxFrameSize)
	_ = c.socket.SetReadDeadline(time.Now().Add(readTimeout))
	c.socket.SetPongHandler(func(string) error { return c.socket.SetReadDeadline(time.Now().Add(readTimeout)) })
	for {
		messageType, payload, err := c.socket.ReadMessage()
		if err != nil {
			return
		}
		if messageType != websocket.TextMessage {
			_ = c.socket.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseUnsupportedData, "text frames only"), time.Now().Add(writeTimeout))
			return
		}
		if !json.Valid(payload) {
			_ = c.socket.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseUnsupportedData, "invalid JSON"), time.Now().Add(writeTimeout))
			return
		}
		var envelope struct {
			Version int `json:"version"`
		}
		if json.Unmarshal(payload, &envelope) != nil || envelope.Version != c.protocol {
			_ = c.socket.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseUnsupportedData, "unsupported protocol version"), time.Now().Add(writeTimeout))
			return
		}
		slog.Info("websocket message received", "user_id", c.identity.UserID, "bytes", len(payload))
		if err := c.hub.HandleVersion(ctx, c, c.protocol, payload); err != nil {
			requestID := ""
			var requestError *application.RequestError
			if errors.As(err, &requestError) {
				requestID = requestError.RequestID
			}
			rejectionType := "message.rejected"
			if len(payload) > 0 {
				var command struct {
					Type string `json:"type"`
				}
				if json.Unmarshal(payload, &command) == nil && (strings.HasPrefix(command.Type, "call.") || strings.HasPrefix(command.Type, "group.call.")) {
					rejectionType = "call.rejected"
				}
			}
			c.SendJSON(struct {
				Version   int               `json:"version"`
				Type      string            `json:"type"`
				RequestID string            `json:"request_id,omitempty"`
				Payload   map[string]string `json:"payload"`
			}{Version: application.ProtocolVersion, Type: rejectionType, RequestID: requestID, Payload: map[string]string{"error": err.Error()}})
		}
	}
}
func (c *client) writePump(ctx context.Context) {
	interval := c.sessionCheckInterval
	if interval <= 0 {
		interval = pingInterval
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	defer c.Close()
	for {
		select {
		case payload := <-c.send:
			_ = c.socket.SetWriteDeadline(time.Now().Add(writeTimeout))
			if c.socket.WriteMessage(websocket.TextMessage, payload) != nil {
				return
			}
		case <-c.closeRequest:
			return
		case <-ticker.C:
			// Tickets are single-use and validate the session only during upgrade.
			// Recheck the shared persisted session version at a bounded cadence and
			// fail closed on database errors so blocked/revoked sessions cannot keep
			// an already-open socket indefinitely.
			validationContext, cancel := context.WithTimeout(ctx, writeTimeout)
			validationErr := error(nil)
			if c.sessions == nil {
				validationErr = sharedauth.ErrSessionInvalid
			} else {
				validationErr = c.sessions.Validate(validationContext, c.identity, true)
			}
			cancel()
			if validationErr != nil {
				return
			}
			if c.socket.WriteControl(websocket.PingMessage, nil, time.Now().Add(writeTimeout)) != nil {
				return
			}
		case <-ctx.Done():
			return
		}
	}
}
