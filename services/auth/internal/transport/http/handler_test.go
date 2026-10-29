package httptransport

import (
	"bytes"
	"context"
	"crypto/elliptic"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/KovalMax/zwei/services/auth/internal/application"
	"github.com/KovalMax/zwei/services/auth/internal/domain/user"
	sharedauth "github.com/KovalMax/zwei/services/shared/auth"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

type logoutRepository struct {
	application.Repository
	owner       uuid.UUID
	err         error
	revoked     bool
	revokedUser uuid.UUID
	revokeErr   error
	hash        []byte
}

func (r *logoutRepository) RefreshTokenOwner(_ context.Context, hash []byte) (uuid.UUID, error) {
	r.hash = append([]byte(nil), hash...)
	return r.owner, r.err
}
func (r *logoutRepository) RevokeAllSessions(_ context.Context, userID uuid.UUID) error {
	r.revoked = true
	r.revokedUser = userID
	return r.revokeErr
}

func TestLogoutRefreshCookieOwnership(t *testing.T) {
	for _, tc := range []struct {
		name             string
		cookie           bool
		owner            string
		lookupErr        error
		revokeErr        error
		status           int
		revoked, cleared bool
	}{
		{"different account", true, "other", nil, nil, http.StatusConflict, true, false},
		{"matching account", true, "same", nil, nil, http.StatusNoContent, true, true},
		{"no cookie", false, "", nil, nil, http.StatusNoContent, true, false},
		{"unknown cookie", true, "", nil, nil, http.StatusConflict, true, false},
		{"lookup failure", true, "", errors.New("sensitive database details"), nil, http.StatusInternalServerError, true, false},
		{"revocation failure with mismatch", true, "other", nil, errors.New("sensitive database details"), http.StatusInternalServerError, true, false},
		{"revocation failure with matching cookie", true, "same", nil, errors.New("sensitive database details"), http.StatusInternalServerError, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, existing, handler, bearer := authenticatedTestHandler(t, false)
			repo := &logoutRepository{err: tc.lookupErr, revokeErr: tc.revokeErr}
			if tc.owner == "same" {
				repo.owner = existing.profile.ID
			}
			if tc.owner == "other" {
				repo.owner = uuid.New()
			}
			handler.auth = application.NewService(repo, nil, nil, time.Minute, time.Hour)
			request := httptest.NewRequest(http.MethodPost, "/api/auth/logout", nil)
			request.Header.Set("Authorization", "Bearer "+bearer)
			if tc.cookie {
				request.AddCookie(&http.Cookie{Name: "zwei_refresh", Value: "secret-refresh"})
			}
			response := httptest.NewRecorder()
			handler.logout(response, request)
			if repo.revoked && repo.revokedUser != existing.profile.ID {
				t.Fatalf("revoked wrong account: %v", repo.revokedUser)
			}
			if tc.revoked && tc.revokeErr == nil && (tc.status == http.StatusConflict || tc.lookupErr != nil) && !strings.Contains(response.Body.String(), "sessions revoked") {
				t.Fatalf("response does not communicate revocation: %s", response.Body.String())
			}
			if tc.cookie {
				want := sha256.Sum256([]byte("secret-refresh"))
				if !bytes.Equal(repo.hash, want[:]) {
					t.Fatal("repository did not receive refresh token hash")
				}
			}
			cleared := false
			marker := false
			for _, cookie := range response.Result().Cookies() {
				if cookie.Name == signedOutCookie {
					marker = true
				} else if cookie.Name == legacyRefreshCookie && cookie.MaxAge < 0 {
					cleared = true
				}
			}
			if response.Code != tc.status || repo.revoked != tc.revoked || cleared != tc.cleared || marker != (tc.revokeErr == nil && tc.revoked) || strings.Contains(response.Body.String(), "secret-refresh") || strings.Contains(response.Body.String(), "sensitive database details") {
				t.Fatalf("status=%d revoked=%v cookies=%d body=%s", response.Code, repo.revoked, len(response.Result().Cookies()), response.Body.String())
			}
		})
	}
}

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

type failingRefreshRepository struct {
	application.Repository
	err error
}

func (r failingRefreshRepository) RotateRefreshToken(context.Context, []byte, []byte, time.Time, func(user.Session) error) error {
	return r.err
}

func (r failingRefreshRepository) RotateRefreshCandidates(context.Context, [][]byte, []byte, time.Time, func(user.Session, []byte) error) error {
	return r.err
}

func TestRefreshMapsRotationErrors(t *testing.T) {
	for _, tc := range []struct {
		name   string
		err    error
		status int
	}{
		{"invalid", application.ErrRefreshToken, http.StatusUnauthorized},
		{"infrastructure", errors.New("sensitive database details"), http.StatusInternalServerError},
	} {
		t.Run(tc.name, func(t *testing.T) {
			service := application.NewService(failingRefreshRepository{err: tc.err}, nil, nil, time.Minute, time.Hour)
			handler := &Handler{auth: service, allowedOrigins: map[string]struct{}{"https://chat.localhost": {}}}
			request := httptest.NewRequest(http.MethodPost, "/api/auth/refresh", nil)
			request.Header.Set("Origin", "https://chat.localhost")
			request.AddCookie(&http.Cookie{Name: "zwei_refresh", Value: "token"})
			response := httptest.NewRecorder()
			handler.refresh(response, request)
			if response.Code != tc.status || strings.Contains(response.Body.String(), "sensitive database details") {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
		})
	}
}

func TestVAPIDPublicKeyEndpointRejectsInvalidCurvePoint(t *testing.T) {
	handler := &Handler{vapidPublicKey: "encoded-public-key"}
	request := httptest.NewRequest(http.MethodGet, "/api/auth/push/vapid-public-key", nil)
	response := httptest.NewRecorder()
	handler.vapidPublicKeyEndpoint(response, request)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("VAPID response = %d %s", response.Code, response.Body)
	}
}

func TestVAPIDPublicKeyEndpointServesValidP256Point(t *testing.T) {
	x, y := elliptic.P256().ScalarBaseMult([]byte{1})
	publicKey := base64.RawURLEncoding.EncodeToString(elliptic.Marshal(elliptic.P256(), x, y))
	response := httptest.NewRecorder()
	(&Handler{vapidPublicKey: publicKey}).vapidPublicKeyEndpoint(response, httptest.NewRequest(http.MethodGet, "/api/auth/push/vapid-public-key", nil))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), publicKey) {
		t.Fatalf("status=%d body=%s", response.Code, response.Body)
	}
}

func TestVAPIDPublicKeyEndpointFailsClosedWhenUnconfigured(t *testing.T) {
	response := httptest.NewRecorder()
	(&Handler{}).vapidPublicKeyEndpoint(response, httptest.NewRequest(http.MethodGet, "/api/auth/push/vapid-public-key", nil))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusServiceUnavailable)
	}
}

func TestPushSubscriptionRequestRejectsCallerSuppliedIdentity(t *testing.T) {
	for _, body := range []string{
		`{"endpoint":"https://fcm.googleapis.com/send/token","keys":{"p256dh":"key","auth":"secret"},"user_id":"account"}`,
		`{"endpoint":"https://fcm.googleapis.com/send/token","keys":{"p256dh":"key","auth":"secret"},"device_id":"device"}`,
	} {
		request := httptest.NewRequest(http.MethodPost, "/api/auth/push-subscription", strings.NewReader(body))
		response := httptest.NewRecorder()
		var payload pushSubscriptionRequest
		if decodeJSON(response, request, &payload) {
			t.Fatalf("accepted caller-supplied identity: %s", body)
		}
	}
}

func TestPushVerificationRequiresAuthenticationAndIsNeverCached(t *testing.T) {
	mux := http.NewServeMux()
	(&Handler{sessions: sharedauth.NewSessionValidator(nil, nil)}).Register(mux)
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/auth/push-subscription/verify", strings.NewReader(`{}`)))
	if response.Code != http.StatusUnauthorized || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("status=%d cache-control=%q", response.Code, response.Header().Get("Cache-Control"))
	}
}

func TestDeleteCurrentPushSubscriptionRequiresAuthentication(t *testing.T) {
	mux := http.NewServeMux()
	(&Handler{sessions: sharedauth.NewSessionValidator(nil, nil)}).Register(mux)
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest(http.MethodDelete, "/api/auth/push-subscription/current", nil))
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d, want unauthorized", response.Code)
	}
}

type currentPushDeleteRepository struct {
	application.Repository
	userID, deviceID uuid.UUID
	version          int64
	err              error
}

type pushStoreRepository struct {
	application.Repository
	userID, deviceID, browserID, generation uuid.UUID
	version                                 int64
	err                                     error
}

type endpointPushDeleteRepository struct {
	application.Repository
	userID, deviceID, browserID, generation uuid.UUID
	version                                 int64
	endpoint                                string
	err                                     error
}

func (r *endpointPushDeleteRepository) DeletePushSubscription(_ context.Context, userID, deviceID uuid.UUID, version int64, browserID, generation uuid.UUID, endpoint string) error {
	r.userID, r.deviceID, r.version, r.browserID, r.generation, r.endpoint = userID, deviceID, version, browserID, generation, endpoint
	return r.err
}

func TestDeletePushSubscriptionAuthenticatedBinding(t *testing.T) {
	secret := []byte("01234567890123456789012345678901")
	userID, deviceID, browserID, generation := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, sharedauth.Claims{DeviceID: deviceID.String(), SessionVersion: 1, BrowserID: browserID.String(), BrowserGeneration: generation.String(), RegisteredClaims: jwt.RegisteredClaims{Subject: userID.String(), ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Minute))}}).SignedString(secret)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		err    error
		status int
	}{{nil, http.StatusNoContent}, {application.ErrPushSessionRevoked, http.StatusUnauthorized}, {errors.New("private details"), http.StatusInternalServerError}} {
		repo := &endpointPushDeleteRepository{err: tc.err}
		mux := http.NewServeMux()
		NewHandler(application.NewService(repo, nil, nil, time.Minute, time.Hour), nil, sharedauth.NewSessionValidator(httpSessionReader{}, secret), nil, nil, "").Register(mux)
		request := httptest.NewRequest(http.MethodDelete, "/api/auth/push-subscription", strings.NewReader(`{"endpoint":"https://fcm.googleapis.com/send/token"}`))
		request.Header.Set("Authorization", "Bearer "+token)
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, request)
		if response.Code != tc.status || repo.userID != userID || repo.deviceID != deviceID || repo.version != 1 || repo.browserID != browserID || repo.generation != generation || repo.endpoint != "https://fcm.googleapis.com/send/token" || strings.Contains(response.Body.String(), "private details") {
			t.Fatalf("status=%d body=%s binding=%v/%v", response.Code, response.Body, repo.browserID, repo.generation)
		}
	}
}

func (r *pushStoreRepository) StorePushSubscription(_ context.Context, userID, deviceID uuid.UUID, version int64, browserID, generation uuid.UUID, _ application.PushSubscription) error {
	r.userID, r.deviceID, r.version, r.browserID, r.generation = userID, deviceID, version, browserID, generation
	return r.err
}

func TestStorePushSubscriptionAuthenticatedBinding(t *testing.T) {
	secret := []byte("01234567890123456789012345678901")
	userID, deviceID, browserID, generation := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, sharedauth.Claims{DeviceID: deviceID.String(), SessionVersion: 1, BrowserID: browserID.String(), BrowserGeneration: generation.String(), RegisteredClaims: jwt.RegisteredClaims{Subject: userID.String(), ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Minute))}}).SignedString(secret)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		err    error
		status int
	}{{nil, http.StatusNoContent}, {application.ErrPushSessionRevoked, http.StatusUnauthorized}} {
		repo := &pushStoreRepository{err: tc.err}
		mux := http.NewServeMux()
		NewHandler(application.NewService(repo, nil, nil, time.Minute, time.Hour), nil, sharedauth.NewSessionValidator(httpSessionReader{}, secret), nil, nil, "").Register(mux)
		body := `{"endpoint":"https://fcm.googleapis.com/send/token","keys":{"p256dh":"BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","auth":"AAAAAAAAAAAAAAAAAAAAAA"}}`
		request := httptest.NewRequest(http.MethodPost, "/api/auth/push-subscription", strings.NewReader(body))
		request.Header.Set("Authorization", "Bearer "+token)
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, request)
		if response.Code != tc.status || repo.userID != userID || repo.deviceID != deviceID || repo.version != 1 || repo.browserID != browserID || repo.generation != generation {
			t.Fatalf("status=%d body=%s binding=%v/%v", response.Code, response.Body, repo.browserID, repo.generation)
		}
	}
}

func (r *currentPushDeleteRepository) DeleteCurrentPushSubscription(_ context.Context, userID, deviceID uuid.UUID, version int64, browserID, generation uuid.UUID) error {
	r.userID, r.deviceID, r.version = userID, deviceID, version
	return r.err
}

func TestDeleteCurrentPushSubscriptionAuthenticated(t *testing.T) {
	secret := []byte("01234567890123456789012345678901")
	userID, deviceID := uuid.New(), uuid.New()
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, sharedauth.Claims{DeviceID: deviceID.String(), SessionVersion: 1, BrowserID: uuid.NewString(), BrowserGeneration: uuid.NewString(), RegisteredClaims: jwt.RegisteredClaims{Subject: userID.String(), ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Minute))}}).SignedString(secret)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		err    error
		status int
	}{{nil, http.StatusNoContent}, {application.ErrPushSessionRevoked, http.StatusUnauthorized}, {errors.New("private details"), http.StatusInternalServerError}} {
		repo := &currentPushDeleteRepository{err: tc.err}
		handler := NewHandler(application.NewService(repo, nil, nil, time.Minute, time.Hour), nil, sharedauth.NewSessionValidator(httpSessionReader{}, secret), nil, nil, "")
		mux := http.NewServeMux()
		handler.Register(mux)
		request := httptest.NewRequest(http.MethodDelete, "/api/auth/push-subscription/current", nil)
		request.Header.Set("Authorization", "Bearer "+token)
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, request)
		if response.Code != tc.status || repo.userID != userID || repo.deviceID != deviceID || repo.version != 1 || strings.Contains(response.Body.String(), "private details") {
			t.Fatalf("status=%d body=%s identity=%v/%v/%d", response.Code, response.Body, repo.userID, repo.deviceID, repo.version)
		}
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

func TestGiphyAdminRoutesRejectSourceIPBeforeAuthentication(t *testing.T) {
	allowlist, err := NewIPAllowlist("203.0.113.10/32", "172.20.0.4/32")
	if err != nil {
		t.Fatal(err)
	}
	handler := NewHandler(nil, nil, nil, allowlist, nil, "")
	mux := http.NewServeMux()
	handler.Register(mux)
	for _, method := range []string{http.MethodGet, http.MethodPut} {
		t.Run(method, func(t *testing.T) {
			request := httptest.NewRequest(method, "/api/admin/media-sources/giphy", nil)
			request.RemoteAddr = "198.51.100.20:4444"
			response := httptest.NewRecorder()
			mux.ServeHTTP(response, request)
			if response.Code != http.StatusForbidden {
				t.Fatalf("status = %d, want %d", response.Code, http.StatusForbidden)
			}
		})
	}
}
