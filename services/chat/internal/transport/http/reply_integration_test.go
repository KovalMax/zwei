package httptransport

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/KovalMax/zwei/services/chat/internal/domain/conversation"
	"github.com/KovalMax/zwei/services/chat/internal/persistence/postgres"
	sharedauth "github.com/KovalMax/zwei/services/shared/auth"
	"github.com/KovalMax/zwei/services/shared/messaging"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestReplyLookupAndHistoryVisibilityIntegration(t *testing.T) {
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
	a, b, c, conv, other := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	_, err = db.Exec(ctx, `INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,'x','a'),($3,$4,'x','b'),($5,$6,'x','c')`, a, a.String()+"@test.invalid", b, b.String()+"@test.invalid", c, c.String()+"@test.invalid")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Exec(context.Background(), `DELETE FROM users WHERE id=ANY($1)`, []uuid.UUID{a, b, c})
	for _, v := range []struct{ id, x, y uuid.UUID }{{conv, a, b}, {other, a, c}} {
		low, high := v.x, v.y
		if high.String() < low.String() {
			low, high = high, low
		}
		_, err = db.Exec(ctx, `WITH new_conv AS (INSERT INTO conversations(id,user_low_id,user_high_id,next_sequence) VALUES($1,$2,$3,1) RETURNING id) INSERT INTO conversation_members(conversation_id,user_id) SELECT id,$2 FROM new_conv UNION ALL SELECT id,$3 FROM new_conv`, v.id, low, high)
		if err != nil {
			t.Fatal(err)
		}
	}
	sender := messaging.NewSender(db, "reply-http-key")
	target, _, err := sender.Send(ctx, messaging.SendRequest{SenderID: a, ConversationID: conv, ClientMessageID: "target", Body: "target", ContentType: "text"})
	if err != nil {
		t.Fatal(err)
	}
	reply, _, err := sender.Send(ctx, messaging.SendRequest{SenderID: a, ConversationID: conv, ClientMessageID: "reply", Body: "reply", ContentType: "text", ReplyToMessageID: &target.ID})
	if err != nil {
		t.Fatal(err)
	}
	const secret = "0123456789abcdef0123456789abcdef"
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, sharedauth.Claims{BrowserID: uuid.NewString(), BrowserGeneration: uuid.NewString(), SessionVersion: 7, RegisteredClaims: jwt.RegisteredClaims{Subject: b.String(), ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Minute))}}).SignedString([]byte(secret))
	if err != nil {
		t.Fatal(err)
	}
	h := &Handler{history: postgres.NewHistoryRepository(db, "reply-http-key"), limiter: &testRequestLimiter{allowed: true}, sessions: sharedauth.NewSessionValidator(rateLimitSessionReader{}, []byte(secret))}
	mux := http.NewServeMux()
	h.Register(mux)
	get := func(path string) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest("GET", path, nil)
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w
	}
	path := "/api/chat/conversations/" + conv.String() + "/messages/" + reply.ID.String()
	w := get(path)
	var got conversation.Message
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &got) != nil || got.ReplyToMessageID == nil || *got.ReplyToMessageID != target.ID {
		t.Fatalf("lookup %d %s", w.Code, w.Body)
	}
	w = get("/api/chat/conversations/" + conv.String() + "/messages")
	var page struct {
		Messages []conversation.Message `json:"messages"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &page) != nil {
		t.Fatalf("history %d %s", w.Code, w.Body)
	}
	found := false
	for _, m := range page.Messages {
		if m.ID == reply.ID {
			found = m.ReplyToMessageID != nil && *m.ReplyToMessageID == target.ID
		}
		if m.ID == target.ID && m.ReplyToMessageID != nil {
			t.Fatal("ordinary message has reply")
		}
	}
	if !found {
		t.Fatalf("missing reply: %s", w.Body)
	}
	if w = get("/api/chat/conversations/" + other.String() + "/messages/" + reply.ID.String()); w.Code != 404 {
		t.Fatalf("cross conversation %d", w.Code)
	}
	for _, q := range []string{`UPDATE conversation_members SET visible_from_sequence=3 WHERE conversation_id=$1 AND user_id=$2`, `UPDATE conversation_members SET visible_from_sequence=1,active=false,left_at=now() WHERE conversation_id=$1 AND user_id=$2`} {
		if _, err = db.Exec(ctx, q, conv, b); err != nil {
			t.Fatal(err)
		}
		if w = get(path); w.Code != 404 {
			t.Fatalf("visibility: %d", w.Code)
		}
	}
	if _, err = db.Exec(ctx, `UPDATE conversation_members SET active=true,left_at=NULL WHERE conversation_id=$1 AND user_id=$2`, conv, b); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(ctx, `UPDATE messages SET expires_at=now()-interval '1 second' WHERE id=$1`, reply.ID); err != nil {
		t.Fatal(err)
	}
	if w = get(path); w.Code != 404 {
		t.Fatalf("expired: %d", w.Code)
	}
}
