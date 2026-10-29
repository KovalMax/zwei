package application

import (
	"context"
	"crypto/sha256"
	"strings"
	"time"

	"github.com/KovalMax/zwei/services/auth/internal/domain/user"
	"github.com/google/uuid"
)

// BrowserRegistrationRepository commits the invitation, account, device and
// browser head together, including access-token issuance.
type BrowserRegistrationRepository interface {
	RegisterBrowserInvitation(context.Context, CreateUserParams, *BrowserCredential, uuid.UUID, uuid.UUID, []byte, time.Time, func(user.Session) error) error
}

type BrowserRegistration struct {
	auth       *Service
	sessions   *BrowserSessions
	repository BrowserRegistrationRepository
}

func NewBrowserRegistration(auth *Service, sessions *BrowserSessions, repository BrowserRegistrationRepository) *BrowserRegistration {
	return &BrowserRegistration{auth: auth, sessions: sessions, repository: repository}
}

func (s *BrowserRegistration) Register(ctx context.Context, input Credentials, current *BrowserCredential) (bool, BrowserSessionResult, error) {
	if !validCredentials(input.Email, input.Password, input.DisplayName, input.DeviceID) {
		return false, BrowserSessionResult{}, ErrInvalidInput
	}
	if strings.TrimSpace(input.InvitationCode) == "" {
		result, err := s.auth.Register(ctx, input)
		return result.Pending, BrowserSessionResult{}, err
	}
	if current != nil && !validBrowserCredential(*current) {
		return false, BrowserSessionResult{}, ErrInvalidInput
	}
	password, err := s.auth.passwords.Hash(input.Password)
	if err != nil {
		return false, BrowserSessionResult{}, err
	}
	browser, err := uuid.NewRandom()
	if err != nil {
		return false, BrowserSessionResult{}, err
	}
	if current != nil {
		browser = current.BrowserID
	}
	generation, err := uuid.NewRandom()
	if err != nil {
		return false, BrowserSessionResult{}, err
	}
	refresh, hash, err := browserRefresh()
	if err != nil {
		return false, BrowserSessionResult{}, err
	}
	invite := sha256.Sum256([]byte(strings.TrimSpace(input.InvitationCode)))
	params := CreateUserParams{Email: normalizeEmail(input.Email), PasswordHash: password, DisplayName: strings.TrimSpace(input.DisplayName), ClientDeviceID: input.DeviceID, DeviceName: input.DeviceName, KYCStatus: user.KYCActive, EmailVerified: true, InvitationCode: invite[:]}
	var access string
	err = s.repository.RegisterBrowserInvitation(ctx, params, current, browser, generation, hash[:], s.sessions.clock().Add(s.sessions.refreshLifetime), func(session user.Session) error { return s.sessions.issue(session, browser, generation, &access) })
	if err != nil {
		return false, BrowserSessionResult{}, err
	}
	return false, s.sessions.result(browser, generation, refresh, access), nil
}
