package token

import (
	"testing"
	"time"

	"github.com/google/uuid"

	sharedauth "github.com/KovalMax/zwei/services/shared/auth"
)

func TestIssueWebSocketTicketUsesDistinctTokenIDs(t *testing.T) {
	issuer := NewJWTIssuer([]byte("01234567890123456789012345678901"))
	issuer.now = func() time.Time { return time.Date(2026, 9, 19, 0, 0, 0, 0, time.UTC) }
	identity := sharedauth.Identity{UserID: uuid.New(), SessionVersion: 1, DeviceID: "device"}

	first, err := issuer.IssueWebSocketTicket(identity, 30*time.Second)
	if err != nil {
		t.Fatalf("issue first ticket: %v", err)
	}
	second, err := issuer.IssueWebSocketTicket(identity, 30*time.Second)
	if err != nil {
		t.Fatalf("issue second ticket: %v", err)
	}
	if first == second {
		t.Fatal("websocket tickets issued at the same time must be distinct")
	}
}
