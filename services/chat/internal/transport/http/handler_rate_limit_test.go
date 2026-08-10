package httptransport

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
)

type testRequestLimiter struct {
	allowed bool
	err     error
}

func (l testRequestLimiter) Allow(context.Context, uuid.UUID, string) (bool, error) {
	return l.allowed, l.err
}

func TestAllowReturnsTooManyRequestsAndRetryAfter(t *testing.T) {
	handler := &Handler{limiter: testRequestLimiter{}}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/chat/conversations", nil)

	if handler.allow(recorder, request, uuid.New(), "conversation-list") {
		t.Fatal("allow() returned true for a rejected request")
	}
	if recorder.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusTooManyRequests)
	}
	if recorder.Header().Get("Retry-After") != "60" {
		t.Fatalf("Retry-After = %q, want 60", recorder.Header().Get("Retry-After"))
	}
}

func TestAllowFailsClosedWhenLimiterUnavailable(t *testing.T) {
	handler := &Handler{limiter: testRequestLimiter{err: errors.New("redis unavailable")}}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/chat/conversations", nil)

	if handler.allow(recorder, request, uuid.New(), "conversation-list") {
		t.Fatal("allow() returned true while limiter was unavailable")
	}
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusServiceUnavailable)
	}
}
