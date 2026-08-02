package websockettransport

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/maxkoval/p2p-webchat/services/realtime/internal/application"
	sharedauth "github.com/maxkoval/p2p-webchat/services/shared/auth"
)

const (
	maxFrameSize = 4096
	writeTimeout = 10 * time.Second
	readTimeout  = 60 * time.Second
	pingInterval = 30 * time.Second
)

type Handler struct {
	hub      *application.Hub
	sessions *sharedauth.SessionValidator
	origins  map[string]struct{}
	context  context.Context
}

func NewHandler(ctx context.Context, hub *application.Hub, sessions *sharedauth.SessionValidator, origins map[string]struct{}) *Handler {
	return &Handler{context: ctx, hub: hub, sessions: sessions, origins: origins}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	identity, err := h.sessions.AuthenticateWebSocketTicket(r.Context(), r.URL.Query().Get("ticket"))
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	upgrader := websocket.Upgrader{ReadBufferSize: 1024, WriteBufferSize: 1024, CheckOrigin: func(request *http.Request) bool { _, ok := h.origins[request.Header.Get("Origin")]; return ok }}
	socket, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	client := &client{socket: socket, identity: identity, hub: h.hub, send: make(chan []byte, 16)}
	h.hub.Add(client)
	go client.writePump(h.context)
	client.readPump(h.context)
}

type client struct {
	socket   *websocket.Conn
	identity sharedauth.Identity
	hub      *application.Hub
	send     chan []byte
	once     sync.Once
}

func (c *client) Identity() sharedauth.Identity { return c.identity }
func (c *client) Close()                        { c.once.Do(func() { c.hub.Remove(c); _ = c.socket.Close() }) }
func (c *client) SendJSON(value any) {
	payload, err := json.Marshal(value)
	if err != nil {
		return
	}
	select {
	case c.send <- payload:
	default:
		c.Close()
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
			continue
		}
		if !json.Valid(payload) {
			_ = c.socket.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseUnsupportedData, "invalid JSON"), time.Now().Add(writeTimeout))
			return
		}
		slog.Info("websocket message received", "user_id", c.identity.UserID, "bytes", len(payload))
		if err := c.hub.Handle(ctx, c, payload); err != nil {
			c.SendJSON(struct {
				Type    string            `json:"type"`
				Payload map[string]string `json:"payload"`
			}{Type: "message.rejected", Payload: map[string]string{"error": err.Error()}})
		}
	}
}
func (c *client) writePump(ctx context.Context) {
	ticker := time.NewTicker(pingInterval)
	defer ticker.Stop()
	defer c.Close()
	for {
		select {
		case payload := <-c.send:
			_ = c.socket.SetWriteDeadline(time.Now().Add(writeTimeout))
			if c.socket.WriteMessage(websocket.TextMessage, payload) != nil {
				return
			}
		case <-ticker.C:
			if c.socket.WriteControl(websocket.PingMessage, nil, time.Now().Add(writeTimeout)) != nil {
				return
			}
		case <-ctx.Done():
			return
		}
	}
}
