package httptransport

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/KovalMax/zwei/services/auth/internal/application"
	sharedauth "github.com/KovalMax/zwei/services/shared/auth"
	"github.com/google/uuid"
)

type v2LoginFake struct {
	target application.BrowserSessionTarget
	err    error
}

type v2BearerFake struct{ identity sharedauth.Identity }

func (f v2BearerFake) AuthenticateBearer(context.Context, string) (sharedauth.Identity, error) {
	return f.identity, nil
}

func TestV2RefreshAndLogout(t *testing.T) {
	browser, generation, user := uuid.New(), uuid.New(), uuid.New()
	hash := sha256.Sum256([]byte("old-secret"))
	repo := &discoveryRepository{head: application.BrowserHead{BrowserID: browser, Generation: generation, RefreshHash: hash[:]}}
	sessions := &v2SessionsFake{}
	h := NewBrowserV2Handler(NewHandler(nil, nil, nil, nil, map[string]struct{}{"https://chat.localhost": {}}, ""), v2LoginFake{}, repo, sessions, v2BearerFake{sharedauth.Identity{UserID: user, BrowserID: browser, BrowserGeneration: generation}})
	h.SetCandidateDiscovery(candidateRepo{heads: []application.BrowserCandidateHead{{BrowserID: browser, Generation: generation, RefreshHash: hash[:]}}})
	body := `{"browser_id":"` + browser.String() + `","generation":"` + generation.String() + `"}`
	for _, tc := range []struct {
		name    string
		handler func(http.ResponseWriter, *http.Request)
		body    string
		status  int
	}{
		{"refresh", h.Refresh, body, 200}, {"stale", h.Refresh, `{"browser_id":"` + browser.String() + `","generation":"` + uuid.New().String() + `"}`, 401}, {"logout", h.Logout, body, 500},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("POST", "/", strings.NewReader(tc.body))
			r.Header.Set("Origin", "https://chat.localhost")
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("Cookie", "zwei_refresh=old-secret")
			w := httptest.NewRecorder()
			tc.handler(w, r)
			if w.Code != tc.status {
				t.Fatalf("status %d body %s", w.Code, w.Body.String())
			}
			if strings.Contains(w.Body.String(), "secret") {
				t.Fatal("secret in response")
			}
			cookies := w.Result().Cookies()
			if tc.name == "refresh" {
				var data map[string]any
				if json.Unmarshal(w.Body.Bytes(), &data) != nil || data["access_token"] != "access" || len(cookies) != 1 || cookies[0].Name != uniqueRefreshCookieName("secret") || !cookies[0].HttpOnly || !cookies[0].Secure {
					t.Fatalf("unexpected refresh: %s cookies %v", w.Body.String(), cookies)
				}
			}
			if tc.name == "logout" && len(cookies) != 0 {
				t.Fatalf("logout cookies %v", cookies)
			}
			if tc.name == "stale" && len(cookies) != 0 {
				t.Fatal("stale response set cookies")
			}
		})
	}
	if sessions.refreshes != 1 || sessions.logouts != 1 {
		t.Fatalf("refreshes=%d logouts=%d", sessions.refreshes, sessions.logouts)
	}
}

func TestV2LogoutUsesBoundBearerWithoutRotatingCookie(t *testing.T) {
	browser, generation, user := uuid.New(), uuid.New(), uuid.New()
	sessions := &v2SessionsFake{}
	h := NewBrowserV2Handler(NewHandler(nil, nil, nil, nil, map[string]struct{}{"https://chat.localhost": {}}, ""), v2LoginFake{}, nil, sessions, v2BearerFake{sharedauth.Identity{UserID: user, BrowserID: browser, BrowserGeneration: generation, SessionVersion: 1}})
	for _, tc := range []struct {
		generation uuid.UUID
		status     int
	}{{generation, 204}, {uuid.New(), 401}} {
		r := httptest.NewRequest("POST", "/", strings.NewReader(`{"browser_id":"`+browser.String()+`","generation":"`+tc.generation.String()+`"}`))
		r.Header.Set("Origin", "https://chat.localhost")
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		h.Logout(w, r)
		if w.Code != tc.status || len(w.Result().Cookies()) != 0 {
			t.Fatalf("status=%d cookies=%v", w.Code, w.Result().Cookies())
		}
	}
	if sessions.logouts != 1 {
		t.Fatalf("logouts=%d", sessions.logouts)
	}
}

func (f v2LoginFake) AuthenticateBrowserLogin(context.Context, application.Credentials) (application.BrowserSessionTarget, error) {
	return f.target, f.err
}

type v2SessionsFake struct {
	creates, replaces, refreshes, logouts int
	current                               application.BrowserCredential
	refreshErr                            error
	logoutErr                             error
}

func (f *v2SessionsFake) Create(context.Context, application.CreateBrowserSessionCommand) (application.BrowserSessionResult, error) {
	f.creates++
	return v2Result(), nil
}
func (f *v2SessionsFake) Replace(context.Context, application.ReplaceBrowserSessionCommand) (application.BrowserSessionResult, error) {
	f.replaces++
	return v2Result(), nil
}
func (f *v2SessionsFake) Refresh(_ context.Context, cmd application.RefreshBrowserSessionCommand) (application.BrowserSessionResult, error) {
	f.refreshes++
	f.current = cmd.Current
	if f.refreshErr != nil {
		return application.BrowserSessionResult{}, f.refreshErr
	}
	return v2Result(), nil
}
func (f *v2SessionsFake) Logout(context.Context, application.LogoutBrowserSessionCommand) error {
	f.logouts++
	return f.logoutErr
}
func v2Result() application.BrowserSessionResult {
	return application.BrowserSessionResult{BrowserID: uuid.New(), Generation: uuid.New(), Tokens: application.Tokens{AccessToken: "access", RefreshToken: "secret"}}
}

func TestV2LoginRecoversNoLiveHead(t *testing.T) {
	s := &v2SessionsFake{}
	h := NewBrowserV2Handler(NewHandler(nil, nil, nil, nil, map[string]struct{}{"https://chat.localhost": {}}, ""), v2LoginFake{}, &discoveryRepository{err: application.ErrNoLiveBrowserHead}, s, nil)
	r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"email":"a","password":"b"}`))
	r.Header.Set("Origin", "https://chat.localhost")
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Cookie", "zwei_refresh=unknown; "+uniqueRefreshCookieName("obsolete")+"=obsolete")
	w := httptest.NewRecorder()
	h.Login(w, r)
	if w.Code != http.StatusOK || s.creates != 1 || s.replaces != 0 {
		t.Fatalf("status %d creates %d replaces %d", w.Code, s.creates, s.replaces)
	}
	cookies := w.Result().Cookies()
	if len(cookies) != 2 || cookies[0].Name != uniqueRefreshCookieName("obsolete") || cookies[0].MaxAge >= 0 || cookies[1].Name != uniqueRefreshCookieName("secret") {
		t.Fatalf("unexpected cookies: %v", cookies)
	}
}

func TestV2LoginAmbiguousProofFailsClosed(t *testing.T) {
	s := &v2SessionsFake{}
	h := NewBrowserV2Handler(NewHandler(nil, nil, nil, nil, map[string]struct{}{"https://chat.localhost": {}}, ""), v2LoginFake{}, &discoveryRepository{err: application.ErrRefreshToken}, s, nil)
	r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"email":"a","password":"b"}`))
	r.Header.Set("Origin", "https://chat.localhost")
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Cookie", "zwei_refresh=unknown")
	w := httptest.NewRecorder()
	h.Login(w, r)
	if w.Code != http.StatusUnauthorized || s.creates != 0 || s.replaces != 0 || len(w.Result().Cookies()) != 0 {
		t.Fatalf("status %d creates %d replaces %d", w.Code, s.creates, s.replaces)
	}
}

func TestV2LoginReplacesLiveHeadWithoutClearingLegacyName(t *testing.T) {
	proof := "live-proof"
	hash := sha256.Sum256([]byte(proof))
	s := &v2SessionsFake{}
	repo := &discoveryRepository{head: application.BrowserHead{BrowserID: uuid.New(), Generation: uuid.New(), RefreshHash: hash[:]}}
	h := NewBrowserV2Handler(NewHandler(nil, nil, nil, nil, map[string]struct{}{"https://chat.localhost": {}}, ""), v2LoginFake{}, repo, s, nil)
	r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"email":"a","password":"b"}`))
	r.Header.Set("Origin", "https://chat.localhost")
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Cookie", "zwei_refresh="+proof)
	w := httptest.NewRecorder()
	h.Login(w, r)
	cookies := w.Result().Cookies()
	if w.Code != 200 || s.creates != 0 || s.replaces != 1 || len(cookies) != 1 || cookies[0].Name != uniqueRefreshCookieName("secret") {
		t.Fatalf("status %d creates %d replaces %d cookies %v", w.Code, s.creates, s.replaces, cookies)
	}
}

func TestV2LoginRecoveryFailsWithoutAuthenticationOrDiscovery(t *testing.T) {
	for _, tc := range []struct {
		name                   string
		loginErr, discoveryErr error
		status                 int
	}{
		{"bad credentials", application.ErrCredentials, application.ErrNoLiveBrowserHead, 401},
		{"discovery unavailable", nil, errors.New("database failure"), 500},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := &v2SessionsFake{}
			repo := &discoveryRepository{err: tc.discoveryErr}
			h := NewBrowserV2Handler(NewHandler(nil, nil, nil, nil, map[string]struct{}{"https://chat.localhost": {}}, ""), v2LoginFake{err: tc.loginErr}, repo, s, nil)
			r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"email":"a","password":"b"}`))
			r.Header.Set("Origin", "https://chat.localhost")
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("Cookie", uniqueRefreshCookieName("obsolete")+"=obsolete")
			w := httptest.NewRecorder()
			h.Login(w, r)
			if w.Code != tc.status || s.creates != 0 || s.replaces != 0 || len(w.Result().Cookies()) != 0 || (tc.loginErr != nil && repo.calls != 0) {
				t.Fatalf("status %d creates %d replaces %d discovery %d", w.Code, s.creates, s.replaces, repo.calls)
			}
		})
	}
}

func TestV2LoginCreateAndBoundary(t *testing.T) {
	sessions := &v2SessionsFake{}
	base := NewHandler(nil, nil, nil, nil, map[string]struct{}{"https://chat.localhost": {}}, "")
	h := NewBrowserV2Handler(base, v2LoginFake{}, nil, sessions, nil)
	for _, tc := range []struct {
		name, origin, body string
		status             int
	}{
		{"create", "https://chat.localhost", `{"email":"a","password":"b"}`, 200},
		{"foreign", "https://evil.example", `{"email":"a"}`, 403},
		{"trailing", "https://chat.localhost", `{} {}`, 400},
		{"unknown field", "https://chat.localhost", `{"refresh_token":"secret"}`, 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("POST", "/", strings.NewReader(tc.body))
			r.Header.Set("Origin", tc.origin)
			r.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			h.Login(w, r)
			if w.Code != tc.status || strings.Contains(w.Body.String(), "secret") {
				t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
			}
		})
	}
	if sessions.creates != 1 {
		t.Fatalf("creates %d", sessions.creates)
	}
	mux := http.NewServeMux()
	base.Register(mux)
	for _, path := range []string{"/api/auth/v2/login", "/api/auth/v2/refresh", "/api/auth/v2/logout"} {
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest("POST", path, nil))
		if w.Code != 404 {
			t.Fatalf("%s registered", path)
		}
	}
}
