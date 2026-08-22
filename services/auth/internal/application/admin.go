package application

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/KovalMax/zwei/services/auth/internal/domain/user"
)

var (
	ErrNotAdmin          = errors.New("administrator access required")
	ErrAdminTarget       = errors.New("invalid administrator target")
	ErrInvitationInvalid = errors.New("invalid invitation")
)

type AdminService struct {
	repository     Repository
	passwords      PasswordHasher
	email          EmailSender
	activationURL  string
	invitationURL  string
	activationLife time.Duration
	invitationLife time.Duration
	clock          func() time.Time
}

func NewAdminService(repository Repository, passwords PasswordHasher, email EmailSender, activationURL, invitationURL string) *AdminService {
	return &AdminService{
		repository:     repository,
		passwords:      passwords,
		email:          email,
		activationURL:  strings.TrimRight(activationURL, "/"),
		invitationURL:  strings.TrimRight(invitationURL, "/"),
		activationLife: 72 * time.Hour,
		invitationLife: 7 * 24 * time.Hour,
		clock:          time.Now,
	}
}

func (s *AdminService) IsAdmin(ctx context.Context, userID uuid.UUID) (bool, error) {
	return s.repository.IsAdmin(ctx, userID)
}

func (s *AdminService) ListUsers(ctx context.Context, adminID uuid.UUID) ([]user.AdminUser, error) {
	if err := s.requireAdmin(ctx, adminID); err != nil {
		return nil, err
	}
	return s.repository.ListAdminUsers(ctx)
}

func (s *AdminService) ActivateUser(ctx context.Context, adminID, targetID uuid.UUID) error {
	if err := s.requireAdmin(ctx, adminID); err != nil {
		return err
	}
	if targetID == adminID {
		return ErrAdminTarget
	}
	token, tokenHash, err := activationToken()
	if err != nil {
		return err
	}
	email, displayName, verified, err := s.repository.PrepareActivation(ctx, targetID, tokenHash, s.clock().Add(s.activationLife))
	if err != nil {
		return err
	}
	if verified {
		return nil
	}
	return s.sendActivationEmail(ctx, email, displayName, token)
}

func (s *AdminService) ResendActivation(ctx context.Context, adminID, targetID uuid.UUID) error {
	if err := s.requireAdmin(ctx, adminID); err != nil {
		return err
	}
	if targetID == adminID {
		return ErrAdminTarget
	}
	token, tokenHash, err := activationToken()
	if err != nil {
		return err
	}
	email, displayName, err := s.repository.PrepareActivationEmail(ctx, targetID, tokenHash, s.clock().Add(s.activationLife))
	if err != nil {
		return err
	}
	return s.sendActivationEmail(ctx, email, displayName, token)
}

func (s *AdminService) BlockUser(ctx context.Context, adminID, targetID uuid.UUID) error {
	if err := s.requireAdmin(ctx, adminID); err != nil {
		return err
	}
	if targetID == adminID {
		return ErrAdminTarget
	}
	return s.repository.SetKYCStatus(ctx, targetID, user.KYCBlocked)
}

func (s *AdminService) VerifyActivation(ctx context.Context, token string) error {
	if strings.TrimSpace(token) == "" {
		return ErrInvitationInvalid
	}
	hash := sha256.Sum256([]byte(token))
	if err := s.repository.VerifyActivation(ctx, hash[:], s.clock()); err != nil {
		return ErrInvitationInvalid
	}
	return nil
}

func (s *AdminService) CreateInvitation(ctx context.Context, adminID uuid.UUID, email string) (string, user.Invitation, error) {
	if err := s.requireAdmin(ctx, adminID); err != nil {
		return "", user.Invitation{}, err
	}
	email = strings.ToLower(strings.TrimSpace(email))
	if !validEmail(email) {
		return "", user.Invitation{}, ErrInvalidInput
	}
	codeBytes := make([]byte, 24)
	if _, err := rand.Read(codeBytes); err != nil {
		return "", user.Invitation{}, err
	}
	code := base64.RawURLEncoding.EncodeToString(codeBytes)
	hash := sha256.Sum256([]byte(code))
	invitation, err := s.repository.CreateInvitation(ctx, email, hash[:], adminID, s.clock().Add(s.invitationLife))
	if err != nil {
		return "", user.Invitation{}, err
	}
	link := s.invitationURL + "?invite=1&code=" + url.QueryEscape(code)
	if err := s.email.SendInvitation(ctx, email, link); err != nil {
		return "", user.Invitation{}, err
	}
	return code, invitation, nil
}

func (s *AdminService) ListInvitations(ctx context.Context, adminID uuid.UUID) ([]user.Invitation, error) {
	if err := s.requireAdmin(ctx, adminID); err != nil {
		return nil, err
	}
	return s.repository.ListInvitations(ctx)
}

func (s *AdminService) RevokeInvitation(ctx context.Context, adminID, invitationID uuid.UUID) error {
	if err := s.requireAdmin(ctx, adminID); err != nil {
		return err
	}
	return s.repository.RevokeInvitation(ctx, invitationID)
}

func (s *AdminService) CreateAdmin(ctx context.Context, email, password, displayName string) error {
	if !validLogin(email, password, "cli-device") || strings.TrimSpace(displayName) == "" {
		return ErrInvalidInput
	}
	hash, err := s.passwords.Hash(password)
	if err != nil {
		return err
	}
	return s.repository.CreateAdmin(ctx, strings.ToLower(strings.TrimSpace(email)), hash, strings.TrimSpace(displayName))
}

func (s *AdminService) requireAdmin(ctx context.Context, userID uuid.UUID) error {
	isAdmin, err := s.repository.IsAdmin(ctx, userID)
	if err != nil {
		return err
	}
	if !isAdmin {
		return ErrNotAdmin
	}
	return nil
}

func (s *AdminService) sendActivationEmail(ctx context.Context, email, displayName, token string) error {
	return s.email.SendActivation(ctx, email, displayName, s.activationURL+"?token="+token)
}

func activationToken() (string, []byte, error) {
	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		return "", nil, err
	}
	token := base64.RawURLEncoding.EncodeToString(tokenBytes)
	hash := sha256.Sum256([]byte(token))
	return token, hash[:], nil
}
