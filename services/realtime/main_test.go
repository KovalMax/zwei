package main

import (
	"context"
	"net/url"
	"strings"
	"sync/atomic"
	"time"

	"github.com/KovalMax/zwei/services/realtime/internal/application"
	websockettransport "github.com/KovalMax/zwei/services/realtime/internal/transport/websocket"
	sharedauth "github.com/KovalMax/zwei/services/shared/auth"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/KovalMax/zwei/services/shared/pushcrypto"
)

func TestWebSocketRoutesCutOverToV4(t *testing.T) {
	mux := http.NewServeMux()
	muxHandler := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	registerWebSocketRoutes(mux, muxHandler)
	for _, tc := range []struct {
		path string
		want int
	}{
		{"/ws/v2", http.StatusUpgradeRequired},
		{"/ws/v3", http.StatusUpgradeRequired},
		{"/ws/v4", http.StatusNoContent},
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

type routeTicketConsumer struct{ used atomic.Bool }

func (c *routeTicketConsumer) ConsumeWebSocketTicket(context.Context, string) (bool, error) {
	return c.used.CompareAndSwap(false, true), nil
}

type routeSessionReader struct{}
type routeSessionRow struct{}

func (routeSessionReader) QueryRow(context.Context, string, ...any) pgx.Row { return routeSessionRow{} }
func (routeSessionRow) Scan(dest ...any) error                              { *dest[0].(*bool) = true; return nil }

func TestV3RejectionDoesNotConsumeTicketBeforeV4Upgrade(t *testing.T) {
	secret := []byte("01234567890123456789012345678901")
	consumer := &routeTicketConsumer{}
	handler := websockettransport.NewHandler(context.Background(), application.NewHub(nil, nil, nil, nil, nil, nil, nil), sharedauth.NewSessionValidator(routeSessionReader{}, secret), consumer, map[string]struct{}{"https://chat.localhost": {}})
	mux := http.NewServeMux()
	registerWebSocketRoutes(mux, handler)
	server := httptest.NewServer(mux)
	defer server.Close()
	ticket, err := jwt.NewWithClaims(jwt.SigningMethodHS256, sharedauth.Claims{BrowserID: uuid.NewString(), BrowserGeneration: uuid.NewString(), SessionVersion: 3, DeviceID: "device", Purpose: "websocket", RegisteredClaims: jwt.RegisteredClaims{Subject: uuid.NewString(), ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Minute))}}).SignedString(secret)
	if err != nil {
		t.Fatal(err)
	}
	dial := func(path string) (*websocket.Conn, *http.Response, error) {
		return websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+path+"?ticket="+url.QueryEscape(ticket), http.Header{"Origin": []string{"https://chat.localhost"}})
	}
	_, response, err := dial("/ws/v3")
	if err == nil || response == nil || response.StatusCode != http.StatusUpgradeRequired || consumer.used.Load() {
		t.Fatal("v3 did not reject before ticket consumption")
	}
	response.Body.Close()
	conn, response, err := dial("/ws/v4")
	if err != nil {
		if response != nil {
			response.Body.Close()
		}
		t.Fatal("v4 upgrade failed")
	}
	defer conn.Close()
	if !consumer.used.Load() {
		t.Fatal("v4 did not consume ticket")
	}
	_, response, err = dial("/ws/v4")
	if err == nil || response == nil || response.StatusCode != http.StatusUnauthorized {
		t.Fatal("reused ticket accepted")
	}
	response.Body.Close()
}
