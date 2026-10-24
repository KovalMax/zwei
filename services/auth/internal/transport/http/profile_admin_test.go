package httptransport

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/KovalMax/zwei/services/auth/internal/application"
	"github.com/KovalMax/zwei/services/auth/internal/domain/user"
	sharedauth "github.com/KovalMax/zwei/services/shared/auth"
)

func TestProfileHTTPUpdateDistinguishesFalseFromOmitted(t *testing.T) {
	_, _, handler, bearer := authenticatedTestHandler(t, false)
	for _, test := range []struct {
		name     string
		body     string
		status   int
		wantAuto bool
	}{
		{name: "explicit false", body: `{"auto_load_approved_media":false}`, status: http.StatusOK, wantAuto: false},
		{name: "omitted update is empty", body: `{}`, status: http.StatusBadRequest, wantAuto: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPatch, "/api/auth/me", strings.NewReader(test.body))
			request.Header.Set("Authorization", "Bearer "+bearer)
			response := httptest.NewRecorder()
			handler.updateMe(response, request)
			if response.Code != test.status {
				t.Fatalf("status = %d, want %d: %s", response.Code, test.status, response.Body)
			}
			if test.status == http.StatusOK {
				var profile user.Profile
				if err := json.NewDecoder(response.Body).Decode(&profile); err != nil {
					t.Fatal(err)
				}
				if profile.AutoLoadApprovedMedia != test.wantAuto {
					t.Fatalf("auto-load = %v", profile.AutoLoadApprovedMedia)
				}
			}
		})
	}
}

func TestAuthenticatedMediaPolicyRouteAndAdminSettingRoute(t *testing.T) {
	_, repository, handler, bearer := authenticatedTestHandler(t, true)
	request := httptest.NewRequest(http.MethodGet, "/api/auth/media-policy", nil)
	request.Header.Set("Authorization", "Bearer "+bearer)
	response := httptest.NewRecorder()
	handler.mediaPolicy(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"giphy_enabled":true`) {
		t.Fatalf("media policy response = %d %s", response.Code, response.Body)
	}

	allowlist, err := NewIPAllowlist("203.0.113.7/32", "172.20.0.4/32")
	if err != nil {
		t.Fatal(err)
	}
	handler.adminIPs = allowlist
	request = httptest.NewRequest(http.MethodPut, "/api/admin/media-sources/giphy", strings.NewReader(`{"enabled":false}`))
	request.Header.Set("Authorization", "Bearer "+bearer)
	request.RemoteAddr = "172.20.0.4:4444"
	request.Header.Set("X-Forwarded-For", "203.0.113.7")
	response = httptest.NewRecorder()
	handler.updateAdminGiphy(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"enabled":false`) || repository.giphyEnabled {
		t.Fatalf("admin setting response = %d %s; persisted=%v", response.Code, response.Body, repository.giphyEnabled)
	}
}

func authenticatedTestHandler(t *testing.T, isAdmin bool) (*application.Service, *httpTestRepository, *Handler, string) {
	t.Helper()
	secret := []byte("01234567890123456789012345678901")
	userID := uuid.New()
	encoded, err := jwt.NewWithClaims(jwt.SigningMethodHS256, sharedauth.Claims{SessionVersion: 1, RegisteredClaims: jwt.RegisteredClaims{Subject: userID.String(), ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Minute))}}).SignedString(secret)
	if err != nil {
		t.Fatal(err)
	}
	repository := &httpTestRepository{profile: user.Profile{ID: userID, AutoLoadApprovedMedia: true}, isAdmin: isAdmin, giphyEnabled: true}
	service := application.NewService(repository, nil, nil, time.Minute, time.Hour)
	admins := application.NewAdminService(repository, nil, nil, "", "")
	reader := httpSessionReader{}
	handler := NewHandler(service, admins, sharedauth.NewSessionValidator(reader, secret), nil, nil, "")
	return service, repository, handler, encoded
}

type httpSessionReader struct{}

func (httpSessionReader) QueryRow(context.Context, string, ...any) pgx.Row { return httpSessionRow{} }

type httpSessionRow struct{}

func (httpSessionRow) Scan(dest ...any) error { *dest[0].(*int64) = 1; return nil }

type httpTestRepository struct {
	application.Repository
	profile      user.Profile
	isAdmin      bool
	giphyEnabled bool
	giphyErr     error
}

func (r *httpTestRepository) Profile(context.Context, uuid.UUID) (user.Profile, error) {
	return r.profile, nil
}
func (r *httpTestRepository) UpdateProfile(_ context.Context, _ uuid.UUID, name, retention, alertMode *string, media *bool) error {
	if alertMode != nil {
		r.profile.AlertMode = *alertMode
	}
	if name != nil {
		r.profile.DisplayName = *name
	}
	if retention != nil {
		r.profile.RetentionPeriod = *retention
	}
	if media != nil {
		r.profile.AutoLoadApprovedMedia = *media
	}
	return nil
}
func (r *httpTestRepository) GiphyEnabled(context.Context) (bool, error) {
	return r.giphyEnabled, r.giphyErr
}
func (r *httpTestRepository) SetGiphyEnabled(_ context.Context, enabled bool) (bool, error) {
	r.giphyEnabled = enabled
	return enabled, nil
}
func (r *httpTestRepository) IsAdmin(context.Context, uuid.UUID) (bool, error) { return r.isAdmin, nil }
