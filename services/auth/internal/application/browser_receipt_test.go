package application

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
)

type receiptRepo struct {
	*browserRepo
	hash     []byte
	verified bool
}

func (r *receiptRepo) LogoutBrowserSessionWithReceipt(_ context.Context, _, _, _ uuid.UUID, _ int64, hash []byte, _ time.Time) error {
	r.hash = append([]byte(nil), hash...)
	return nil
}
func (r *receiptRepo) VerifyBrowserLogoutReceipt(_ context.Context, _, _, _ uuid.UUID, hash []byte) error {
	if string(hash) != string(r.hash) {
		return ErrRefreshToken
	}
	r.verified = true
	return nil
}
func (r *receiptRepo) LogoutBrowserSessionWithProofAndReceipt(context.Context, uuid.UUID, uuid.UUID, uuid.UUID, []byte, []byte, time.Time) error {
	return ErrRefreshToken
}

func TestLogoutReceiptValidationAndConfirmation(t *testing.T) {
	r := &receiptRepo{}
	s := NewBrowserSessions(r, nil, time.Minute, time.Hour)
	secret := base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	cmd := LogoutBrowserSessionCommand{Current: BrowserCredential{BrowserID: uuid.New(), Generation: uuid.New()}, UserID: uuid.New(), SessionVersion: 1}
	if err := s.LogoutWithReceipt(context.Background(), cmd, secret); err != nil {
		t.Fatal(err)
	}
	expected := sha256.Sum256(make([]byte, 32))
	if string(r.hash) != string(expected[:]) {
		t.Fatal("receipt was not hashed")
	}
	retry := LogoutBrowserSessionRetryCommand{Current: cmd.Current, UserID: cmd.UserID, Receipt: secret}
	if err := s.LogoutRetry(context.Background(), retry); err != nil || !r.verified {
		t.Fatal("lost response not confirmed", err)
	}
	retry.Receipt = secret + "="
	if err := s.LogoutRetry(context.Background(), retry); !errors.Is(err, ErrInvalidInput) {
		t.Fatal("noncanonical receipt accepted", err)
	}
}
