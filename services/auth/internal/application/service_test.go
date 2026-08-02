package application

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/maxkoval/p2p-webchat/services/auth/internal/domain/user"
	sharedauth "github.com/maxkoval/p2p-webchat/services/shared/auth"
)

func TestLoginDoesNotRequireDisplayName(t *testing.T) {
	repository := &fakeRepository{account: user.User{ID: uuid.New(), PasswordHash: "hash", SessionVersion: 1}, deviceID: uuid.New()}
	service := NewService(repository, fakePasswords{}, fakeTokens{}, 15*time.Minute, time.Hour)
	tokens, err := service.Login(context.Background(), Credentials{Email: "user@example.test", Password: "password", DeviceID: "browser-device"})
	if err != nil {
		t.Fatalf("Login() error = %v", err)
	}
	if tokens.AccessToken != "access-token" {
		t.Fatalf("access token = %q", tokens.AccessToken)
	}
}

func TestTokensUseAPIFieldNames(t *testing.T) {
	tokens := Tokens{AccessToken: "access", TokenType: "Bearer", ExpiresIn: 900, RefreshToken: "refresh"}
	payload, err := json.Marshal(tokens)
	if err != nil {
		t.Fatal(err)
	}
	var response map[string]any
	if err := json.Unmarshal(payload, &response); err != nil {
		t.Fatal(err)
	}
	if response["access_token"] != "access" || response["refresh_token"] != "refresh" {
		t.Fatalf("unexpected token JSON: %s", payload)
	}
}

type fakeRepository struct {
	account  user.User
	deviceID uuid.UUID
}

func (f *fakeRepository) CreateUserWithDevice(context.Context, string, string, string, string, string) (uuid.UUID, uuid.UUID, error) {
	return uuid.Nil, uuid.Nil, errors.New("not implemented")
}
func (f *fakeRepository) FindUserByEmail(context.Context, string) (user.User, error) {
	return f.account, nil
}
func (f *fakeRepository) EnsureDevice(context.Context, uuid.UUID, string, string) (uuid.UUID, error) {
	return f.deviceID, nil
}
func (f *fakeRepository) CreateSession(context.Context, uuid.UUID, uuid.UUID, []byte, int64, time.Time) error {
	return nil
}
func (f *fakeRepository) RotateRefreshToken(context.Context, []byte) (user.Session, error) {
	return user.Session{}, errors.New("not implemented")
}
func (f *fakeRepository) RevokeAllSessions(context.Context, uuid.UUID) error { return nil }
func (f *fakeRepository) Profile(context.Context, uuid.UUID) (user.Profile, error) {
	return user.Profile{}, errors.New("not implemented")
}
func (f *fakeRepository) UpdateProfile(context.Context, uuid.UUID, *string, *string) error {
	return nil
}

type fakePasswords struct{}

func (fakePasswords) Hash(string) (string, error) { return "hash", nil }
func (fakePasswords) Compare(hash, value string) error {
	if hash != "hash" || value != "password" {
		return errors.New("invalid")
	}
	return nil
}

type fakeTokens struct{}

func (fakeTokens) IssueAccess(sharedauth.Identity, time.Duration) (string, error) {
	return "access-token", nil
}
func (fakeTokens) IssueWebSocketTicket(sharedauth.Identity, time.Duration) (string, error) {
	return "ticket", nil
}
