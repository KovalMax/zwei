package main

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/KovalMax/zwei/services/shared/pushcrypto"
)

func TestWebSocketRoutesCutOverToV3(t *testing.T) {
	mux := http.NewServeMux()
	muxHandler := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	registerWebSocketRoutes(mux, muxHandler)
	for _, tc := range []struct {
		path string
		want int
	}{
		{"/ws/v2", http.StatusUpgradeRequired},
		{"/ws/v3", http.StatusNoContent},
		{"/ws/v1", http.StatusNotFound},
	} {
		t.Run(tc.path, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, tc.path, nil)
			request.Header.Set("Upgrade", "websocket")
			request.Header.Set("Connection", "Upgrade")
			response := httptest.NewRecorder()
			mux.ServeHTTP(response, request)
			if response.Code != tc.want {
				t.Fatalf("status = %d, want %d", response.Code, tc.want)
			}
		})
	}
}

const testKeyV1 = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
const testKeyV2 = "101112131415161718191a1b1c1d1e1f000102030405060708090a0b0c0d0e0f"

func TestPushCodecFromEnvironmentUsesCurrentAndRetainsOldKey(t *testing.T) {
	t.Setenv("PUSH_SUBSCRIPTION_ENCRYPTION_KEY_V1", testKeyV1)
	t.Setenv("PUSH_SUBSCRIPTION_ENCRYPTION_KEY_V2", testKeyV2)
	t.Setenv("PUSH_SUBSCRIPTION_ENCRYPTION_CURRENT_VERSION", "v2")
	t.Setenv("PUSH_SUBSCRIPTION_FINGERPRINT_KEY", testKeyV1)
	codec, err := pushCodecFromEnvironment()
	if err != nil {
		t.Fatal(err)
	}
	version, _, _, err := codec.Seal(pushcrypto.Subscription{Endpoint: "https://push.example/endpoint"})
	if err != nil || version != "v2" {
		t.Fatalf("write version=%q err=%v", version, err)
	}
}

func TestPushCodecFromEnvironmentRequiresOldKeyForV2(t *testing.T) {
	t.Setenv("PUSH_SUBSCRIPTION_ENCRYPTION_KEY_V1", "")
	t.Setenv("PUSH_SUBSCRIPTION_ENCRYPTION_KEY_V2", testKeyV2)
	t.Setenv("PUSH_SUBSCRIPTION_ENCRYPTION_CURRENT_VERSION", "v2")
	t.Setenv("PUSH_SUBSCRIPTION_FINGERPRINT_KEY", testKeyV1)
	if _, err := pushCodecFromEnvironment(); err == nil {
		t.Fatal("accepted v2 without old read key")
	}
}
