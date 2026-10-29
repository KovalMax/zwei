package application

import (
	"context"
	"crypto/sha256"
	"testing"

	"github.com/google/uuid"
)

type retryRepo struct {
	browserRepo
	hash    []byte
	subject uuid.UUID
}

func (r *retryRepo) LogoutBrowserSessionWithProof(_ context.Context, _, _ uuid.UUID, subject uuid.UUID, hash []byte) error {
	r.subject = subject
	r.hash = append([]byte(nil), hash...)
	return nil
}

func TestLogoutRetryHashesProof(t *testing.T) {
	r := &retryRepo{}
	s := NewBrowserSessions(r, fakeTokens{}, 0, 0)
	subject := uuid.New()
	err := s.LogoutRetry(context.Background(), LogoutBrowserSessionRetryCommand{UserID: subject, Current: BrowserCredential{BrowserID: uuid.New(), Generation: uuid.New(), RefreshToken: "proof"}})
	expected := sha256.Sum256([]byte("proof"))
	if err != nil || r.subject != subject || string(r.hash) != string(expected[:]) {
		t.Fatalf("retry did not pass bound hash: %v", err)
	}
}
