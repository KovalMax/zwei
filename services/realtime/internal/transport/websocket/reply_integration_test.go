package websockettransport

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/KovalMax/zwei/services/realtime/internal/application"
	sharedauth "github.com/KovalMax/zwei/services/shared/auth"
	"github.com/KovalMax/zwei/services/shared/messaging"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5/pgxpool"
)

type replyCoordinator struct{}
type replyTickets struct{}

func (replyTickets) ConsumeWebSocketTicket(context.Context, string) (bool, error) { return true, nil }

func (replyCoordinator) Connect(context.Context, uuid.UUID, string) (bool, error) { return false, nil }
func (replyCoordinator) Disconnect(context.Context, uuid.UUID, string) (bool, error) {
	return false, nil
}
func (replyCoordinator) Online(context.Context, []uuid.UUID) (map[uuid.UUID]bool, error) {
	return nil, nil
}
func (replyCoordinator) Publish(context.Context, uuid.UUID, bool) error        { return nil }
func (replyCoordinator) AllowMessage(context.Context, uuid.UUID) (bool, error) { return true, nil }

func TestReplyWebSocketIntegration(t *testing.T) {
	url := os.Getenv("ZWEI_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set ZWEI_TEST_DATABASE_URL")
	}
	ctx := context.Background()
	db, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	a, b, conv := uuid.New(), uuid.New(), uuid.New()
	_, err = db.Exec(ctx, `INSERT INTO users(id,email,password_hash,display_name) VALUES($1,$2,'x','a'),($3,$4,'x','b')`, a, a.String()+"@test.invalid", b, b.String()+"@test.invalid")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Exec(context.Background(), `DELETE FROM users WHERE id=ANY($1)`, []uuid.UUID{a, b})
	low, high := a, b
	if high.String() < low.String() {
		low, high = high, low
	}
	_, err = db.Exec(ctx, `WITH c AS (INSERT INTO conversations(id,user_low_id,user_high_id,next_sequence) VALUES($1,$2,$3,1) RETURNING id) INSERT INTO conversation_members(conversation_id,user_id) SELECT id,$2 FROM c UNION ALL SELECT id,$3 FROM c`, conv, low, high)
	if err != nil {
		t.Fatal(err)
	}
	sender := messaging.NewSender(db, "reply-ws-key")
	target, _, err := sender.Send(ctx, messaging.SendRequest{SenderID: a, ConversationID: conv, ClientMessageID: "target", Body: "target", ContentType: "text"})
	if err != nil {
		t.Fatal(err)
	}
	secret := []byte("01234567890123456789012345678901")
	hub := application.NewHub(sender, nil, replyCoordinator{}, nil, nil, nil, nil)
	h := NewHandler(ctx, hub, sharedauth.NewSessionValidator(sessionVersionReader{version: 3}, secret), replyTickets{}, map[string]struct{}{"https://chat.localhost": {}})
	server := httptest.NewServer(h)
	defer server.Close()
	dial := func(id uuid.UUID) *websocket.Conn {
		t.Helper()
		ticket, err := jwt.NewWithClaims(jwt.SigningMethodHS256, sharedauth.Claims{BrowserID: uuid.NewString(), BrowserGeneration: uuid.NewString(), SessionVersion: 3, DeviceID: uuid.NewString(), Purpose: "websocket", RegisteredClaims: jwt.RegisteredClaims{Subject: id.String(), ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Minute))}}).SignedString(secret)
		if err != nil {
			t.Fatal(err)
		}
		c, resp, err := websocket.DefaultDialer.Dial(websocketURL(server.URL, ticket), http.Header{"Origin": []string{"https://chat.localhost"}})
		if err != nil {
			t.Fatalf("dial %v %v", err, resp)
		}
		c.SetReadDeadline(time.Now().Add(5 * time.Second))
		var snapshot map[string]any
		if err = c.ReadJSON(&snapshot); err != nil {
			t.Fatal(err)
		}
		return c
	}
	recipient := dial(b)
	defer recipient.Close()
	source := dial(a)
	defer source.Close()
	send := func(frame string) {
		t.Helper()
		if err := source.WriteMessage(websocket.TextMessage, []byte(frame)); err != nil {
			t.Fatal(err)
		}
	}
	type event struct {
		Type      string          `json:"type"`
		RequestID string          `json:"request_id"`
		Payload   json.RawMessage `json:"payload"`
	}
	read := func(c *websocket.Conn) event {
		t.Helper()
		var e event
		if err := c.ReadJSON(&e); err != nil {
			t.Fatal(err)
		}
		return e
	}
	send(`{"version":4,"type":"message.reply.send","request_id":"req-1","payload":{"conversation_id":"` + conv.String() + `","client_message_id":"client-1","body":"reply","content_type":"text","reply_to_message_id":"` + target.ID.String() + `"}}`)
	accepted := read(source)
	live := read(recipient)
	var am, lm messaging.Message
	if err = json.Unmarshal(accepted.Payload, &am); err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(live.Payload, &lm); err != nil {
		t.Fatal(err)
	}
	if accepted.Type != "message.accepted" || accepted.RequestID != "req-1" || live.Type != "message.created" || am.ID != lm.ID || am.ClientMessageID != "client-1" || am.ReplyToMessageID == nil || lm.ReplyToMessageID == nil || *am.ReplyToMessageID != target.ID || *lm.ReplyToMessageID != target.ID {
		t.Fatalf("accepted=%+v live=%+v am=%+v lm=%+v", accepted, live, am, lm)
	}
	for _, test := range []struct{ name, command, clientID, target string }{
		{"ordinary-to-reply", "message.reply.send", "target", target.ID.String()},
		{"reply-to-ordinary", "message.send", "client-1", ""},
		{"reply-to-other", "message.reply.send", "client-1", am.ID.String()},
	} {
		field := ""
		if test.target != "" {
			field = `,"reply_to_message_id":"` + test.target + `"`
		}
		send(`{"version":4,"type":"` + test.command + `","request_id":"` + test.name + `","payload":{"conversation_id":"` + conv.String() + `","client_message_id":"` + test.clientID + `","body":"collision","content_type":"text"` + field + `}}`)
		e := read(source)
		var rejection map[string]string
		if err := json.Unmarshal(e.Payload, &rejection); err != nil || e.Type != "message.rejected" || e.RequestID != test.name || rejection["error"] != messaging.ErrClientMessageIDConflict.Error() {
			t.Fatalf("collision %s: %+v %s", test.name, e, e.Payload)
		}
	}
	send(`{"version":4,"type":"message.reply.send","request_id":"malformed-conversation","payload":{"conversation_id":"invalid","client_message_id":"malformed","body":"reply","content_type":"text","reply_to_message_id":"` + target.ID.String() + `"}}`)
	if e := read(source); e.Type != "message.rejected" || e.RequestID != "malformed-conversation" {
		t.Fatalf("malformed reply correlation: %+v", e)
	}
	send(`{"version":4,"type":"message.send","request_id":"dup","payload":{"reply_to_message_id":"` + target.ID.String() + `"},"payload":{"content_type":"text","body":"oops","conversation_id":"` + conv.String() + `","client_message_id":"bad"}}`)
	if e := read(source); e.Type != "message.rejected" || e.RequestID != "" {
		t.Fatalf("duplicate: %+v", e)
	}
	send(`{"version":4,"type":"message.reply.send","request_id":"unauthorized","payload":{"conversation_id":"` + conv.String() + `","client_message_id":"bad-target","body":"oops","content_type":"text","reply_to_message_id":"` + uuid.NewString() + `"}}`)
	if e := read(source); e.Type != "message.rejected" || e.RequestID != "unauthorized" {
		t.Fatalf("invalid target: %+v", e)
	}
	var count int
	if err = db.QueryRow(ctx, `SELECT count(*) FROM messages WHERE conversation_id=$1`, conv).Scan(&count); err != nil || count != 2 {
		t.Fatalf("persisted %d %v", count, err)
	}
}
