package application

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"time"

	"github.com/KovalMax/zwei/services/auth/internal/domain/user"
	sharedauth "github.com/KovalMax/zwei/services/shared/auth"
	"github.com/google/uuid"
)

// BrowserSessionRepository owns atomic credential validation, session mutation,
// and issuance callback execution within the same transaction. An error from
// the callback or commit must leave the previous head unchanged.
type BrowserSessionRepository interface {
	CreateBrowserSession(context.Context, uuid.UUID, uuid.UUID, uuid.UUID, uuid.UUID, []byte, int64, time.Time, func(user.Session) error) error
	ReplaceBrowserSession(context.Context, uuid.UUID, uuid.UUID, []byte, uuid.UUID, uuid.UUID, uuid.UUID, []byte, int64, time.Time, func(user.Session) error) error
	RotateBrowserSession(context.Context, uuid.UUID, uuid.UUID, []byte, []byte, time.Time, func(user.Session) error) error
	LogoutBrowserSession(context.Context, uuid.UUID, uuid.UUID, uuid.UUID, int64) error
}

// BrowserSessions is deliberately unwired. Callers must authenticate the target
// account and device before create or replace; selectors are not credentials.
type BrowserSessions struct {
	repository                      BrowserSessionRepository
	tokens                          TokenIssuer
	accessLifetime, refreshLifetime time.Duration
	clock                           func() time.Time
}

func NewBrowserSessions(repository BrowserSessionRepository, tokens TokenIssuer, accessLifetime, refreshLifetime time.Duration) *BrowserSessions {
	return &BrowserSessions{repository: repository, tokens: tokens, accessLifetime: accessLifetime, refreshLifetime: refreshLifetime, clock: time.Now}
}

type BrowserSessionTarget struct {
	UserID, DeviceID uuid.UUID
	SessionVersion   int64
}
type BrowserCredential struct {
	BrowserID, Generation uuid.UUID
	RefreshToken          string
}
type CreateBrowserSessionCommand struct{ Target BrowserSessionTarget }
type ReplaceBrowserSessionCommand struct {
	Current BrowserCredential
	Target  BrowserSessionTarget
}
type RefreshBrowserSessionCommand struct{ Current BrowserCredential }
type LogoutBrowserSessionCommand struct {
	Current        BrowserCredential
	UserID         uuid.UUID
	SessionVersion int64
}
type LogoutBrowserSessionRetryCommand struct {
	Current BrowserCredential
	UserID  uuid.UUID
	Receipt string
}

type browserReceiptRepository interface {
	LogoutBrowserSessionWithReceipt(context.Context, uuid.UUID, uuid.UUID, uuid.UUID, int64, []byte, time.Time) error
	VerifyBrowserLogoutReceipt(context.Context, uuid.UUID, uuid.UUID, uuid.UUID, []byte) error
	LogoutBrowserSessionWithProofAndReceipt(context.Context, uuid.UUID, uuid.UUID, uuid.UUID, []byte, []byte, time.Time) error
}

const logoutReceiptLifetime = 24 * time.Hour

// ReceiptMatchesRefresh only identifies a cookie for cleanup; it never authorizes logout.
func (s *BrowserSessions) ReceiptMatchesRefresh(ctx context.Context, cmd LogoutBrowserSessionRetryCommand) (bool, error) {
	if cmd.UserID == uuid.Nil || !validBrowserCredential(cmd.Current) {
		return false, ErrInvalidInput
	}
	receipt, err := logoutReceiptHash(cmd.Receipt)
	if err != nil {
		return false, err
	}
	repo, ok := s.repository.(interface {
		ReceiptMatchesRefresh(context.Context, uuid.UUID, uuid.UUID, uuid.UUID, []byte, []byte) (bool, error)
	})
	if !ok {
		return false, nil
	}
	refresh := sha256.Sum256([]byte(cmd.Current.RefreshToken))
	return repo.ReceiptMatchesRefresh(ctx, cmd.Current.BrowserID, cmd.Current.Generation, cmd.UserID, receipt[:], refresh[:])
}

func logoutReceiptHash(secret string) ([32]byte, error) {
	decoded, err := base64.RawURLEncoding.Strict().DecodeString(secret)
	if err != nil || len(decoded) != 32 || base64.RawURLEncoding.EncodeToString(decoded) != secret {
		return [32]byte{}, ErrInvalidInput
	}
	return sha256.Sum256(decoded), nil
}

type browserProofLogoutRepository interface {
	LogoutBrowserSessionWithProof(context.Context, uuid.UUID, uuid.UUID, uuid.UUID, []byte) error
}
type BrowserSessionResult struct {
	BrowserID, Generation uuid.UUID
	Tokens                Tokens
}

func validBrowserTarget(t BrowserSessionTarget) bool {
	return t.UserID != uuid.Nil && t.DeviceID != uuid.Nil && t.SessionVersion > 0
}
func validBrowserCredential(c BrowserCredential) bool {
	return c.BrowserID != uuid.Nil && c.Generation != uuid.Nil && len(c.RefreshToken) > 0 && len(c.RefreshToken) <= 4096
}
func browserRefresh() (string, [32]byte, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", [32]byte{}, err
	}
	token := base64.RawURLEncoding.EncodeToString(b)
	return token, sha256.Sum256([]byte(token)), nil
}
func (s *BrowserSessions) issue(session user.Session, browser, generation uuid.UUID, access *string) error {
	var err error
	*access, err = s.tokens.IssueAccess(sharedauth.Identity{UserID: session.UserID, DeviceID: session.DeviceID.String(), SessionVersion: session.SessionVersion, BrowserID: browser, BrowserGeneration: generation}, s.accessLifetime)
	return err
}
func (s *BrowserSessions) result(browser, generation uuid.UUID, refresh, access string) BrowserSessionResult {
	return BrowserSessionResult{BrowserID: browser, Generation: generation, Tokens: Tokens{AccessToken: access, TokenType: "Bearer", ExpiresIn: int64(s.accessLifetime.Seconds()), RefreshToken: refresh}}
}
func (s *BrowserSessions) Create(ctx context.Context, cmd CreateBrowserSessionCommand) (BrowserSessionResult, error) {
	if !validBrowserTarget(cmd.Target) {
		return BrowserSessionResult{}, ErrInvalidInput
	}
	browser, err := uuid.NewRandom()
	if err != nil {
		return BrowserSessionResult{}, err
	}
	generation, err := uuid.NewRandom()
	if err != nil {
		return BrowserSessionResult{}, err
	}
	refresh, hash, err := browserRefresh()
	if err != nil {
		return BrowserSessionResult{}, err
	}
	var access string
	t := cmd.Target
	err = s.repository.CreateBrowserSession(ctx, browser, generation, t.UserID, t.DeviceID, hash[:], t.SessionVersion, s.clock().Add(s.refreshLifetime), func(session user.Session) error { return s.issue(session, browser, generation, &access) })
	if err != nil {
		return BrowserSessionResult{}, err
	}
	return s.result(browser, generation, refresh, access), nil
}
func (s *BrowserSessions) Replace(ctx context.Context, cmd ReplaceBrowserSessionCommand) (BrowserSessionResult, error) {
	if !validBrowserTarget(cmd.Target) || !validBrowserCredential(cmd.Current) {
		return BrowserSessionResult{}, ErrInvalidInput
	}
	generation, err := uuid.NewRandom()
	if err != nil {
		return BrowserSessionResult{}, err
	}
	refresh, hash, err := browserRefresh()
	if err != nil {
		return BrowserSessionResult{}, err
	}
	current := sha256.Sum256([]byte(cmd.Current.RefreshToken))
	var access string
	t := cmd.Target
	err = s.repository.ReplaceBrowserSession(ctx, cmd.Current.BrowserID, cmd.Current.Generation, current[:], generation, t.UserID, t.DeviceID, hash[:], t.SessionVersion, s.clock().Add(s.refreshLifetime), func(session user.Session) error { return s.issue(session, cmd.Current.BrowserID, generation, &access) })
	if err != nil {
		return BrowserSessionResult{}, err
	}
	return s.result(cmd.Current.BrowserID, generation, refresh, access), nil
}
func (s *BrowserSessions) Refresh(ctx context.Context, cmd RefreshBrowserSessionCommand) (BrowserSessionResult, error) {
	if !validBrowserCredential(cmd.Current) {
		return BrowserSessionResult{}, ErrInvalidInput
	}
	refresh, hash, err := browserRefresh()
	if err != nil {
		return BrowserSessionResult{}, err
	}
	current := sha256.Sum256([]byte(cmd.Current.RefreshToken))
	var access string
	err = s.repository.RotateBrowserSession(ctx, cmd.Current.BrowserID, cmd.Current.Generation, current[:], hash[:], s.clock().Add(s.refreshLifetime), func(session user.Session) error {
		return s.issue(session, cmd.Current.BrowserID, cmd.Current.Generation, &access)
	})
	if err != nil {
		return BrowserSessionResult{}, err
	}
	return s.result(cmd.Current.BrowserID, cmd.Current.Generation, refresh, access), nil
}
func (s *BrowserSessions) Logout(ctx context.Context, cmd LogoutBrowserSessionCommand) error {
	if cmd.UserID == uuid.Nil || cmd.Current.BrowserID == uuid.Nil || cmd.Current.Generation == uuid.Nil || cmd.SessionVersion <= 0 {
		return ErrInvalidInput
	}
	return s.repository.LogoutBrowserSession(ctx, cmd.Current.BrowserID, cmd.Current.Generation, cmd.UserID, cmd.SessionVersion)
}

func (s *BrowserSessions) LogoutWithReceipt(ctx context.Context, cmd LogoutBrowserSessionCommand, receipt string) error {
	if cmd.UserID == uuid.Nil || cmd.Current.BrowserID == uuid.Nil || cmd.Current.Generation == uuid.Nil || cmd.SessionVersion <= 0 {
		return ErrInvalidInput
	}
	hash, err := logoutReceiptHash(receipt)
	if err != nil {
		return err
	}
	repo, ok := s.repository.(browserReceiptRepository)
	if !ok {
		return ErrRefreshToken
	}
	return repo.LogoutBrowserSessionWithReceipt(ctx, cmd.Current.BrowserID, cmd.Current.Generation, cmd.UserID, cmd.SessionVersion, hash[:], s.clock().Add(logoutReceiptLifetime))
}

// LogoutRetry requires a live refresh proof; selectors alone never authorize it.
func (s *BrowserSessions) LogoutRetry(ctx context.Context, cmd LogoutBrowserSessionRetryCommand) error {
	if cmd.Receipt != "" {
		if cmd.UserID == uuid.Nil || cmd.Current.BrowserID == uuid.Nil || cmd.Current.Generation == uuid.Nil {
			return ErrInvalidInput
		}
		hash, err := logoutReceiptHash(cmd.Receipt)
		if err != nil {
			return err
		}
		repo, ok := s.repository.(browserReceiptRepository)
		if !ok {
			return ErrRefreshToken
		}
		err = repo.VerifyBrowserLogoutReceipt(ctx, cmd.Current.BrowserID, cmd.Current.Generation, cmd.UserID, hash[:])
		if err == nil || !errors.Is(err, ErrRefreshToken) {
			return err
		}
		if !validBrowserCredential(cmd.Current) {
			return ErrRefreshToken
		}
		proof := sha256.Sum256([]byte(cmd.Current.RefreshToken))
		return repo.LogoutBrowserSessionWithProofAndReceipt(ctx, cmd.Current.BrowserID, cmd.Current.Generation, cmd.UserID, proof[:], hash[:], s.clock().Add(logoutReceiptLifetime))
	}
	if cmd.UserID == uuid.Nil || !validBrowserCredential(cmd.Current) {
		return ErrInvalidInput
	}
	repo, ok := s.repository.(browserProofLogoutRepository)
	if !ok {
		return ErrRefreshToken
	}
	hash := sha256.Sum256([]byte(cmd.Current.RefreshToken))
	return repo.LogoutBrowserSessionWithProof(ctx, cmd.Current.BrowserID, cmd.Current.Generation, cmd.UserID, hash[:])
}
