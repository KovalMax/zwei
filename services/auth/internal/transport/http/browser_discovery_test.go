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
	"github.com/google/uuid"
)

type discoveryRepository struct {
	head  application.BrowserHead
	err   error
	calls int
}

func (r *discoveryRepository) DiscoverBrowserHead(_ context.Context, _ [][]byte) (application.BrowserHead, error) {
	r.calls++
	return r.head, r.err
}

func TestBrowserDiscoveryRouteUnavailable(t *testing.T) {
	repo := &discoveryRepository{}
	h := NewHandler(nil, nil, nil, nil, map[string]struct{}{"https://chat.localhost": {}}, "")
	h.SetBrowserDiscovery(repo)
	mux := http.NewServeMux()
	h.Register(mux)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/v2/discovery", nil)
	req.Header.Set("Origin", "https://chat.localhost")
	req.Header.Set("Cookie", "zwei_refresh=proof-secret")
	res := httptest.NewRecorder()
	mux.ServeHTTP(res, req)
	if res.Code != http.StatusNotFound || repo.calls != 0 || len(res.Result().Cookies()) != 0 {
		t.Fatalf("discovery exposed: status=%d calls=%d", res.Code, repo.calls)
	}
}

func TestBrowserDiscoveryHTTP(t *testing.T) {
	browser, generation := uuid.New(), uuid.New()
	hash := sha256.Sum256([]byte("proof-secret"))
	for _, tc := range []struct {
		name, origin, cookie, body string
		err                        error
		status                     int
		calls                      int
	}{
		{"success", "https://chat.localhost", "zwei_refresh=proof-secret", "", nil, 200, 1},
		{"no origin", "", "zwei_refresh=proof-secret", "", nil, 403, 0},
		{"foreign origin", "https://evil.example", "zwei_refresh=proof-secret", "", nil, 403, 0},
		{"null origin", "null", "zwei_refresh=proof-secret", "", nil, 403, 0},
		{"combined origins", "https://chat.localhost, https://evil.example", "zwei_refresh=proof-secret", "", nil, 403, 0},
		{"unbound cookie", "https://chat.localhost", "zwei_refresh_wrong=proof-secret", "", nil, 400, 0},
		{"conflicting cookies", "https://chat.localhost", "zwei_refresh=proof-secret; zwei_refresh=other", "", nil, 400, 0},
		{"no proof", "https://chat.localhost", "", "", nil, 401, 0},
		{"signed out", "https://chat.localhost", "zwei_refresh=proof-secret; zwei_signed_out=1", "", nil, 401, 0},
		{"body proof forbidden", "https://chat.localhost", "", `{"refresh_token":"proof-secret"}`, nil, 400, 0},
		{"oversized cookies", "https://chat.localhost", "other=" + strings.Repeat("a", maxCookieHeaderBytes), "", nil, 400, 0},
		{"unknown proof", "https://chat.localhost", "zwei_refresh=proof-secret", "", application.ErrRefreshToken, 401, 1},
		{"database failure", "https://chat.localhost", "zwei_refresh=proof-secret", "", errors.New("sensitive details"), 500, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repo := &discoveryRepository{head: application.BrowserHead{BrowserID: browser, Generation: generation, RefreshHash: hash[:]}, err: tc.err}
			h := &Handler{allowedOrigins: map[string]struct{}{"https://chat.localhost": {}}, browserDiscovery: repo}
			req := httptest.NewRequest(http.MethodPost, "/api/auth/v2/discovery", strings.NewReader(tc.body))
			if tc.origin != "" {
				req.Header.Set("Origin", tc.origin)
			}
			if tc.cookie != "" {
				req.Header.Set("Cookie", tc.cookie)
			}
			res := httptest.NewRecorder()
			h.discoverBrowser(res, req)
			if res.Code != tc.status || repo.calls != tc.calls || res.Header().Get("Cache-Control") != "no-store" || len(res.Result().Cookies()) != 0 || strings.Contains(res.Body.String(), "proof-secret") || strings.Contains(res.Body.String(), "sensitive details") {
				t.Fatalf("status=%d calls=%d headers=%v body=%s", res.Code, repo.calls, res.Header(), res.Body.String())
			}
			if tc.status == 200 {
				var body map[string]string
				if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil || len(body) != 2 || body["browser_id"] != browser.String() || body["generation"] != generation.String() {
					t.Fatalf("unexpected response: %s", res.Body.String())
				}
			}
		})
	}
}
