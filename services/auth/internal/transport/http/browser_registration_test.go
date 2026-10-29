package httptransport

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/KovalMax/zwei/services/auth/internal/application"
)

type registrationFake struct {
	pending bool
	current *application.BrowserCredential
	calls   int
}

func (f *registrationFake) Register(_ context.Context, _ application.Credentials, current *application.BrowserCredential) (bool, application.BrowserSessionResult, error) {
	f.calls++
	f.current = current
	return f.pending, v2Result(), nil
}

func TestV2RegistrationResponse(t *testing.T) {
	for _, pending := range []bool{true, false} {
		fake := &registrationFake{pending: pending}
		h := NewBrowserV2Handler(NewHandler(nil, nil, nil, nil, map[string]struct{}{"https://chat.localhost": {}}, ""), nil, nil, nil, nil)
		h.SetRegistration(fake)
		body := `{"email":"test@example.test","password":"password","display_name":"Test","device_id":"device"}`
		if !pending {
			body = `{"email":"test@example.test","password":"password","display_name":"Test","device_id":"device","invitation_code":"secret"}`
		}
		r := httptest.NewRequest(http.MethodPost, "https://chat.localhost/api/auth/v2/register", strings.NewReader(body))
		r.Header.Set("Origin", "https://chat.localhost")
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		h.RegisterAccount(w, r)
		if fake.calls != 1 {
			t.Fatalf("registration calls: %d", fake.calls)
		}
		if pending {
			if w.Code != http.StatusAccepted || len(w.Result().Cookies()) != 0 || !strings.Contains(w.Body.String(), `"pending"`) {
				t.Fatalf("pending: %d %s", w.Code, w.Body.String())
			}
		} else {
			if w.Code != http.StatusCreated || len(w.Result().Cookies()) != 1 || strings.Contains(w.Body.String(), "refresh_token") || !strings.Contains(w.Body.String(), "browser_id") {
				t.Fatalf("invited: %d %s", w.Code, w.Body.String())
			}
			cookie := w.Result().Cookies()[0]
			if !cookie.HttpOnly || !cookie.Secure || cookie.SameSite != http.SameSiteNoneMode || cookie.Path != "/api/auth" {
				t.Fatalf("cookie attributes: %+v", cookie)
			}
		}
	}
}

func TestV2RegistrationRejectsInvalidBoundary(t *testing.T) {
	fake := &registrationFake{}
	h := NewBrowserV2Handler(NewHandler(nil, nil, nil, nil, map[string]struct{}{"https://chat.localhost": {}}, ""), nil, nil, nil, nil)
	h.SetRegistration(fake)
	r := httptest.NewRequest(http.MethodPost, "https://chat.localhost/api/auth/v2/register", strings.NewReader(`{"extra":true}`))
	r.Header.Set("Origin", "https://chat.localhost")
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.RegisterAccount(w, r)
	if w.Code != http.StatusBadRequest || fake.calls != 0 {
		t.Fatalf("status=%d calls=%d", w.Code, fake.calls)
	}
}
