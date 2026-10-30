package application

import (
	"context"
	"encoding/base64"
	"errors"
	"net/mail"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/KovalMax/zwei/services/auth/internal/domain/user"
	sharedauth "github.com/KovalMax/zwei/services/shared/auth"
)

var (
	ErrInvalidInput          = errors.New("invalid input")
	ErrCredentials           = errors.New("invalid credentials")
	ErrRefreshToken          = errors.New("invalid refresh token")
	ErrAccountInactive       = errors.New("account is not active")
	ErrPushUnavailable       = errors.New("push subscription unavailable")
	ErrPushSessionRevoked    = errors.New("push subscription session revoked")
	ErrPushSubscriptionOwned = errors.New("push subscription already owned")
	ErrPushSubscriptionLimit = errors.New("push subscription device limit reached")
)

type Service struct {
	repository Repository
	passwords  PasswordHasher
	tokens     TokenIssuer
}

func NewService(repository Repository, passwords PasswordHasher, tokens TokenIssuer, accessLifetime, refreshLifetime time.Duration) *Service {
	return &Service{repository: repository, passwords: passwords, tokens: tokens}
}

type Credentials struct {
	Email, Password, DisplayName, DeviceID, DeviceName string
	InvitationCode                                     string
}
type Tokens struct {
	AccessToken  string `json:"access_token"`
	TokenType    string `json:"token_type"`
	ExpiresIn    int64  `json:"expires_in"`
	RefreshToken string `json:"refresh_token,omitempty"`
}

func (s *Service) registerPending(ctx context.Context, input Credentials) error {
	if !validCredentials(input.Email, input.Password, input.DisplayName, input.DeviceID) {
		return ErrInvalidInput
	}
	hash, err := s.passwords.Hash(input.Password)
	if err != nil {
		return err
	}
	_, _, err = s.repository.CreateUserWithDevice(ctx, CreateUserParams{
		Email:          normalizeEmail(input.Email),
		PasswordHash:   hash,
		DisplayName:    strings.TrimSpace(input.DisplayName),
		ClientDeviceID: input.DeviceID,
		DeviceName:     input.DeviceName,
		KYCStatus:      user.KYCPending,
	})
	return err
}

// AuthenticateBrowserLogin validates credentials and resolves the account's device
// without creating a legacy refresh session or issuing tokens.
func (s *Service) AuthenticateBrowserLogin(ctx context.Context, input Credentials) (BrowserSessionTarget, error) {
	if !validLogin(input.Email, input.Password, input.DeviceID) {
		return BrowserSessionTarget{}, ErrInvalidInput
	}
	account, err := s.repository.FindUserByEmail(ctx, normalizeEmail(input.Email))
	if err != nil || s.passwords.Compare(account.PasswordHash, input.Password) != nil {
		return BrowserSessionTarget{}, ErrCredentials
	}
	if account.KYCStatus != user.KYCActive || !account.EmailVerified {
		return BrowserSessionTarget{}, ErrAccountInactive
	}
	deviceID, err := s.repository.EnsureDevice(ctx, account.ID, input.DeviceID, input.DeviceName)
	if err != nil {
		return BrowserSessionTarget{}, err
	}
	return BrowserSessionTarget{UserID: account.ID, DeviceID: deviceID, SessionVersion: account.SessionVersion}, nil
}

// MaxRefreshCandidates bounds work performed on untrusted cookie input.
const MaxRefreshCandidates = 16

func (s *Service) StorePushSubscription(ctx context.Context, identity sharedauth.Identity, subscription PushSubscription) error {
	if identity.UserID == uuid.Nil || identity.SessionVersion <= 0 || identity.DeviceID == "" || identity.BrowserID == uuid.Nil || identity.BrowserGeneration == uuid.Nil || !validPushSubscription(subscription) {
		return ErrInvalidInput
	}
	deviceID, err := uuid.Parse(identity.DeviceID)
	if err != nil || deviceID == uuid.Nil {
		return ErrInvalidInput
	}
	return s.repository.StorePushSubscription(ctx, identity.UserID, deviceID, identity.SessionVersion, identity.BrowserID, identity.BrowserGeneration, subscription)
}

func (s *Service) VerifyPushSubscription(ctx context.Context, identity sharedauth.Identity, subscription PushSubscription) (bool, error) {
	if identity.UserID == uuid.Nil || identity.SessionVersion <= 0 || !validPushSubscription(subscription) {
		return false, ErrInvalidInput
	}
	deviceID, err := uuid.Parse(identity.DeviceID)
	if err != nil || deviceID == uuid.Nil {
		return false, ErrInvalidInput
	}
	return s.repository.VerifyPushSubscription(ctx, identity.UserID, deviceID, identity.SessionVersion, subscription)
}

func (s *Service) DeletePushSubscription(ctx context.Context, identity sharedauth.Identity, endpoint string) error {
	if identity.UserID == uuid.Nil || identity.SessionVersion <= 0 || identity.DeviceID == "" || identity.BrowserID == uuid.Nil || identity.BrowserGeneration == uuid.Nil || !validPushEndpoint(endpoint) {
		return ErrInvalidInput
	}
	deviceID, err := uuid.Parse(identity.DeviceID)
	if err != nil || deviceID == uuid.Nil {
		return ErrInvalidInput
	}
	return s.repository.DeletePushSubscription(ctx, identity.UserID, deviceID, identity.SessionVersion, identity.BrowserID, identity.BrowserGeneration, endpoint)
}

// DeleteCurrentPushSubscription removes only the authenticated device's registration.
func (s *Service) DeleteCurrentPushSubscription(ctx context.Context, identity sharedauth.Identity) error {
	if identity.UserID == uuid.Nil || identity.SessionVersion <= 0 || identity.BrowserID == uuid.Nil || identity.BrowserGeneration == uuid.Nil {
		return ErrInvalidInput
	}
	deviceID, err := uuid.Parse(identity.DeviceID)
	if err != nil || deviceID == uuid.Nil {
		return ErrInvalidInput
	}
	return s.repository.DeleteCurrentPushSubscription(ctx, identity.UserID, deviceID, identity.SessionVersion, identity.BrowserID, identity.BrowserGeneration)
}

func validPushSubscription(subscription PushSubscription) bool {
	if len(subscription.P256DH) == 0 || len(subscription.P256DH) > 128 || len(subscription.Auth) == 0 || len(subscription.Auth) > 64 || !validPushEndpoint(subscription.Endpoint) {
		return false
	}
	publicKey, publicErr := base64.RawURLEncoding.DecodeString(subscription.P256DH)
	authSecret, authErr := base64.RawURLEncoding.DecodeString(subscription.Auth)
	return publicErr == nil && len(publicKey) == 65 && publicKey[0] == 4 && authErr == nil && len(authSecret) == 16
}

func validPushEndpoint(raw string) bool {
	if len(raw) == 0 || len(raw) > 2048 {
		return false
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.User != nil || parsed.Fragment != "" || parsed.Hostname() == "" || parsed.Port() != "" && parsed.Port() != "443" {
		return false
	}
	switch strings.ToLower(parsed.Hostname()) {
	case "fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com":
		return true
	default:
		return false
	}
}
func (s *Service) Profile(ctx context.Context, userID uuid.UUID) (user.Profile, error) {
	return s.repository.Profile(ctx, userID)
}

func (s *Service) UpdateProfile(ctx context.Context, userID uuid.UUID, displayName, retention, alertMode *string, autoLoadApprovedMedia *bool) (user.Profile, error) {
	if displayName == nil && retention == nil && alertMode == nil && autoLoadApprovedMedia == nil {
		return user.Profile{}, ErrInvalidInput
	}
	if displayName != nil {
		name, valid := user.NormalizeDisplayName(*displayName)
		if !valid {
			return user.Profile{}, ErrInvalidInput
		}
		displayName = &name
	}
	if retention != nil && !user.ValidRetention(*retention) {
		return user.Profile{}, ErrInvalidInput
	}
	if alertMode != nil && !user.ValidAlertMode(*alertMode) {
		return user.Profile{}, ErrInvalidInput
	}
	if err := s.repository.UpdateProfile(ctx, userID, displayName, retention, alertMode, autoLoadApprovedMedia); err != nil {
		return user.Profile{}, err
	}
	return s.repository.Profile(ctx, userID)
}

func (s *Service) MediaPolicy(ctx context.Context) (bool, error) {
	return s.repository.GiphyEnabled(ctx)
}

func (s *Service) WebSocketTicket(identity sharedauth.Identity) (string, error) {
	return s.tokens.IssueWebSocketTicket(identity, 30*time.Second)
}

func validCredentials(email, password, displayName, deviceID string) bool {
	return validEmail(email) && len(password) >= 8 && strings.TrimSpace(displayName) != "" && len(strings.TrimSpace(deviceID)) >= 8
}
func validLogin(email, password, deviceID string) bool {
	return validEmail(email) && len(password) >= 8 && len(strings.TrimSpace(deviceID)) >= 8
}
func normalizeEmail(email string) string { return strings.ToLower(strings.TrimSpace(email)) }

func validEmail(value string) bool {
	email := normalizeEmail(value)
	if len(email) == 0 || len(email) > 180 || strings.ContainsAny(email, "\r\n") {
		return false
	}
	parsed, err := mail.ParseAddress(email)
	return err == nil && parsed.Address == email
}
