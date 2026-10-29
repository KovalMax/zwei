package httptransport

import (
	"context"
	"crypto/sha256"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/KovalMax/zwei/services/auth/internal/application"
	"github.com/KovalMax/zwei/services/auth/internal/domain/user"
	sharedauth "github.com/KovalMax/zwei/services/shared/auth"
)

func TestRefreshCandidateCookiesBindingAndBounds(t *testing.T) {
	r := httptest.NewRequest("POST", "/", nil)
	name := uniqueRefreshCookieName("new-token")
	r.Header.Add("Cookie", "unrelated=x; zwei_refresh=legacy; "+name+"=new-token")
	cookies, err := refreshCandidateCookies(r)
	if err != nil || len(cookies) != 2 || cookies[0].Name != "zwei_refresh" || cookies[1].Name != name {
		t.Fatalf("candidates = %#v, err %v", cookies, err)
	}
	r.Header.Set("Cookie", name+"=other-token")
	if _, err := refreshCandidateCookies(r); err == nil {
		t.Fatal("accepted mismatched name")
	}
	r.Header.Set("Cookie", "zwei_refresh=a; zwei_refresh=b")
	if _, err := refreshCandidateCookies(r); err == nil {
		t.Fatal("accepted conflicting duplicate name")
	}
	r.Header.Set("Cookie", strings.Repeat("zwei_refresh=a; ", application.MaxRefreshCandidates+1))
	if _, err := refreshCandidateCookies(r); err == nil {
		t.Fatal("accepted too many cookies")
	}
	r.Header.Set("Cookie", "unrelated="+strings.Repeat("x", 17000))
	if _, err := refreshCandidateCookies(r); err == nil {
		t.Fatal("accepted oversized header")
	}
}

type candidateHTTPRepo struct {
	application.Repository
	selected int
	err      error
}

func (r candidateHTTPRepo) RotateRefreshCandidates(_ context.Context, hashes [][]byte, _ []byte, _ time.Time, issue func(user.Session, []byte) error) error {
	if r.err != nil {
		return r.err
	}
	return issue(user.Session{UserID: uuid.New(), DeviceID: uuid.New(), SessionVersion: 1}, hashes[r.selected])
}

type cookieTestIssuer struct{}

type cookieLoginRepo struct {
	application.Repository
	account user.User
	device  uuid.UUID
}

func (r cookieLoginRepo) FindUserByEmail(context.Context, string) (user.User, error) {
	return r.account, nil
}
func (r cookieLoginRepo) EnsureDevice(context.Context, uuid.UUID, string, string) (uuid.UUID, error) {
	return r.device, nil
}
func (r cookieLoginRepo) CreateSession(context.Context, uuid.UUID, uuid.UUID, []byte, int64, time.Time) error {
	return nil
}

type cookiePasswords struct{ reject bool }

func (p cookiePasswords) Compare(string, string) error {
	if p.reject {
		return errors.New("invalid")
	}
	return nil
}
func (cookiePasswords) Hash(string) (string, error) { return "", nil }

type mixedOwnerRepo struct {
	*logoutRepository
	otherHash [32]byte
}

func (r mixedOwnerRepo) RefreshTokenOwner(_ context.Context, hash []byte) (uuid.UUID, error) {
	if string(hash) == string(r.otherHash[:]) {
		return uuid.New(), nil
	}
	return r.owner, nil
}

func (cookieTestIssuer) IssueAccess(sharedauth.Identity, time.Duration) (string, error) {
	return "access", nil
}
func (cookieTestIssuer) IssueWebSocketTicket(sharedauth.Identity, time.Duration) (string, error) {
	return "", nil
}

func TestRefreshCandidatesDeletesOnlySelectedAndIssuesUnique(t *testing.T) {
	h := &Handler{auth: application.NewService(candidateHTTPRepo{selected: 1}, nil, cookieTestIssuer{}, time.Minute, time.Hour), allowedOrigins: map[string]struct{}{"https://chat.localhost": {}}, uniqueRefreshCookies: true}
	r := httptest.NewRequest(http.MethodPost, "/api/auth/refresh", nil)
	r.Header.Set("Origin", "https://chat.localhost")
	first, second := uniqueRefreshCookieName("first"), uniqueRefreshCookieName("second")
	r.Header.Set("Cookie", first+"=first; "+second+"=second")
	w := httptest.NewRecorder()
	h.refresh(w, r)
	cookies := refreshDeletionCookies(w.Result().Cookies())
	if w.Code != http.StatusOK || len(cookies) != 2 || cookies[0].Name != second || cookies[0].MaxAge >= 0 || cookies[1].Name != uniqueRefreshCookieName(cookies[1].Value) || cookies[1].Name == first || cookies[1].Name == second || !cookies[1].HttpOnly || !cookies[1].Secure || cookies[1].Path != "/api/auth" || strings.Contains(w.Body.String(), cookies[1].Value) {
		t.Fatalf("unexpected refresh status or cookie attributes: status=%d count=%d", w.Code, len(cookies))
	}
	// An ambiguous repository result must not issue or delete any cookies.
	h.auth = application.NewService(candidateHTTPRepo{err: application.ErrRefreshToken}, nil, cookieTestIssuer{}, time.Minute, time.Hour)
	w = httptest.NewRecorder()
	h.refresh(w, r)
	if w.Code != http.StatusUnauthorized || len(w.Result().Cookies()) != 0 {
		t.Fatalf("ambiguous response status=%d", w.Code)
	}
}

func TestLogoutMultipleCookieOwnershipFailsClosed(t *testing.T) {
	_, existing, h, bearer := authenticatedTestHandler(t, false)
	repo := &logoutRepository{owner: existing.profile.ID}
	h.auth = application.NewService(repo, nil, nil, time.Minute, time.Hour)
	r := httptest.NewRequest(http.MethodPost, "/api/auth/logout", nil)
	r.Header.Set("Authorization", "Bearer "+bearer)
	first, second := uniqueRefreshCookieName("first"), uniqueRefreshCookieName("second")
	r.Header.Set("Cookie", first+"=first; "+second+"=second")
	w := httptest.NewRecorder()
	h.logout(w, r)
	cookies := refreshDeletionCookies(w.Result().Cookies())
	if w.Code != http.StatusNoContent || len(cookies) != 2 || cookies[0].Name != first || cookies[1].Name != second || cookies[0].MaxAge >= 0 || cookies[1].MaxAge >= 0 {
		t.Fatalf("logout status=%d cookie count=%d", w.Code, len(cookies))
	}
	repo.err = errors.New("sensitive failure")
	w = httptest.NewRecorder()
	h.logout(w, r)
	if w.Code != http.StatusInternalServerError || len(refreshDeletionCookies(w.Result().Cookies())) != 0 || strings.Contains(w.Body.String(), "sensitive") {
		t.Fatal("logout did not fail closed")
	}
	mixed := mixedOwnerRepo{logoutRepository: &logoutRepository{owner: existing.profile.ID}, otherHash: sha256.Sum256([]byte("second"))}
	h.auth = application.NewService(mixed, nil, nil, time.Minute, time.Hour)
	w = httptest.NewRecorder()
	h.logout(w, r)
	deleted := refreshDeletionCookies(w.Result().Cookies())
	if w.Code != http.StatusConflict || !mixed.revoked || len(deleted) != 1 || deleted[0].Name != first || deleted[0].MaxAge >= 0 {
		t.Fatal("mixed ownership must clear only the verified owned cookie")
	}
	r.Header.Set("Cookie", second+"=second; "+first+"=first")
	w = httptest.NewRecorder()
	h.logout(w, r)
	deleted = refreshDeletionCookies(w.Result().Cookies())
	if w.Code != http.StatusConflict || len(deleted) != 1 || deleted[0].Name != first {
		t.Fatal("foreign cookie preceding owned cookie prevented verified cleanup")
	}
}

func refreshDeletionCookies(cookies []*http.Cookie) []*http.Cookie {
	var result []*http.Cookie
	for _, cookie := range cookies {
		if cookie.Name != signedOutCookie {
			result = append(result, cookie)
		}
	}
	return result
}

func TestSignedOutMarkerBlocksUnauthenticatedRefresh(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/api/auth/refresh", nil)
	r.Header.Set("Origin", "https://chat.localhost")
	r.AddCookie(&http.Cookie{Name: signedOutCookie, Value: "1"})
	r.AddCookie(&http.Cookie{Name: uniqueRefreshCookieName("foreign"), Value: "foreign"})
	w := httptest.NewRecorder()
	(&Handler{allowedOrigins: map[string]struct{}{"https://chat.localhost": {}}}).refresh(w, r)
	if w.Code != http.StatusUnauthorized || len(w.Result().Cookies()) != 0 {
		t.Fatal("signed-out browser silently restored another account")
	}
}

func TestOnlySuccessfulExplicitLoginClearsSignedOutMarker(t *testing.T) {
	repo := cookieLoginRepo{account: user.User{ID: uuid.New(), PasswordHash: "hash", SessionVersion: 1, KYCStatus: user.KYCActive, EmailVerified: true}, device: uuid.New()}
	for _, reject := range []bool{true, false} {
		h := &Handler{auth: application.NewService(repo, cookiePasswords{reject: reject}, cookieTestIssuer{}, time.Minute, time.Hour)}
		r := httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(`{"email":"user@example.test","password":"password","device_id":"browser-device"}`))
		r.AddCookie(&http.Cookie{Name: signedOutCookie, Value: "1"})
		w := httptest.NewRecorder()
		h.login(w, r)
		cleared := false
		for _, c := range w.Result().Cookies() {
			if c.Name == signedOutCookie && c.MaxAge < 0 {
				cleared = true
			}
		}
		if cleared == reject || (!reject && w.Code != http.StatusOK) || (reject && w.Code != http.StatusUnauthorized) {
			t.Fatalf("reject=%v status=%d marker cleared=%v", reject, w.Code, cleared)
		}
	}
}
