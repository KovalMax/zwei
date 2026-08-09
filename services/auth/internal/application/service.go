package application

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/KovalMax/zwei/services/auth/internal/domain/user"
	sharedauth "github.com/KovalMax/zwei/services/shared/auth"
)

var (
	ErrInvalidInput = errors.New("invalid input")
	ErrCredentials  = errors.New("invalid credentials")
	ErrRefreshToken = errors.New("invalid refresh token")
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

type Credentials struct{ Email, Password, DisplayName, DeviceID, DeviceName string }
type Tokens struct {
	AccessToken  string `json:"access_token"`
	TokenType    string `json:"token_type"`
	ExpiresIn    int64  `json:"expires_in"`
	RefreshToken string `json:"refresh_token,omitempty"`
}

func (s *Service) Register(ctx context.Context, input Credentials) (Tokens, error) {
	if !validCredentials(input.Email, input.Password, input.DisplayName, input.DeviceID) {
		return Tokens{}, ErrInvalidInput
	}
	hash, err := s.passwords.Hash(input.Password)
	if err != nil {
		return Tokens{}, err
	}
	userID, deviceID, err := s.repository.CreateUserWithDevice(ctx, normalizeEmail(input.Email), hash, strings.TrimSpace(input.DisplayName), input.DeviceID, input.DeviceName)
	if err != nil {
		return Tokens{}, err
	}
	return s.issueTokens(ctx, userID, deviceID, 1)
}

func (s *Service) Login(ctx context.Context, input Credentials) (Tokens, error) {
	if !validLogin(input.Email, input.Password, input.DeviceID) {
		return Tokens{}, ErrInvalidInput
	}
	account, err := s.repository.FindUserByEmail(ctx, normalizeEmail(input.Email))
	if err != nil || s.passwords.Compare(account.PasswordHash, input.Password) != nil {
		return Tokens{}, ErrCredentials
	}
	deviceID, err := s.repository.EnsureDevice(ctx, account.ID, input.DeviceID, input.DeviceName)
	if err != nil {
		return Tokens{}, err
	}
	return s.issueTokens(ctx, account.ID, deviceID, account.SessionVersion)
}

func (s *Service) Refresh(ctx context.Context, refreshToken string) (Tokens, error) {
	if refreshToken == "" {
		return Tokens{}, ErrInvalidInput
	}
	hash := sha256.Sum256([]byte(refreshToken))
	session, err := s.repository.RotateRefreshToken(ctx, hash[:])
	if err != nil {
		return Tokens{}, ErrRefreshToken
	}
	return s.issueTokens(ctx, session.UserID, session.DeviceID, session.SessionVersion)
}

func (s *Service) Logout(ctx context.Context, userID uuid.UUID) error {
	return s.repository.RevokeAllSessions(ctx, userID)
}
func (s *Service) Profile(ctx context.Context, userID uuid.UUID) (user.Profile, error) {
	return s.repository.Profile(ctx, userID)
}

func (s *Service) UpdateProfile(ctx context.Context, userID uuid.UUID, displayName, retention *string) (user.Profile, error) {
	if displayName == nil && retention == nil {
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
	if err := s.repository.UpdateProfile(ctx, userID, displayName, retention); err != nil {
		return user.Profile{}, err
	}
	return s.repository.Profile(ctx, userID)
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
	return strings.Contains(email, "@") && len(password) >= 8 && strings.TrimSpace(displayName) != "" && len(strings.TrimSpace(deviceID)) >= 8
}
func validLogin(email, password, deviceID string) bool {
	return strings.Contains(email, "@") && len(password) >= 8 && len(strings.TrimSpace(deviceID)) >= 8
}
func normalizeEmail(email string) string { return strings.ToLower(strings.TrimSpace(email)) }
