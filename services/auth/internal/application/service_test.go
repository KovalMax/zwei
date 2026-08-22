package application

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"net/url"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/KovalMax/zwei/services/auth/internal/domain/user"
	sharedauth "github.com/KovalMax/zwei/services/shared/auth"
)

func TestLoginDoesNotRequireDisplayName(t *testing.T) {
	repository := &fakeRepository{account: user.User{ID: uuid.New(), PasswordHash: "hash", SessionVersion: 1, KYCStatus: user.KYCActive, EmailVerified: true}, deviceID: uuid.New()}
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

func TestRegisterCreatesPendingAccountWithoutSession(t *testing.T) {
	repository := &fakeRepository{userID: uuid.New(), deviceID: uuid.New()}
	service := NewService(repository, fakePasswords{}, fakeTokens{}, 15*time.Minute, time.Hour)
	result, err := service.Register(context.Background(), Credentials{Email: "pending@example.test", Password: "password", DisplayName: "Pending", DeviceID: "browser-device"})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Pending || result.Tokens.AccessToken != "" {
		t.Fatalf("result = %#v", result)
	}
	if repository.params.KYCStatus != user.KYCPending || repository.params.EmailVerified {
		t.Fatalf("create params = %#v", repository.params)
	}
}

func TestRegisterWithInvitationCreatesActiveSession(t *testing.T) {
	repository := &fakeRepository{userID: uuid.New(), deviceID: uuid.New()}
	service := NewService(repository, fakePasswords{}, fakeTokens{}, 15*time.Minute, time.Hour)
	result, err := service.Register(context.Background(), Credentials{Email: "invited@example.test", Password: "password", DisplayName: "Invited", DeviceID: "browser-device", InvitationCode: "invite-code"})
	if err != nil {
		t.Fatal(err)
	}
	if result.Pending || result.Tokens.AccessToken != "access-token" {
		t.Fatalf("result = %#v", result)
	}
	if repository.params.KYCStatus != user.KYCActive || !repository.params.EmailVerified || len(repository.params.InvitationCode) == 0 {
		t.Fatalf("create params = %#v", repository.params)
	}
}

func TestLoginRejectsInactiveAccount(t *testing.T) {
	repository := &fakeRepository{account: user.User{ID: uuid.New(), PasswordHash: "hash", SessionVersion: 1, KYCStatus: user.KYCPending}, deviceID: uuid.New()}
	service := NewService(repository, fakePasswords{}, fakeTokens{}, 15*time.Minute, time.Hour)
	_, err := service.Login(context.Background(), Credentials{Email: "pending@example.test", Password: "password", DeviceID: "browser-device"})
	if !errors.Is(err, ErrAccountInactive) {
		t.Fatalf("error = %v", err)
	}
}

func TestActivateVerifiedAccountDoesNotSendActivationEmail(t *testing.T) {
	repository := &fakeRepository{isAdmin: true, prepareEmail: "user@example.test", prepareVerified: true}
	email := &fakeEmailSender{}
	service := NewAdminService(repository, nil, email, "https://chat.localhost/activate", "https://chat.localhost/sign-up")

	err := service.ActivateUser(context.Background(), uuid.New(), uuid.New())
	if err != nil {
		t.Fatal(err)
	}
	if email.calls != 0 {
		t.Fatalf("email calls = %d", email.calls)
	}
}

func TestActivateUnverifiedAccountSendsActivationEmail(t *testing.T) {
	repository := &fakeRepository{isAdmin: true, prepareEmail: "user@example.test", prepareDisplayName: "User"}
	email := &fakeEmailSender{}
	service := NewAdminService(repository, nil, email, "https://chat.localhost/activate", "https://chat.localhost/sign-up")

	err := service.ActivateUser(context.Background(), uuid.New(), uuid.New())
	if err != nil {
		t.Fatal(err)
	}
	if email.calls != 1 || email.to != "user@example.test" || email.name != "User" {
		t.Fatalf("email = %#v", email)
	}
}

func TestResendActivationRotatesTokenAndExpiry(t *testing.T) {
	repository := &fakeRepository{isAdmin: true, resendEmail: "user@example.test", resendDisplayName: "User"}
	email := &fakeEmailSender{}
	service := NewAdminService(repository, nil, email, "https://chat.localhost/activate", "https://chat.localhost/sign-up")
	firstNow := time.Date(2026, 8, 21, 12, 0, 0, 0, time.UTC)
	service.clock = func() time.Time { return firstNow }

	if err := service.ResendActivation(context.Background(), uuid.New(), uuid.New()); err != nil {
		t.Fatal(err)
	}
	firstHash := append([]byte(nil), repository.resendHash...)
	firstExpiry := repository.resendExpiresAt
	firstLink := email.activationLinks[0]
	firstTokenHash := sha256.Sum256([]byte(mustActivationToken(t, firstLink)))
	if !bytes.Equal(firstTokenHash[:], firstHash) {
		t.Fatal("stored activation hash does not match the emailed token")
	}

	secondNow := firstNow.Add(2 * time.Hour)
	service.clock = func() time.Time { return secondNow }
	if err := service.ResendActivation(context.Background(), uuid.New(), uuid.New()); err != nil {
		t.Fatal(err)
	}

	if bytes.Equal(firstHash, repository.resendHash) {
		t.Fatal("resend reused the activation token hash")
	}
	if !repository.resendExpiresAt.After(firstExpiry) || !repository.resendExpiresAt.Equal(secondNow.Add(service.activationLife)) {
		t.Fatalf("resend expiry = %v, want %v", repository.resendExpiresAt, secondNow.Add(service.activationLife))
	}
	if email.calls != 2 || email.activationLinks[1] == firstLink {
		t.Fatalf("activation emails = %#v", email.activationLinks)
	}
	secondTokenHash := sha256.Sum256([]byte(mustActivationToken(t, email.activationLinks[1])))
	if !bytes.Equal(secondTokenHash[:], repository.resendHash) {
		t.Fatal("rotated activation hash does not match the new emailed token")
	}
}

func mustActivationToken(t *testing.T, link string) string {
	t.Helper()
	parsed, err := url.Parse(link)
	if err != nil {
		t.Fatal(err)
	}
	token := parsed.Query().Get("token")
	if token == "" {
		t.Fatalf("activation link has no token: %q", link)
	}
	return token
}

func TestCreateInvitationSendsAccountCreationEmail(t *testing.T) {
	repository := &fakeRepository{isAdmin: true, invitation: user.Invitation{ID: uuid.New(), Email: "invite@example.test"}}
	email := &fakeEmailSender{}
	service := NewAdminService(repository, nil, email, "https://chat.localhost/activate", "https://chat.localhost/sign-up")

	code, _, err := service.CreateInvitation(context.Background(), uuid.New(), "invite@example.test")
	if err != nil {
		t.Fatal(err)
	}
	if email.invitationCalls != 1 || email.to != "invite@example.test" {
		t.Fatalf("email = %#v", email)
	}
	parsed, err := url.Parse(email.link)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Path != "/sign-up" || parsed.Query().Get("invite") != "1" || parsed.Query().Get("code") != code {
		t.Fatalf("invitation link = %q", email.link)
	}
}

type fakeRepository struct {
	account            user.User
	deviceID           uuid.UUID
	userID             uuid.UUID
	params             CreateUserParams
	isAdmin            bool
	prepareEmail       string
	prepareDisplayName string
	prepareVerified    bool
	resendEmail        string
	resendDisplayName  string
	resendHash         []byte
	resendExpiresAt    time.Time
	invitation         user.Invitation
}

func (f *fakeRepository) CreateUserWithDevice(_ context.Context, params CreateUserParams) (uuid.UUID, uuid.UUID, error) {
	f.params = params
	return f.userID, f.deviceID, nil
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
func (f *fakeRepository) IsAdmin(context.Context, uuid.UUID) (bool, error)              { return f.isAdmin, nil }
func (f *fakeRepository) ListAdminUsers(context.Context) ([]user.AdminUser, error)      { return nil, nil }
func (f *fakeRepository) SetKYCStatus(context.Context, uuid.UUID, user.KYCStatus) error { return nil }
func (f *fakeRepository) PrepareActivation(context.Context, uuid.UUID, []byte, time.Time) (string, string, bool, error) {
	return f.prepareEmail, f.prepareDisplayName, f.prepareVerified, nil
}
func (f *fakeRepository) PrepareActivationEmail(_ context.Context, _ uuid.UUID, tokenHash []byte, expiresAt time.Time) (string, string, error) {
	f.resendHash = append([]byte(nil), tokenHash...)
	f.resendExpiresAt = expiresAt
	return f.resendEmail, f.resendDisplayName, nil
}
func (f *fakeRepository) VerifyActivation(context.Context, []byte, time.Time) error { return nil }
func (f *fakeRepository) CreateInvitation(context.Context, string, []byte, uuid.UUID, time.Time) (user.Invitation, error) {
	return f.invitation, nil
}
func (f *fakeRepository) ListInvitations(context.Context) ([]user.Invitation, error) { return nil, nil }
func (f *fakeRepository) RevokeInvitation(context.Context, uuid.UUID) error          { return nil }
func (f *fakeRepository) CreateAdmin(context.Context, string, string, string) error  { return nil }

type fakePasswords struct{}

type fakeEmailSender struct {
	calls           int
	invitationCalls int
	to              string
	name            string
	link            string
	activationLinks []string
}

func (f *fakeEmailSender) SendActivation(_ context.Context, to, name, link string) error {
	f.calls++
	f.to = to
	f.name = name
	f.activationLinks = append(f.activationLinks, link)
	return nil
}

func (f *fakeEmailSender) SendInvitation(_ context.Context, to, link string) error {
	f.invitationCalls++
	f.to = to
	f.link = link
	return nil
}

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
