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

func TestIssuePreservesBrowserBinding(t *testing.T) {
	secret := []byte("01234567890123456789012345678901")
	issuer := NewJWTIssuer(secret)
	identity := sharedauth.Identity{UserID: uuid.New(), SessionVersion: 1, DeviceID: "device", BrowserID: uuid.New(), BrowserGeneration: uuid.New()}
	for _, tc := range []struct {
		name  string
		issue func(sharedauth.Identity, time.Duration) (string, error)
		parse func(string, []byte) (sharedauth.Identity, error)
	}{
		{"access", issuer.IssueAccess, sharedauth.Parse}, {"ticket", issuer.IssueWebSocketTicket, sharedauth.ParseWebSocketTicket},
	} {
		t.Run(tc.name, func(t *testing.T) {
			raw, err := tc.issue(identity, time.Minute)
			if err != nil {
				t.Fatal(err)
			}
			got, err := tc.parse(raw, secret)
			if err != nil || got.BrowserID != identity.BrowserID || got.BrowserGeneration != identity.BrowserGeneration {
				t.Fatalf("binding: %+v, %v", got, err)
			}
			partial := identity
			partial.BrowserGeneration = uuid.Nil
			if _, err := tc.issue(partial, time.Minute); err == nil {
				t.Fatal("accepted partial binding")
			}
		})
	}
}
