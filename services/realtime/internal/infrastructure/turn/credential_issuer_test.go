package turn

import (
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/KovalMax/zwei/services/realtime/internal/application"
)

func TestCredentialIssuerIssuesBoundedRESTCredential(t *testing.T) {
	issuer, err := NewCredentialIssuer("01234567890123456789012345678901", []string{"turn:turn.example.test:3478?transport=udp"}, 2*time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	issuer.now = func() time.Time { return time.Unix(1_770_000_000, 0) }
	call := application.Call{ID: uuid.New()}
	credential, err := issuer.Issue(call, uuid.New())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(credential.Username, "1770007200:") || credential.Credential == "" {
		t.Fatalf("credential = %+v", credential)
	}
	if len(credential.URLs) != 1 || credential.URLs[0] != "turn:turn.example.test:3478?transport=udp" {
		t.Fatalf("URLs = %v", credential.URLs)
	}
}
