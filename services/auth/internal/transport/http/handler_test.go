package httptransport

import (
	"net/http"
	"net/http/httptest"
	"testing"
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
	response := httptest.NewRecorder()

	(&Handler{}).refresh(response, request)

	if response.Code != http.StatusUnauthorized {
		t.Fatalf("refresh status = %d, want %d", response.Code, http.StatusUnauthorized)
	}
}
