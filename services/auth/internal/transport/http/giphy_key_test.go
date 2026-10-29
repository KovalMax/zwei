package httptransport

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	sharedauth "github.com/KovalMax/zwei/services/shared/auth"
)

func TestGiphyKeyGrantRequiresAuthenticatedEnabledPolicyAndConfiguredKey(t *testing.T) {
	t.Run("grants configured key without caching", func(t *testing.T) {
		_, _, handler, bearer := authenticatedTestHandler(t, false)
		handler.giphyAPIKey = "configured-test-key"
		response := performGiphyKeyRequest(handler, bearer)

		if response.Code != http.StatusOK || response.Body.String() != `{"api_key":"configured-test-key"}`+"\n" {
			t.Fatalf("response = %d %s", response.Code, response.Body)
		}
		if response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("Cache-Control = %q, want no-store", response.Header().Get("Cache-Control"))
		}
	})

	t.Run("denies anonymous request", func(t *testing.T) {
		_, _, handler, _ := authenticatedTestHandler(t, false)
		response := performGiphyKeyRequest(handler, "")
		assertGiphyKeyError(t, response, http.StatusUnauthorized)
	})

	t.Run("denies revoked session", func(t *testing.T) {
		_, _, handler, bearer := authenticatedTestHandler(t, false)
		handler.sessions = sharedauth.NewSessionValidator(revokedHTTPReader{}, []byte("01234567890123456789012345678901"))
		response := performGiphyKeyRequest(handler, bearer)
		assertGiphyKeyError(t, response, http.StatusUnauthorized)
	})

	t.Run("denies disabled policy", func(t *testing.T) {
		_, repository, handler, bearer := authenticatedTestHandler(t, false)
		repository.giphyEnabled = false
		handler.giphyAPIKey = "configured-test-key"
		response := performGiphyKeyRequest(handler, bearer)
		assertGiphyKeyError(t, response, http.StatusForbidden)
	})

	t.Run("sanitizes policy repository failure", func(t *testing.T) {
		_, repository, handler, bearer := authenticatedTestHandler(t, false)
		repository.giphyErr = context.DeadlineExceeded
		handler.giphyAPIKey = "configured-test-key"
		response := performGiphyKeyRequest(handler, bearer)
		assertGiphyKeyError(t, response, http.StatusServiceUnavailable)
		if strings.Contains(response.Body.String(), "DeadlineExceeded") || strings.Contains(response.Body.String(), handler.giphyAPIKey) {
			t.Fatalf("error response leaked internal details: %s", response.Body)
		}
	})

	t.Run("fails closed when key is not configured", func(t *testing.T) {
		_, _, handler, bearer := authenticatedTestHandler(t, false)
		response := performGiphyKeyRequest(handler, bearer)
		assertGiphyKeyError(t, response, http.StatusServiceUnavailable)
	})
}

func performGiphyKeyRequest(handler *Handler, bearer string) *httptest.ResponseRecorder {
	mux := http.NewServeMux()
	handler.Register(mux)
	request := httptest.NewRequest(http.MethodGet, "/api/auth/giphy-key", nil)
	if bearer != "" {
		request.Header.Set("Authorization", "Bearer "+bearer)
	}
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	return response
}

func assertGiphyKeyError(t *testing.T, response *httptest.ResponseRecorder, status int) {
	t.Helper()
	if response.Code != status {
		t.Fatalf("status = %d, want %d: %s", response.Code, status, response.Body)
	}
	if strings.Contains(response.Body.String(), `"api_key"`) {
		t.Fatalf("error response contains an API key field: %s", response.Body)
	}
	if strings.Contains(response.Body.String(), "configured-test-key") {
		t.Fatalf("error response leaked the configured key: %s", response.Body)
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", response.Header().Get("Cache-Control"))
	}
}

type revokedHTTPReader struct{}

func (revokedHTTPReader) QueryRow(context.Context, string, ...any) pgx.Row {
	return revokedHTTPSessionRow{}
}

type revokedHTTPSessionRow struct{}

func (revokedHTTPSessionRow) Scan(dest ...any) error {
	*dest[0].(*bool) = false
	return nil
}
