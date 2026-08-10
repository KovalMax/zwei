package runtime

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestConfigureHTTPServerSetsBoundedTimeouts(t *testing.T) {
	server := &http.Server{}

	ConfigureHTTPServer(server)

	if server.ReadHeaderTimeout != 5*time.Second {
		t.Fatalf("read header timeout = %s", server.ReadHeaderTimeout)
	}
	if server.ReadTimeout != 15*time.Second {
		t.Fatalf("read timeout = %s", server.ReadTimeout)
	}
	if server.WriteTimeout != 15*time.Second {
		t.Fatalf("write timeout = %s", server.WriteTimeout)
	}
	if server.IdleTimeout != 60*time.Second {
		t.Fatalf("idle timeout = %s", server.IdleTimeout)
	}
	if server.MaxHeaderBytes != 1<<20 {
		t.Fatalf("max header bytes = %d", server.MaxHeaderBytes)
	}
}

func TestConfigureWebSocketServerOnlyBoundsUpgrade(t *testing.T) {
	server := &http.Server{}

	ConfigureWebSocketServer(server)

	if server.ReadHeaderTimeout != 5*time.Second {
		t.Fatalf("read header timeout = %s", server.ReadHeaderTimeout)
	}
	if server.ReadTimeout != 0 || server.WriteTimeout != 0 || server.IdleTimeout != 0 {
		t.Fatalf("streaming server received request/response timeout: %+v", server)
	}
	if server.MaxHeaderBytes != 1<<20 {
		t.Fatalf("max header bytes = %d", server.MaxHeaderBytes)
	}
}

func TestWithCORSAllowsConfiguredOrigin(t *testing.T) {
	nextCalled := false
	handler := WithCORS(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		nextCalled = true
		w.WriteHeader(http.StatusNoContent)
	}), map[string]struct{}{"https://chat.localhost": {}})

	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.Header.Set("Origin", "https://chat.localhost")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if !nextCalled || response.Code != http.StatusNoContent {
		t.Fatalf("response = %d, next called = %t", response.Code, nextCalled)
	}
	if got := response.Header().Get("Access-Control-Allow-Origin"); got != "https://chat.localhost" {
		t.Fatalf("allowed origin = %q", got)
	}
	if got := response.Header().Get("Access-Control-Allow-Credentials"); got != "true" {
		t.Fatalf("allow credentials = %q", got)
	}
}

func TestWithCORSRejectsUnknownPreflightOrigin(t *testing.T) {
	handler := WithCORS(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("next handler was called")
	}), map[string]struct{}{"https://chat.localhost": {}})

	request := httptest.NewRequest(http.MethodOptions, "/", nil)
	request.Header.Set("Origin", "https://untrusted.example")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusForbidden {
		t.Fatalf("response = %d, want %d", response.Code, http.StatusForbidden)
	}
}
