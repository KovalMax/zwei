package httptransport

import (
	"context"
	"crypto/elliptic"
	"encoding/base64"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/KovalMax/zwei/services/auth/internal/application"
	sharedauth "github.com/KovalMax/zwei/services/shared/auth"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

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
		{name: "allowlisted same origin", origin: "https://chat.localhost", fetchSite: "same-origin", wantStatus: http.StatusOK},
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
			handler.refreshOriginAllowed(response, request)
			if response.Code != test.wantStatus {
				t.Fatalf("refresh status = %d, want %d", response.Code, test.wantStatus)
			}
		})
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
	(&Handler{adminIPs: allowlist}).authHostAllowed(response, request)

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
