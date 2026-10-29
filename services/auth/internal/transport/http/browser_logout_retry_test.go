package httptransport

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/KovalMax/zwei/services/auth/internal/application"
	sharedauth "github.com/KovalMax/zwei/services/shared/auth"
	"github.com/google/uuid"
)

type retrySessions struct {
	v2SessionsFake
	cmd application.LogoutBrowserSessionRetryCommand
	err error
}

func TestReceiptCleanupUncertainty(t *testing.T) {
	b, g, u := uuid.New(), uuid.New(), uuid.New()
	secret := base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	for _, tc := range []struct {
		name, cookie string
		lookupErr    error
		status       int
	}{
		{"absent", "", nil, 204},
		{"newer", uniqueRefreshCookieName("new-session") + "=new-session", nil, 204},
		{"lookup failure", uniqueRefreshCookieName("old-session") + "=old-session", errors.New("unavailable"), 500},
		{"malformed", uniqueRefreshCookieName("old-session") + "=wrong", nil, 500},
		{"legacy match", "zwei_refresh=old-session", nil, 500},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := &receiptRetrySessions{expected: secret, subject: u, browser: b, generation: g, matchErr: tc.lookupErr}
			h := NewBrowserV2Handler(NewHandler(nil, nil, nil, nil, map[string]struct{}{"https://chat.localhost": {}}, ""), nil, nil, s, nil)
			body := `{"subject":"` + u.String() + `","browser_id":"` + b.String() + `","generation":"` + g.String() + `","receipt":"` + secret + `"}`
			r := httptest.NewRequest("POST", "/", strings.NewReader(body))
			r.Header.Set("Origin", "https://chat.localhost")
			r.Header.Set("Content-Type", "application/json")
			if tc.cookie != "" {
				r.Header.Set("Cookie", tc.cookie)
			}
			w := httptest.NewRecorder()
			h.LogoutRetry(w, r)
			if w.Code != tc.status || len(w.Result().Cookies()) != 0 {
				t.Fatalf("status=%d cookies=%v", w.Code, w.Result().Cookies())
			}
		})
	}
}

type receiptRetrySessions struct {
	v2SessionsFake
	expected                     string
	subject, browser, generation uuid.UUID
	matchErr                     error
}

func (s *receiptRetrySessions) LogoutWithReceipt(_ context.Context, _ application.LogoutBrowserSessionCommand, _ string) error {
	return nil
}

func TestInitialLogoutUsesRevokedHashNotDiscoverySnapshot(t *testing.T) {
	b, g, u := uuid.New(), uuid.New(), uuid.New()
	secret := base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	s := &receiptRetrySessions{expected: secret, subject: u, browser: b, generation: g}
	h := NewBrowserV2Handler(NewHandler(nil, nil, nil, nil, map[string]struct{}{"https://chat.localhost": {}}, ""), nil, nil, s, v2BearerFake{sharedauth.Identity{UserID: u, BrowserID: b, BrowserGeneration: g, SessionVersion: 1}})
	for _, tc := range []struct {
		name, cookie    string
		lookupErr       error
		status, deleted int
	}{
		{"rotation", uniqueRefreshCookieName("new-session") + "=new-session", nil, 204, 0},
		{"matching", uniqueRefreshCookieName("old-session") + "=old-session", nil, 204, 1},
		{"failed lookup", uniqueRefreshCookieName("old-session") + "=old-session", errors.New("unavailable"), 500, 0},
		{"malformed", uniqueRefreshCookieName("old-session") + "=wrong", nil, 500, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s.matchErr = tc.lookupErr
			r := httptest.NewRequest("POST", "/", strings.NewReader(`{"browser_id":"`+b.String()+`","generation":"`+g.String()+`","receipt":"`+secret+`"}`))
			r.Header.Set("Origin", "https://chat.localhost")
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("Cookie", tc.cookie)
			w := httptest.NewRecorder()
			h.Logout(w, r)
			if w.Code != tc.status || len(w.Result().Cookies()) != tc.deleted {
				t.Fatalf("status=%d cookies=%v", w.Code, w.Result().Cookies())
			}
		})
	}
}

func (s *receiptRetrySessions) ReceiptMatchesRefresh(_ context.Context, cmd application.LogoutBrowserSessionRetryCommand) (bool, error) {
	if s.matchErr != nil {
		return false, s.matchErr
	}
	return cmd.UserID == s.subject && cmd.Current.BrowserID == s.browser && cmd.Current.Generation == s.generation && cmd.Receipt == s.expected && cmd.Current.RefreshToken == "old-session", nil
}

func TestLogoutReceiptRetryDeletesOnlyMatchingObservedCookie(t *testing.T) {
	b, g, u := uuid.New(), uuid.New(), uuid.New()
	secret := base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	s := &receiptRetrySessions{expected: secret, subject: u, browser: b, generation: g}
	h := NewBrowserV2Handler(NewHandler(nil, nil, nil, nil, map[string]struct{}{"https://chat.localhost": {}}, ""), nil, nil, s, nil)
	body := `{"subject":"` + u.String() + `","browser_id":"` + b.String() + `","generation":"` + g.String() + `","receipt":"` + secret + `"}`
	r := httptest.NewRequest("POST", "/api/auth/v2/logout/retry", strings.NewReader(body))
	r.Header.Set("Origin", "https://chat.localhost")
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Cookie", uniqueRefreshCookieName("old-session")+"=old-session; "+uniqueRefreshCookieName("new-session")+"=new-session")
	w := httptest.NewRecorder()
	h.LogoutRetry(w, r)
	cookies := w.Result().Cookies()
	if w.Code != 204 || len(cookies) != 1 || cookies[0].Name != uniqueRefreshCookieName("old-session") || cookies[0].MaxAge >= 0 {
		t.Fatalf("status=%d cookies=%v", w.Code, cookies)
	}
}

func (s *receiptRetrySessions) LogoutRetry(_ context.Context, cmd application.LogoutBrowserSessionRetryCommand) error {
	if cmd.Receipt != s.expected || cmd.UserID != s.subject || cmd.Current.BrowserID != s.browser || cmd.Current.Generation != s.generation {
		return application.ErrRefreshToken
	}
	return nil
}

func TestLogoutReceiptRetryWithoutCookieDoesNotClearNewSession(t *testing.T) {
	b, g, u := uuid.New(), uuid.New(), uuid.New()
	secret := base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	s := &receiptRetrySessions{expected: secret, subject: u, browser: b, generation: g}
	h := NewBrowserV2Handler(NewHandler(nil, nil, nil, nil, map[string]struct{}{"https://chat.localhost": {}}, ""), nil, nil, s, nil)
	h.SetCandidateDiscovery(filteringCandidates{})
	for _, tc := range []struct {
		name, receipt, generation string
		status                    int
	}{
		{"committed", secret, g.String(), 204}, {"wrong", "wrong", g.String(), 401}, {"other generation", secret, uuid.New().String(), 401},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body := `{"subject":"` + u.String() + `","browser_id":"` + b.String() + `","generation":"` + tc.generation + `","receipt":"` + tc.receipt + `"}`
			r := httptest.NewRequest("POST", "/api/auth/v2/logout/retry", strings.NewReader(body))
			r.Header.Set("Origin", "https://chat.localhost")
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("Cookie", uniqueRefreshCookieName("new-session")+"=new-session")
			w := httptest.NewRecorder()
			h.LogoutRetry(w, r)
			if w.Code != tc.status || len(w.Result().Cookies()) != 0 {
				t.Fatalf("status=%d cookies=%v", w.Code, w.Result().Cookies())
			}
			if strings.Contains(w.Body.String(), secret) {
				t.Fatal("receipt leaked")
			}
		})
	}
}

func (s *retrySessions) LogoutRetry(_ context.Context, cmd application.LogoutBrowserSessionRetryCommand) error {
	s.cmd = cmd
	return s.err
}

func TestLogoutRetryProofAndOrigin(t *testing.T) {
	browser, generation, subject := uuid.New(), uuid.New(), uuid.New()
	hash := sha256.Sum256([]byte("proof"))
	sessions := &retrySessions{}
	h := NewBrowserV2Handler(NewHandler(nil, nil, nil, nil, map[string]struct{}{"https://chat.localhost": {}}, ""), nil, nil, sessions, nil)
	h.SetCandidateDiscovery(filteringCandidates{heads: []application.BrowserCandidateHead{{BrowserID: browser, Generation: generation, RefreshHash: hash[:]}}})
	body := `{"subject":"` + subject.String() + `","browser_id":"` + browser.String() + `","generation":"` + generation.String() + `"}`
	for _, tc := range []struct {
		name, origin, cookie string
		status               int
	}{
		{"valid", "https://chat.localhost", uniqueRefreshCookieName("proof") + "=proof", 204},
		{"missing", "https://chat.localhost", "", 401},
		{"origin", "https://evil.invalid", uniqueRefreshCookieName("proof") + "=proof", 403},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("POST", "/api/auth/v2/logout/retry", strings.NewReader(body))
			r.Header.Set("Origin", tc.origin)
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("Cookie", tc.cookie)
			w := httptest.NewRecorder()
			h.LogoutRetry(w, r)
			if w.Code != tc.status {
				t.Fatalf("status %d", w.Code)
			}
			cookies := w.Result().Cookies()
			if tc.status == 204 {
				if sessions.cmd.UserID != subject || sessions.cmd.Current.RefreshToken != "proof" || len(cookies) != 1 || cookies[0].Name != uniqueRefreshCookieName("proof") || cookies[0].MaxAge >= 0 {
					t.Fatal("incorrect proof or deletion")
				}
			} else if len(cookies) != 0 {
				t.Fatal("deleted on uncertainty")
			}
			if strings.Contains(w.Body.String(), "proof") {
				t.Fatal("proof leaked")
			}
		})
	}
}
