package application

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
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

func TestRefreshPreservesRotationErrors(t *testing.T) {
	storageFailure := errors.New("database unavailable")
	for _, want := range []error{ErrRefreshToken, storageFailure, context.Canceled} {
		service := NewService(&refreshErrorRepository{err: want}, fakePasswords{}, fakeTokens{}, time.Minute, time.Hour)
		_, err := service.Refresh(context.Background(), "refresh")
		if !errors.Is(err, want) {
			t.Errorf("Refresh() error = %v, want %v", err, want)
		}
	}
}

type refreshErrorRepository struct {
	fakeRepository
	err error
}

func (f *fakeRepository) RotateRefreshCandidates(context.Context, [][]byte, []byte, time.Time, func(user.Session, []byte) error) error {
	return nil
}

type candidateRepository struct {
	fakeRepository
	hashes [][]byte
	err    error
}

func (f *candidateRepository) RotateRefreshCandidates(_ context.Context, hashes [][]byte, _ []byte, _ time.Time, issue func(user.Session, []byte) error) error {
	f.hashes = hashes
	if f.err != nil {
		return f.err
	}
	return issue(user.Session{UserID: uuid.New(), DeviceID: uuid.New(), SessionVersion: 1}, hashes[0])
}

func TestRefreshCandidatesBoundsAndDeduplicates(t *testing.T) {
	repo := &candidateRepository{}
	service := NewService(repo, fakePasswords{}, fakeTokens{}, time.Minute, time.Hour)
	for _, input := range [][]string{nil, {""}, {string(bytes.Repeat([]byte("x"), 4097))}, make([]string, MaxRefreshCandidates+1)} {
		if _, err := service.RefreshCandidates(context.Background(), input); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("invalid candidates: %v", err)
		}
	}
	if _, err := service.RefreshCandidates(context.Background(), []string{"first", "first", "second"}); err != nil {
		t.Fatal(err)
	}
	first, second := sha256.Sum256([]byte("first")), sha256.Sum256([]byte("second"))
	if len(repo.hashes) != 2 || !bytes.Equal(repo.hashes[0], first[:]) || !bytes.Equal(repo.hashes[1], second[:]) {
		t.Fatal("candidate hashes not deduplicated")
	}
	repo.err = ErrRefreshToken
	if _, err := service.RefreshCandidates(context.Background(), []string{"first", "second"}); !errors.Is(err, ErrRefreshToken) {
		t.Fatalf("ambiguity error: %v", err)
	}
}

func (f *refreshErrorRepository) RotateRefreshToken(context.Context, []byte, []byte, time.Time, func(user.Session) error) error {
	return f.err
}

func TestPushSubscriptionRequiresVerifiedSessionDeviceAndSupportedEndpoint(t *testing.T) {
	repository := &fakeRepository{}
	service := NewService(repository, fakePasswords{}, fakeTokens{}, 15*time.Minute, time.Hour)
	identity := sharedauth.Identity{UserID: uuid.New(), SessionVersion: 7, DeviceID: uuid.NewString(), BrowserID: uuid.New(), BrowserGeneration: uuid.New()}
	subscription := PushSubscription{
		Endpoint: "https://fcm.googleapis.com/fcm/send/token",
		P256DH:   base64.RawURLEncoding.EncodeToString(append([]byte{4}, make([]byte, 64)...)),
		Auth:     base64.RawURLEncoding.EncodeToString(make([]byte, 16)),
	}
	if err := service.StorePushSubscription(context.Background(), identity, subscription); err != nil {
		t.Fatalf("StorePushSubscription() error = %v", err)
	}
	if repository.pushUserID != identity.UserID || repository.pushDeviceID.String() != identity.DeviceID || repository.pushSessionVersion != identity.SessionVersion || repository.pushSubscription != subscription || repository.pushBrowserID != identity.BrowserID || repository.pushGeneration != identity.BrowserGeneration {
		t.Fatalf("stored identity/subscription = %v %v %d %#v", repository.pushUserID, repository.pushDeviceID, repository.pushSessionVersion, repository.pushSubscription)
	}
	for _, invalid := range []PushSubscription{
		{Endpoint: "http://fcm.googleapis.com/send", P256DH: subscription.P256DH, Auth: subscription.Auth},
		{Endpoint: "https://attacker.example/push", P256DH: subscription.P256DH, Auth: subscription.Auth},
		{Endpoint: subscription.Endpoint, P256DH: string(make([]byte, 129)), Auth: subscription.Auth},
	} {
		if err := service.StorePushSubscription(context.Background(), identity, invalid); !errors.Is(err, ErrInvalidInput) {
			t.Errorf("invalid subscription error = %v, want ErrInvalidInput", err)
		}
	}
	if err := service.StorePushSubscription(context.Background(), sharedauth.Identity{UserID: identity.UserID}, subscription); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("identity without session/device error = %v", err)
	}
	for _, invalid := range []sharedauth.Identity{{UserID: identity.UserID, DeviceID: identity.DeviceID, SessionVersion: 7, BrowserGeneration: identity.BrowserGeneration}, {UserID: identity.UserID, DeviceID: identity.DeviceID, SessionVersion: 7, BrowserID: identity.BrowserID}} {
		if err := service.StorePushSubscription(context.Background(), invalid, subscription); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("identity without browser binding error = %v", err)
		}
	}
}

func TestDeleteCurrentPushSubscriptionScopesAndValidatesIdentity(t *testing.T) {
	repository := &fakeRepository{}
	service := NewService(repository, nil, nil, time.Minute, time.Hour)
	identity := sharedauth.Identity{UserID: uuid.New(), DeviceID: uuid.NewString(), SessionVersion: 3, BrowserID: uuid.New(), BrowserGeneration: uuid.New()}
	if err := service.DeleteCurrentPushSubscription(context.Background(), identity); err != nil {
		t.Fatal(err)
	}
	if repository.pushUserID != identity.UserID || repository.pushDeviceID.String() != identity.DeviceID || repository.pushSessionVersion != identity.SessionVersion || repository.pushBrowserID != identity.BrowserID || repository.pushGeneration != identity.BrowserGeneration {
		t.Fatal("delete not scoped to authenticated identity")
	}
	for _, invalid := range []sharedauth.Identity{{}, {UserID: identity.UserID, DeviceID: "bad", SessionVersion: 1, BrowserID: identity.BrowserID, BrowserGeneration: identity.BrowserGeneration}, {UserID: identity.UserID, DeviceID: identity.DeviceID}, {UserID: identity.UserID, DeviceID: identity.DeviceID, SessionVersion: 3, BrowserID: identity.BrowserID}, {UserID: identity.UserID, DeviceID: identity.DeviceID, SessionVersion: 3, BrowserGeneration: identity.BrowserGeneration}} {
		if err := service.DeleteCurrentPushSubscription(context.Background(), invalid); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("invalid identity error = %v", err)
		}
	}
}

func TestVerifyPushSubscriptionValidatesAndScopesIdentity(t *testing.T) {
	repository := &fakeRepository{}
	service := NewService(repository, fakePasswords{}, fakeTokens{}, time.Minute, time.Hour)
	identity := sharedauth.Identity{UserID: uuid.New(), DeviceID: uuid.NewString(), SessionVersion: 4}
	sub := PushSubscription{Endpoint: "https://fcm.googleapis.com/send/token", P256DH: base64.RawURLEncoding.EncodeToString(append([]byte{4}, make([]byte, 64)...)), Auth: base64.RawURLEncoding.EncodeToString(make([]byte, 16))}
	matched, err := service.VerifyPushSubscription(context.Background(), identity, sub)
	if err != nil || !matched || repository.pushUserID != identity.UserID || repository.pushDeviceID.String() != identity.DeviceID || repository.pushSessionVersion != identity.SessionVersion || repository.pushSubscription != sub {
		t.Fatal("verification did not use the authenticated identity and subscription")
	}
	if _, err := service.VerifyPushSubscription(context.Background(), sharedauth.Identity{}, sub); !errors.Is(err, ErrInvalidInput) {
		t.Fatal("invalid identity accepted")
	}
	sub.Auth = "bad"
	if _, err := service.VerifyPushSubscription(context.Background(), identity, sub); !errors.Is(err, ErrInvalidInput) {
		t.Fatal("invalid subscription accepted")
	}
}

func TestUpdateProfilePersistsExplicitFalseAutoLoadValue(t *testing.T) {
	repository := &fakeRepository{profile: user.Profile{AutoLoadApprovedMedia: true}}
	service := NewService(repository, fakePasswords{}, fakeTokens{}, 15*time.Minute, time.Hour)
	falseValue := false
	profile, err := service.UpdateProfile(context.Background(), uuid.New(), nil, nil, nil, &falseValue)
	if err != nil {
		t.Fatal(err)
	}
	if repository.updatedAutoLoad == nil || *repository.updatedAutoLoad {
		t.Fatalf("auto-load update = %v, want explicit false", repository.updatedAutoLoad)
	}
	if profile.AutoLoadApprovedMedia {
		t.Fatal("returned profile still enables automatic media loading")
	}
}

func TestAdminGiphySettingRequiresAdminAndPersistsChanges(t *testing.T) {
	repository := &fakeRepository{isAdmin: true, giphyEnabled: true}
	service := NewAdminService(repository, nil, nil, "", "")
	adminID := uuid.New()
	enabled, err := service.SetGiphyEnabled(context.Background(), adminID, false)
	if err != nil {
		t.Fatal(err)
	}
	if enabled {
		t.Fatal("mutation returned enabled although persistence returned disabled")
	}

	repository.isAdmin = false
	if _, err := service.SetGiphyEnabled(context.Background(), adminID, true); !errors.Is(err, ErrNotAdmin) {
		t.Fatalf("non-admin update error = %v, want %v", err, ErrNotAdmin)
	}
}

func TestAdminGiphyMutationReturnsPersistedValueWhenConcurrentWriterWins(t *testing.T) {
	persisted := false
	repository := &fakeRepository{isAdmin: true, giphyEnabled: true, giphyPersistedResult: &persisted}
	service := NewAdminService(repository, nil, nil, "", "")
	enabled, err := service.SetGiphyEnabled(context.Background(), uuid.New(), true)
	if err != nil {
		t.Fatal(err)
	}
	if enabled {
		t.Fatal("mutation returned request value; expected canonical persisted value")
	}
}

func TestUpdateProfileAcceptsAlertModeAndLeavesOmittedFieldsUntouched(t *testing.T) {
	repository := &fakeRepository{profile: user.Profile{AlertMode: "sounds"}}
	service := NewService(repository, fakePasswords{}, fakeTokens{}, 15*time.Minute, time.Hour)
	mode := "notifications"
	profile, err := service.UpdateProfile(context.Background(), uuid.New(), nil, nil, &mode, nil)
	if err != nil {
		t.Fatalf("UpdateProfile() error = %v", err)
	}
	if profile.AlertMode != "sounds" {
		t.Fatalf("profile alert mode = %q", profile.AlertMode)
	}
	if repository.profileDisplayName != nil || repository.profileRetention != nil || repository.profileAlertMode != &mode {
		t.Fatalf("updated fields = display %v, retention %v, alert %v", repository.profileDisplayName, repository.profileRetention, repository.profileAlertMode)
	}
}

func TestUpdateProfileRejectsUnsupportedAlertMode(t *testing.T) {
	repository := &fakeRepository{}
	service := NewService(repository, fakePasswords{}, fakeTokens{}, 15*time.Minute, time.Hour)
	mode := "all"
	if _, err := service.UpdateProfile(context.Background(), uuid.New(), nil, nil, &mode, nil); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("UpdateProfile() error = %v, want ErrInvalidInput", err)
	}
	if repository.profileAlertMode != nil {
		t.Fatal("repository updated for invalid alert mode")
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
	profile              user.Profile
	updatedAutoLoad      *bool
	giphyEnabled         bool
	giphyPersistedResult *bool
	profileDisplayName   *string
	profileRetention     *string
	profileAlertMode     *string
	account              user.User
	deviceID             uuid.UUID
	userID               uuid.UUID
	params               CreateUserParams
	isAdmin              bool
	prepareEmail         string
	prepareDisplayName   string
	prepareVerified      bool
	resendEmail          string
	resendDisplayName    string
	resendHash           []byte
	resendExpiresAt      time.Time
	invitation           user.Invitation
	pushUserID           uuid.UUID
	pushBrowserID        uuid.UUID
	pushGeneration       uuid.UUID
	pushDeviceID         uuid.UUID
	pushSessionVersion   int64
	pushSubscription     PushSubscription
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
func (f *fakeRepository) RotateRefreshToken(context.Context, []byte, []byte, time.Time, func(user.Session) error) error {
	return errors.New("not implemented")
}
func (f *fakeRepository) RevokeAllSessions(context.Context, uuid.UUID) error { return nil }
func (f *fakeRepository) RefreshTokenOwner(context.Context, []byte) (uuid.UUID, error) {
	return uuid.Nil, nil
}
func (f *fakeRepository) StorePushSubscription(_ context.Context, userID, deviceID uuid.UUID, sessionVersion int64, browserID, generation uuid.UUID, subscription PushSubscription) error {
	f.pushBrowserID, f.pushGeneration = browserID, generation
	f.pushUserID, f.pushDeviceID, f.pushSessionVersion, f.pushSubscription = userID, deviceID, sessionVersion, subscription
	return nil
}
func (f *fakeRepository) DeletePushSubscription(context.Context, uuid.UUID, uuid.UUID, int64, uuid.UUID, uuid.UUID, string) error {
	return nil
}

func (f *fakeRepository) DeleteCurrentPushSubscription(_ context.Context, userID, deviceID uuid.UUID, sessionVersion int64, browserID, generation uuid.UUID) error {
	f.pushUserID, f.pushDeviceID, f.pushSessionVersion = userID, deviceID, sessionVersion
	f.pushBrowserID, f.pushGeneration = browserID, generation
	return nil
}

func (f *fakeRepository) VerifyPushSubscription(_ context.Context, userID, deviceID uuid.UUID, sessionVersion int64, subscription PushSubscription) (bool, error) {
	f.pushUserID, f.pushDeviceID, f.pushSessionVersion, f.pushSubscription = userID, deviceID, sessionVersion, subscription
	return true, nil
}
func (f *fakeRepository) Profile(context.Context, uuid.UUID) (user.Profile, error) {
	return f.profile, nil
}
func (f *fakeRepository) UpdateProfile(_ context.Context, _ uuid.UUID, displayName, retention, alertMode *string, autoLoad *bool) error {
	f.profileDisplayName, f.profileRetention, f.profileAlertMode = displayName, retention, alertMode
	if autoLoad != nil {
		value := *autoLoad
		f.updatedAutoLoad = &value
		f.profile.AutoLoadApprovedMedia = value
	}
	return nil
}
func (f *fakeRepository) GiphyEnabled(context.Context) (bool, error) { return f.giphyEnabled, nil }
func (f *fakeRepository) SetGiphyEnabled(_ context.Context, enabled bool) (bool, error) {
	f.giphyEnabled = enabled
	if f.giphyPersistedResult != nil {
		f.giphyEnabled = *f.giphyPersistedResult
		return f.giphyEnabled, nil
	}
	return enabled, nil
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
