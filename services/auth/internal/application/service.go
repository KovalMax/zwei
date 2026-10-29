package application

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
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
	ErrLogoutCookieMismatch  = errors.New("logout cookie mismatch")
	ErrAccountInactive       = errors.New("account is not active")
	ErrPushUnavailable       = errors.New("push subscription unavailable")
	ErrPushSessionRevoked    = errors.New("push subscription session revoked")
	ErrPushSubscriptionOwned = errors.New("push subscription already owned")
	ErrPushSubscriptionLimit = errors.New("push subscription device limit reached")
)

type Service struct {
	repository      Repository
	passwords       PasswordHasher
	tokens          TokenIssuer
	accessLifetime  time.Duration
	refreshLifetime time.Duration
	clock           func() time.Time
}

func NewService(repository Repository, passwords PasswordHasher, tokens TokenIssuer, accessLifetime, refreshLifetime time.Duration) *Service {
	return &Service{repository: repository, passwords: passwords, tokens: tokens, accessLifetime: accessLifetime, refreshLifetime: refreshLifetime, clock: time.Now}
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

type RegistrationResult struct {
	Tokens  Tokens
	Pending bool
}

func (s *Service) Register(ctx context.Context, input Credentials) (RegistrationResult, error) {
	if !validCredentials(input.Email, input.Password, input.DisplayName, input.DeviceID) {
		return RegistrationResult{}, ErrInvalidInput
	}
	hash, err := s.passwords.Hash(input.Password)
	if err != nil {
		return RegistrationResult{}, err
	}
	status := user.KYCPending
	verified := false
	var invitationHash []byte
	if strings.TrimSpace(input.InvitationCode) != "" {
		status = user.KYCActive
		verified = true
		hash := sha256.Sum256([]byte(strings.TrimSpace(input.InvitationCode)))
		invitationHash = hash[:]
	}
	userID, deviceID, err := s.repository.CreateUserWithDevice(ctx, CreateUserParams{
		Email:          normalizeEmail(input.Email),
		PasswordHash:   hash,
		DisplayName:    strings.TrimSpace(input.DisplayName),
		ClientDeviceID: input.DeviceID,
		DeviceName:     input.DeviceName,
		KYCStatus:      status,
		EmailVerified:  verified,
		InvitationCode: invitationHash,
	})
	if err != nil {
		return RegistrationResult{}, err
	}
	if !verified {
		return RegistrationResult{Pending: true}, nil
	}
	tokens, err := s.issueTokens(ctx, userID, deviceID, 1)
	return RegistrationResult{Tokens: tokens}, err
}

func (s *Service) Login(ctx context.Context, input Credentials) (Tokens, error) {
	target, err := s.AuthenticateBrowserLogin(ctx, input)
	if err != nil {
		return Tokens{}, err
	}
	return s.issueTokens(ctx, target.UserID, target.DeviceID, target.SessionVersion)
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

func (s *Service) Refresh(ctx context.Context, refreshToken string) (Tokens, error) {
	if refreshToken == "" {
		return Tokens{}, ErrInvalidInput
	}
	hash := sha256.Sum256([]byte(refreshToken))
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		return Tokens{}, err
	}
	nextToken := base64.RawURLEncoding.EncodeToString(bytes)
	nextHash := sha256.Sum256([]byte(nextToken))
	var accessToken string
	err := s.repository.RotateRefreshToken(ctx, hash[:], nextHash[:], s.clock().Add(s.refreshLifetime), func(session user.Session) error {
		var err error
		accessToken, err = s.tokens.IssueAccess(sharedauth.Identity{UserID: session.UserID, SessionVersion: session.SessionVersion, DeviceID: session.DeviceID.String()}, s.accessLifetime)
		return err
	})
	if err != nil {
		return Tokens{}, err
	}
	return Tokens{AccessToken: accessToken, TokenType: "Bearer", ExpiresIn: int64(s.accessLifetime.Seconds()), RefreshToken: nextToken}, nil
}

// MaxRefreshCandidates bounds work performed on untrusted cookie input.
const MaxRefreshCandidates = 16

// RefreshCandidates rotates one live session only when all live candidates
// belong to the same account. Duplicates are the same credential.
func (s *Service) RefreshCandidates(ctx context.Context, refreshTokens []string) (Tokens, error) {
	tokens, _, err := s.RefreshCandidatesSelected(ctx, refreshTokens)
	return tokens, err
}

// RefreshCandidatesSelected also returns the selected input index for transport cleanup.
func (s *Service) RefreshCandidatesSelected(ctx context.Context, refreshTokens []string) (Tokens, int, error) {
	if len(refreshTokens) == 0 || len(refreshTokens) > MaxRefreshCandidates {
		return Tokens{}, -1, ErrInvalidInput
	}
	hashes := make([][]byte, 0, len(refreshTokens))
	seen := make(map[[32]byte]struct{}, len(refreshTokens))
	for _, value := range refreshTokens {
		if value == "" || len(value) > 4096 {
			return Tokens{}, -1, ErrInvalidInput
		}
		hash := sha256.Sum256([]byte(value))
		if _, ok := seen[hash]; ok {
			continue
		}
		seen[hash] = struct{}{}
		hashes = append(hashes, hash[:])
	}
	random := make([]byte, 32)
	if _, err := rand.Read(random); err != nil {
		return Tokens{}, -1, err
	}
	nextToken := base64.RawURLEncoding.EncodeToString(random)
	nextHash := sha256.Sum256([]byte(nextToken))
	var accessToken string
	selected := -1
	err := s.repository.RotateRefreshCandidates(ctx, hashes, nextHash[:], s.clock().Add(s.refreshLifetime), func(session user.Session, selectedHash []byte) error {
		for i, value := range refreshTokens {
			hash := sha256.Sum256([]byte(value))
			if bytes.Equal(hash[:], selectedHash) {
				selected = i
				break
			}
		}
		if selected < 0 {
			return ErrRefreshToken
		}
		var err error
		accessToken, err = s.tokens.IssueAccess(sharedauth.Identity{UserID: session.UserID, SessionVersion: session.SessionVersion, DeviceID: session.DeviceID.String()}, s.accessLifetime)
		return err
	})
	if err != nil {
		return Tokens{}, -1, err
	}
	if selected < 0 {
		return Tokens{}, -1, ErrRefreshToken
	}
	return Tokens{AccessToken: accessToken, TokenType: "Bearer", ExpiresIn: int64(s.accessLifetime.Seconds()), RefreshToken: nextToken}, selected, nil
}

func (s *Service) Logout(ctx context.Context, userID uuid.UUID) error {
	return s.repository.RevokeAllSessions(ctx, userID)
}

// CheckLogoutCookie refuses to clear a cookie whose ownership cannot be proven.
// Historical sessions are included so rotated or expired cookies retain ownership.
func (s *Service) CheckLogoutCookie(ctx context.Context, userID uuid.UUID, refreshToken string) error {
	if refreshToken == "" {
		return nil
	}
	hash := sha256.Sum256([]byte(refreshToken))
	owner, err := s.repository.RefreshTokenOwner(ctx, hash[:])
	if err != nil {
		return err
	}
	if owner != userID {
		return ErrLogoutCookieMismatch
	}
	return nil
}

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

func (s *Service) issueTokens(ctx context.Context, userID, deviceID uuid.UUID, version int64) (Tokens, error) {
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		return Tokens{}, err
	}
	refreshToken := base64.RawURLEncoding.EncodeToString(bytes)
	hash := sha256.Sum256([]byte(refreshToken))
	if err := s.repository.CreateSession(ctx, userID, deviceID, hash[:], version, s.clock().Add(s.refreshLifetime)); err != nil {
		return Tokens{}, err
	}
	accessToken, err := s.tokens.IssueAccess(sharedauth.Identity{UserID: userID, SessionVersion: version, DeviceID: deviceID.String()}, s.accessLifetime)
	if err != nil {
		return Tokens{}, err
	}
	return Tokens{AccessToken: accessToken, TokenType: "Bearer", ExpiresIn: int64(s.accessLifetime.Seconds()), RefreshToken: refreshToken}, nil
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
