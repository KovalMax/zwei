package httptransport

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/KovalMax/zwei/services/auth/internal/application"
	"github.com/google/uuid"
)

type passwordSetupFake struct {
	calls  int
	input  [4]string
	result application.BrowserSessionResult
}

func (f *passwordSetupFake) CompletePasswordSetup(_ context.Context, token, password, deviceID, deviceName string) (application.BrowserSessionResult, error) {
	f.calls++
	f.input = [4]string{token, password, deviceID, deviceName}
	return f.result, nil
}

func TestPasswordSetupV2IssuesNewSessionAndKeepsRefreshTokenOutOfJSON(t *testing.T) {
	setup := &passwordSetupFake{result: application.BrowserSessionResult{
		BrowserID: uuid.New(), Generation: uuid.New(),
		Tokens: application.Tokens{AccessToken: "access-secret", TokenType: "Bearer", ExpiresIn: 900, RefreshToken: "refresh-secret"},
	}}
	base := &Handler{allowedOrigins: map[string]struct{}{"https://chat.localhost": {}}}
	v2 := NewBrowserV2Handler(base, nil, nil, nil, nil)
	v2.SetPasswordSetup(setup)
	mux := http.NewServeMux()
	v2.Register(mux)
	request := httptest.NewRequest(http.MethodPost, "/api/auth/v2/activate/setup", strings.NewReader(`{"token":"`+strings.Repeat("t", 43)+`","password":"newpassword","device_id":"browser-device","device_name":"Browser"}`))
	request.Host = "chat.localhost"
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", "https://chat.localhost")
	request.AddCookie(&http.Cookie{Name: "zwei_refresh", Value: "ambient-cookie"})
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("status=%d cache=%q body=%s", response.Code, response.Header().Get("Cache-Control"), response.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["status"] != "password_set" || body["access_token"] != "access-secret" || body["refresh_token"] != nil || body["browser_id"] == nil || body["generation"] == nil || body["token_type"] != "Bearer" || body["expires_in"] != float64(900) {
		t.Fatalf("setup JSON=%v", body)
	}
	if setup.calls != 1 || setup.input[0] != strings.Repeat("t", 43) || setup.input[1] != "newpassword" || setup.input[2] != "browser-device" || setup.input[3] != "Browser" {
		t.Fatalf("setup invocation=%+v", setup)
	}
	cookies := response.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Value != "refresh-secret" || !cookies[0].HttpOnly || !cookies[0].Secure || cookies[0].SameSite != http.SameSiteNoneMode || cookies[0].Path != "/api/auth" {
		t.Fatalf("refresh cookie=%+v", cookies)
	}
}

func TestPasswordSetupV2RequiresStrictJSONAndExactAllowedOrigin(t *testing.T) {
	setup := &passwordSetupFake{}
	v2 := NewBrowserV2Handler(&Handler{allowedOrigins: map[string]struct{}{"https://chat.localhost": {}}}, nil, nil, nil, nil)
	v2.SetPasswordSetup(setup)
	mux := http.NewServeMux()
	v2.Register(mux)
	for _, test := range []struct {
		name, body, origin, host string
		status                   int
	}{
		{name: "unknown field", body: `{"token":"` + strings.Repeat("t", 43) + `","password":"newpassword","device_id":"browser-device","extra":true}`, origin: "https://chat.localhost", host: "chat.localhost", status: http.StatusBadRequest},
		{name: "trailing JSON", body: `{"token":"` + strings.Repeat("t", 43) + `","password":"newpassword","device_id":"browser-device"}{}`, origin: "https://chat.localhost", host: "chat.localhost", status: http.StatusBadRequest},
		{name: "unlisted origin", body: `{"token":"` + strings.Repeat("t", 43) + `","password":"newpassword","device_id":"browser-device"}`, origin: "https://evil.test", host: "chat.localhost", status: http.StatusForbidden},
		{name: "unknown host", body: `{"token":"` + strings.Repeat("t", 43) + `","password":"newpassword","device_id":"browser-device"}`, origin: "https://chat.localhost", host: "attacker.example", status: http.StatusForbidden},
		{name: "oversized", body: `{"token":"` + strings.Repeat("t", 17<<10) + `"}`, origin: "https://chat.localhost", host: "chat.localhost", status: http.StatusBadRequest},
	} {
		t.Run(test.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, "/api/auth/v2/activate/setup", strings.NewReader(test.body))
			r.Host = test.host
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("Origin", test.origin)
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, r)
			if w.Code != test.status || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("status=%d want=%d cache=%q body=%s", w.Code, test.status, w.Header().Get("Cache-Control"), w.Body.String())
			}
		})
	}
	if setup.calls != 0 {
		t.Fatalf("invalid requests reached setup: calls=%d", setup.calls)
	}
}

func TestPasswordOnlySetupRouteIsNotInstalled(t *testing.T) {
	mux := http.NewServeMux()
	NewHandler(nil, nil, nil, nil, nil, "").Register(mux)
	r := httptest.NewRequest(http.MethodPost, "/api/auth/activate/setup", strings.NewReader(`{}`))
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != http.StatusNotFound {
		t.Fatalf("retired route status=%d, want 404", w.Code)
	}
}
