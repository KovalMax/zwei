package httptransport

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/KovalMax/zwei/services/auth/internal/application"
)

func TestRefreshCookiesAreRestrictedToAuthEndpoints(t *testing.T) {
	response := httptest.NewRecorder()
	setRefreshCookie(response, "refresh-token")

	cookie := response.Result().Cookies()[0]
	if cookie.Name != "zwei_refresh" || cookie.Value != "refresh-token" || cookie.Path != "/api/auth" {
		t.Fatalf("cookie = %#v", cookie)
	}
	if !cookie.HttpOnly || !cookie.Secure || cookie.SameSite != http.SameSiteNoneMode {
		t.Fatalf("cookie security attributes = %#v", cookie)
	}
}

func TestClearRefreshCookieExpiresRestrictedCookie(t *testing.T) {
	response := httptest.NewRecorder()
	clearRefreshCookie(response)

	cookie := response.Result().Cookies()[0]
	if cookie.Name != "zwei_refresh" || cookie.Path != "/api/auth" || cookie.MaxAge >= 0 {
		t.Fatalf("cookie = %#v", cookie)
	}
	if !cookie.HttpOnly || !cookie.Secure || cookie.SameSite != http.SameSiteNoneMode {
		t.Fatalf("cookie security attributes = %#v", cookie)
	}
}

func TestRefreshWithoutCookieReturnsUnauthorized(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost, "/api/auth/refresh", nil)
	request.Header.Set("Origin", "https://chat.localhost")
	response := httptest.NewRecorder()

	(&Handler{allowedOrigins: map[string]struct{}{"https://chat.localhost": {}}}).refresh(response, request)

	if response.Code != http.StatusUnauthorized {
		t.Fatalf("refresh status = %d, want %d", response.Code, http.StatusUnauthorized)
	}
}

func TestRefreshRequiresAllowlistedOrigin(t *testing.T) {
	tests := []struct {
		name       string
		origin     string
		fetchSite  string
		wantStatus int
	}{
		{name: "allowlisted same origin", origin: "https://chat.localhost", fetchSite: "same-origin", wantStatus: http.StatusUnauthorized},
		{name: "hostile origin", origin: "https://attacker.example", fetchSite: "cross-site", wantStatus: http.StatusForbidden},
		{name: "null origin", origin: "null", fetchSite: "cross-site", wantStatus: http.StatusForbidden},
		{name: "missing origin and fetch metadata", wantStatus: http.StatusForbidden},
		{name: "missing origin with same-origin metadata", fetchSite: "same-origin", wantStatus: http.StatusForbidden},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/api/auth/refresh", nil)
			if test.origin != "" {
				request.Header.Set("Origin", test.origin)
			}
			if test.fetchSite != "" {
				request.Header.Set("Sec-Fetch-Site", test.fetchSite)
			}
			response := httptest.NewRecorder()
			handler := &Handler{allowedOrigins: map[string]struct{}{"https://chat.localhost": {}}}
			handler.refresh(response, request)
			if response.Code != test.wantStatus {
				t.Fatalf("refresh status = %d, want %d", response.Code, test.wantStatus)
			}
		})
	}
}

func TestWriteTokensSetsRefreshCookieAndOmitsItFromJSON(t *testing.T) {
	response := httptest.NewRecorder()
	(&Handler{}).writeTokens(response, http.StatusCreated, application.Tokens{
		AccessToken: "access-token", TokenType: "Bearer", ExpiresIn: 900, RefreshToken: "refresh-token",
	})

	if response.Result().Cookies()[0].Value != "refresh-token" {
		t.Fatalf("refresh cookie = %#v", response.Result().Cookies()[0])
	}
	var payload map[string]any
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if _, ok := payload["refresh_token"]; ok {
		t.Fatalf("refresh token leaked in JSON: %v", payload)
	}
}

func TestKYCAuthenticationRequiresAllowlistedAddress(t *testing.T) {
	allowlist, err := NewIPAllowlist("203.0.113.10/32", "172.20.0.4/32")
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "https://kyc.chat.false.tel/api/auth/login", nil)
	request.Host = "kyc.chat.false.tel"
	response := httptest.NewRecorder()
	(&Handler{adminIPs: allowlist}).login(response, request)

	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusForbidden)
	}
}

func TestAdminEndpointRejectsUnallowlistedForwardedAddress(t *testing.T) {
	allowlist, err := NewIPAllowlist("203.0.113.10/32", "172.20.0.4/32")
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "/api/admin/users", nil)
	request.RemoteAddr = "172.20.0.4:43122"
	request.Header.Set("X-Forwarded-For", "198.51.100.25")
	response := httptest.NewRecorder()
	(&Handler{adminIPs: allowlist}).adminUsers(response, request)

	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusForbidden)
	}
}
