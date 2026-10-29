package application

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"testing"
	"time"

	"github.com/KovalMax/zwei/services/auth/internal/domain/user"
	"github.com/KovalMax/zwei/services/auth/internal/infrastructure/token"
	sharedauth "github.com/KovalMax/zwei/services/shared/auth"
	"github.com/google/uuid"
)

type browserRepo struct {
	browser, generation, owner, device uuid.UUID
	hash                               []byte
	version                            int64
	expires                            time.Time
	err                                error
}

func TestBrowserSessionIssuesSignedBindings(t *testing.T) {
	ctx := context.Background()
	secret := []byte("01234567890123456789012345678901")
	s := NewBrowserSessions(&browserRepo{}, token.NewJWTIssuer(secret), time.Minute, time.Hour)
	target := BrowserSessionTarget{UserID: uuid.New(), DeviceID: uuid.New(), SessionVersion: 2}
	check := func(result BrowserSessionResult, target BrowserSessionTarget) {
		t.Helper()
		identity, err := sharedauth.Parse(result.Tokens.AccessToken, secret)
		if err != nil || identity.UserID != target.UserID || identity.DeviceID != target.DeviceID.String() || identity.SessionVersion != target.SessionVersion || identity.BrowserID != result.BrowserID || identity.BrowserGeneration != result.Generation {
			t.Fatalf("invalid signed binding: %+v, %v", identity, err)
		}
	}
	created, err := s.Create(ctx, CreateBrowserSessionCommand{Target: target})
	if err != nil {
		t.Fatal(err)
	}
	check(created, target)
	credential := BrowserCredential{created.BrowserID, created.Generation, created.Tokens.RefreshToken}
	refreshed, err := s.Refresh(ctx, RefreshBrowserSessionCommand{Current: credential})
	if err != nil {
		t.Fatal(err)
	}
	check(refreshed, target)
	target2 := BrowserSessionTarget{UserID: uuid.New(), DeviceID: uuid.New(), SessionVersion: 3}
	credential = BrowserCredential{refreshed.BrowserID, refreshed.Generation, refreshed.Tokens.RefreshToken}
	replaced, err := s.Replace(ctx, ReplaceBrowserSessionCommand{Current: credential, Target: target2})
	if err != nil {
		t.Fatal(err)
	}
	check(replaced, target2)
	if replaced.BrowserID != created.BrowserID || replaced.Generation == created.Generation {
		t.Fatal("replacement did not advance generation")
	}
}

func (r *browserRepo) CreateBrowserSession(ctx context.Context, b, g, u, d uuid.UUID, h []byte, v int64, e time.Time, issue func(user.Session) error) error {
	if r.err != nil {
		return r.err
	}
	if err := issue(user.Session{UserID: u, DeviceID: d, SessionVersion: v}); err != nil {
		return err
	}
	r.browser, r.generation, r.owner, r.device, r.hash, r.version, r.expires = b, g, u, d, bytes.Clone(h), v, e
	return nil
}
func (r *browserRepo) valid(b, g uuid.UUID, h []byte) bool {
	return b == r.browser && g == r.generation && bytes.Equal(h, r.hash)
}
func (r *browserRepo) ReplaceBrowserSession(ctx context.Context, b, g uuid.UUID, old []byte, ng, u, d uuid.UUID, h []byte, v int64, e time.Time, issue func(user.Session) error) error {
	if !r.valid(b, g, old) {
		return ErrRefreshToken
	}
	return r.CreateBrowserSession(ctx, b, ng, u, d, h, v, e, issue)
}
func (r *browserRepo) RotateBrowserSession(ctx context.Context, b, g uuid.UUID, old, h []byte, e time.Time, issue func(user.Session) error) error {
	if !r.valid(b, g, old) {
		return ErrRefreshToken
	}
	return r.CreateBrowserSession(ctx, b, g, r.owner, r.device, h, r.version, e, issue)
}
func (r *browserRepo) LogoutBrowserSession(ctx context.Context, b, g, u uuid.UUID, version int64) error {
	if b != r.browser || g != r.generation || len(r.hash) == 0 || u != r.owner || version != r.version {
		return ErrRefreshToken
	}
	r.hash = nil
	return nil
}
func TestBrowserSessionLifecycle(t *testing.T) {
	ctx := context.Background()
	repo := &browserRepo{}
	s := NewBrowserSessions(repo, fakeTokens{}, time.Minute, time.Hour)
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	s.clock = func() time.Time { return now }
	target := BrowserSessionTarget{UserID: uuid.New(), DeviceID: uuid.New(), SessionVersion: 2}
	created, err := s.Create(ctx, CreateBrowserSessionCommand{Target: target})
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte(created.Tokens.RefreshToken))
	if created.BrowserID == uuid.Nil || created.Generation == uuid.Nil || !bytes.Equal(repo.hash, digest[:]) || !repo.expires.Equal(now.Add(time.Hour)) {
		t.Fatal("invalid created head")
	}
	old := BrowserCredential{created.BrowserID, created.Generation, created.Tokens.RefreshToken}
	refreshed, err := s.Refresh(ctx, RefreshBrowserSessionCommand{old})
	if err != nil {
		t.Fatal(err)
	}
	if refreshed.BrowserID != old.BrowserID || refreshed.Generation != old.Generation || refreshed.Tokens.RefreshToken == old.RefreshToken {
		t.Fatal("invalid rotation")
	}
	if _, err = s.Refresh(ctx, RefreshBrowserSessionCommand{old}); !errors.Is(err, ErrRefreshToken) {
		t.Fatal("stale refresh accepted", err)
	}
	current := BrowserCredential{refreshed.BrowserID, refreshed.Generation, refreshed.Tokens.RefreshToken}
	target2 := BrowserSessionTarget{uuid.New(), uuid.New(), 3}
	replaced, err := s.Replace(ctx, ReplaceBrowserSessionCommand{current, target2})
	if err != nil {
		t.Fatal(err)
	}
	if replaced.BrowserID != current.BrowserID || replaced.Generation == current.Generation || repo.owner != target2.UserID {
		t.Fatal("invalid replacement")
	}
	if err = s.Logout(ctx, LogoutBrowserSessionCommand{current, target.UserID, target.SessionVersion}); !errors.Is(err, ErrRefreshToken) {
		t.Fatal("stale logout accepted", err)
	}
	next := BrowserCredential{replaced.BrowserID, replaced.Generation, replaced.Tokens.RefreshToken}
	if err = s.Logout(ctx, LogoutBrowserSessionCommand{next, target.UserID, target.SessionVersion}); !errors.Is(err, ErrRefreshToken) {
		t.Fatal("wrong owner accepted", err)
	}
	if err = s.Logout(ctx, LogoutBrowserSessionCommand{next, target2.UserID, target2.SessionVersion}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Refresh(ctx, RefreshBrowserSessionCommand{next}); !errors.Is(err, ErrRefreshToken) {
		t.Fatal("logged out credential accepted", err)
	}
}
func TestBrowserSessionsRejectInvalidAndRepositoryErrors(t *testing.T) {
	repo := &browserRepo{}
	s := NewBrowserSessions(repo, fakeTokens{}, time.Minute, time.Hour)
	ctx := context.Background()
	if _, err := s.Create(ctx, CreateBrowserSessionCommand{}); !errors.Is(err, ErrInvalidInput) {
		t.Fatal(err)
	}
	if _, err := s.Replace(ctx, ReplaceBrowserSessionCommand{}); !errors.Is(err, ErrInvalidInput) {
		t.Fatal(err)
	}
	if _, err := s.Refresh(ctx, RefreshBrowserSessionCommand{}); !errors.Is(err, ErrInvalidInput) {
		t.Fatal(err)
	}
	if err := s.Logout(ctx, LogoutBrowserSessionCommand{}); !errors.Is(err, ErrInvalidInput) {
		t.Fatal(err)
	}
	failure := errors.New("repository failure")
	repo.err = failure
	result, err := s.Create(ctx, CreateBrowserSessionCommand{BrowserSessionTarget{uuid.New(), uuid.New(), 1}})
	if !errors.Is(err, failure) || result.Tokens.RefreshToken != "" {
		t.Fatal("error exposed credentials", err)
	}
}

type failingBrowserIssuer struct{ fakeTokens }

func (failingBrowserIssuer) IssueAccess(_ sharedauth.Identity, _ time.Duration) (string, error) {
	return "", errIssueBrowser
}

var errIssueBrowser = errors.New("issue failed")

func TestBrowserSessionIssuanceFailureDoesNotPublishCredentials(t *testing.T) {
	repo := &browserRepo{}
	s := NewBrowserSessions(repo, failingBrowserIssuer{}, time.Minute, time.Hour)
	result, err := s.Create(context.Background(), CreateBrowserSessionCommand{BrowserSessionTarget{uuid.New(), uuid.New(), 1}})
	if !errors.Is(err, errIssueBrowser) || result.Tokens.RefreshToken != "" || len(repo.hash) != 0 {
		t.Fatal("issuance failure published session", err)
	}
}
