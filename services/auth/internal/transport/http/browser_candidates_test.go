package httptransport

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/KovalMax/zwei/services/auth/internal/application"
	sharedauth "github.com/KovalMax/zwei/services/shared/auth"
	"github.com/google/uuid"
)

type filteringCandidates struct {
	heads []application.BrowserCandidateHead
}

func (f filteringCandidates) DiscoverBrowserCandidates(_ context.Context, hashes [][]byte) ([]application.BrowserCandidateHead, error) {
	var result []application.BrowserCandidateHead
	for _, head := range f.heads {
		for _, hash := range hashes {
			if string(head.RefreshHash) == string(hash) {
				result = append(result, head)
			}
		}
	}
	return result, nil
}

func TestV2DiscoveryRecoversManyStaleCookiesWithoutDeletingLiveProofs(t *testing.T) {
	a, b := uuid.New(), uuid.New()
	ha, hb := sha256.Sum256([]byte("live-a")), sha256.Sum256([]byte("live-b"))
	h := NewBrowserV2Handler(NewHandler(nil, nil, nil, nil, map[string]struct{}{"https://chat.localhost": {}}, ""), nil, nil, nil, nil)
	h.SetCandidateDiscovery(filteringCandidates{heads: []application.BrowserCandidateHead{{BrowserID: a, Generation: uuid.New(), RefreshHash: ha[:]}, {BrowserID: b, Generation: uuid.New(), RefreshHash: hb[:]}}})
	var parts []string
	for i := 0; i < 20; i++ {
		token := fmt.Sprintf("stale-%d", i)
		parts = append(parts, uniqueRefreshCookieName(token)+"="+token)
	}
	parts = append(parts, uniqueRefreshCookieName("live-a")+"=live-a", uniqueRefreshCookieName("live-b")+"=live-b")
	r := httptest.NewRequest("POST", "/", strings.NewReader(`{}`))
	r.Header.Set("Origin", "https://chat.localhost")
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Cookie", strings.Join(parts, "; "))
	w := httptest.NewRecorder()
	h.Discover(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status=%d", w.Code)
	}
	if strings.Contains(w.Body.String(), "stale-") || !strings.Contains(w.Body.String(), a.String()) || !strings.Contains(w.Body.String(), b.String()) {
		t.Fatal("missing live candidates or exposed proof")
	}
	if len(w.Result().Cookies()) != 0 {
		t.Fatal("discovery must not delete any observed proofs")
	}
}

func TestV2DiscoveryOverCandidateLimitDoesNotDeleteCookies(t *testing.T) {
	h := NewBrowserV2Handler(NewHandler(nil, nil, nil, nil, map[string]struct{}{"https://chat.localhost": {}}, ""), nil, nil, nil, nil)
	h.SetCandidateDiscovery(filteringCandidates{})
	parts := make([]string, 0, application.MaxV2RefreshCandidates+1)
	for i := 0; i <= application.MaxV2RefreshCandidates; i++ {
		token := fmt.Sprintf("stale-%d", i)
		parts = append(parts, uniqueRefreshCookieName(token)+"="+token)
	}
	r := httptest.NewRequest("POST", "/", strings.NewReader(`{}`))
	r.Header.Set("Origin", "https://chat.localhost")
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Cookie", strings.Join(parts, "; "))
	w := httptest.NewRecorder()
	h.Discover(w, r)
	if w.Code != http.StatusBadRequest || len(w.Result().Cookies()) != 0 {
		t.Fatalf("status=%d; over-limit discovery must not delete cookies", w.Code)
	}
}

func TestV2DiscoveryNeverCleansUpWithoutValidatedMutation(t *testing.T) {
	for _, tc := range []struct {
		name   string
		repo   application.BrowserCandidateDiscovery
		status int
	}{
		{"no live heads", filteringCandidates{}, http.StatusUnauthorized},
		{"persistence unavailable", candidateRepo{err: errors.New("unavailable")}, http.StatusInternalServerError},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := NewBrowserV2Handler(NewHandler(nil, nil, nil, nil, map[string]struct{}{"https://chat.localhost": {}}, ""), nil, nil, nil, nil)
			h.SetCandidateDiscovery(tc.repo)
			r := httptest.NewRequest("POST", "/", strings.NewReader(`{}`))
			r.Header.Set("Origin", "https://chat.localhost")
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("Cookie", "zwei_refresh=legacy; "+uniqueRefreshCookieName("stale")+"=stale")
			w := httptest.NewRecorder()
			h.Discover(w, r)
			if w.Code != tc.status || len(w.Result().Cookies()) != 0 {
				t.Fatalf("status=%d; discovery must not delete cookies", w.Code)
			}
		})
	}
}

func TestV2LogoutExpiresOnlySelectedObservedProof(t *testing.T) {
	a, b, ga, gb, uid := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	ha, hb := sha256.Sum256([]byte("proof-a")), sha256.Sum256([]byte("proof-b"))
	s := &v2SessionsFake{}
	h := NewBrowserV2Handler(NewHandler(nil, nil, nil, nil, map[string]struct{}{"https://chat.localhost": {}}, ""), nil, nil, s, v2BearerFake{sharedauth.Identity{UserID: uid, BrowserID: b, BrowserGeneration: gb, SessionVersion: 1}})
	h.SetCandidateDiscovery(candidateRepo{heads: []application.BrowserCandidateHead{{BrowserID: a, Generation: ga, RefreshHash: ha[:]}, {BrowserID: b, Generation: gb, RefreshHash: hb[:]}}})
	r := httptest.NewRequest("POST", "/", strings.NewReader(`{"browser_id":"`+b.String()+`","generation":"`+gb.String()+`"}`))
	r.Header.Set("Origin", "https://chat.localhost")
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Cookie", uniqueRefreshCookieName("proof-a")+"=proof-a; "+uniqueRefreshCookieName("proof-b")+"=proof-b")
	w := httptest.NewRecorder()
	h.Logout(w, r)
	cookies := w.Result().Cookies()
	if w.Code != 500 || s.logouts != 1 || len(cookies) != 0 {
		t.Fatalf("logout status=%d cookies=%v", w.Code, cookies)
	}
	h.SetCandidateDiscovery(candidateRepo{err: errors.New("unavailable")})
	w = httptest.NewRecorder()
	r = httptest.NewRequest("POST", "/", strings.NewReader(`{"browser_id":"`+b.String()+`","generation":"`+gb.String()+`"}`))
	r.Header.Set("Origin", "https://chat.localhost")
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Cookie", uniqueRefreshCookieName("proof-b")+"=proof-b")
	h.Logout(w, r)
	if w.Code != 500 || s.logouts != 2 || len(w.Result().Cookies()) != 0 {
		t.Fatal("discovery failure prevented bearer logout or deleted an unverified cookie")
	}
}

type candidateRepo struct {
	heads []application.BrowserCandidateHead
	err   error
}

func (f candidateRepo) DiscoverBrowserCandidates(context.Context, [][]byte) ([]application.BrowserCandidateHead, error) {
	return f.heads, f.err
}

func TestV2CandidateDiscoveryAndContinue(t *testing.T) {
	a, b, ga, gb := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	ha, hb := sha256.Sum256([]byte("proof-a")), sha256.Sum256([]byte("proof-b"))
	repo := candidateRepo{heads: []application.BrowserCandidateHead{{BrowserID: a, Generation: ga, DisplayName: "Alice", RefreshHash: ha[:]}, {BrowserID: b, Generation: gb, DisplayName: "Bob", RefreshHash: hb[:]}}}
	s := &v2SessionsFake{}
	h := NewBrowserV2Handler(NewHandler(nil, nil, nil, nil, map[string]struct{}{"https://chat.localhost": {}}, ""), nil, nil, s, nil)
	h.SetCandidateDiscovery(repo)
	request := func(handler http.HandlerFunc, body, origin, cookie string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "/", strings.NewReader(body))
		r.Header.Set("Origin", origin)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Cookie", cookie)
		w := httptest.NewRecorder()
		handler(w, r)
		if w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("missing no-store")
		}
		return w
	}
	cookies := uniqueRefreshCookieName("proof-a") + "=proof-a; " + uniqueRefreshCookieName("proof-b") + "=proof-b"
	w := request(h.Discover, `{}`, "https://chat.localhost", cookies)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "Alice") || !strings.Contains(w.Body.String(), "Bob") || strings.Contains(w.Body.String(), "proof-") {
		t.Fatalf("discovery: %d %s", w.Code, w.Body.String())
	}
	body := `{"browser_id":"` + b.String() + `","generation":"` + gb.String() + `"}`
	w = request(h.Refresh, body, "https://chat.localhost", cookies)
	if w.Code != 200 || s.current.RefreshToken != "proof-b" {
		t.Fatalf("selected refresh status=%d", w.Code)
	}
	s.refreshes = 0
	w = request(h.Continue, body, "https://chat.localhost", cookies)
	if w.Code != 200 || s.refreshes != 1 || s.current.RefreshToken != "proof-b" || strings.Contains(w.Body.String(), "proof-b") {
		t.Fatalf("continue: %d %s", w.Code, w.Body.String())
	}
	w = request(h.Continue, body, "https://chat.localhost", uniqueRefreshCookieName("proof-a")+"=proof-a")
	if w.Code == 200 || s.refreshes != 1 {
		t.Fatal("accepted unpresented proof")
	}
	w = request(h.Discover, `{}`, "https://evil.example", cookies)
	if w.Code != 403 {
		t.Fatal("foreign origin accepted")
	}
	w = request(h.Discover, `{}`, "https://chat.localhost", cookies+"; zwei_signed_out=1")
	if w.Code != 200 || s.refreshes != 1 || len(w.Result().Cookies()) != 0 || strings.Contains(w.Body.String(), "access_token") {
		t.Fatal("discovery with a stale signed-out marker must not issue a session")
	}
	w = request(h.Continue, body, "https://chat.localhost", cookies+"; zwei_signed_out=1")
	if w.Code != 200 || s.refreshes != 2 || s.current.RefreshToken != "proof-b" {
		t.Fatal("explicit continue with newer proof was blocked by stale marker")
	}
	w = request(h.Continue, body, "https://chat.localhost", "zwei_signed_out=1")
	if w.Code != 401 || s.refreshes != 2 || len(w.Result().Cookies()) != 0 {
		t.Fatal("marker and selectors without candidate proof issued a session")
	}
	s.refreshErr = application.ErrRefreshToken
	w = request(h.Continue, body, "https://chat.localhost", cookies)
	if w.Code != 401 || len(w.Result().Cookies()) != 0 {
		t.Fatal("stale proof issued a session")
	}
	h.SetCandidateDiscovery(candidateRepo{err: errors.New("unavailable")})
	w = request(h.Continue, body, "https://chat.localhost", cookies)
	if w.Code != 500 || s.refreshes != 3 {
		t.Fatal("discovery failure did not fail closed")
	}
	mux := http.NewServeMux()
	h.base.Register(mux)
	for _, path := range []string{"/api/auth/v2/discovery", "/api/auth/v2/continue"} {
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest("POST", path, nil))
		if w.Code != http.StatusNotFound {
			t.Fatalf("%s unexpectedly registered", path)
		}
	}
}
