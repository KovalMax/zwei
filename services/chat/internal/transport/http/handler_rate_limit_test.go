package httptransport

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/KovalMax/zwei/services/chat/internal/application"
	"github.com/KovalMax/zwei/services/chat/internal/domain/conversation"
	sharedauth "github.com/KovalMax/zwei/services/shared/auth"
)

type testRequestLimiter struct {
	allowed bool
	err     error
	bucket  string
	userID  uuid.UUID
}

func (l *testRequestLimiter) Allow(_ context.Context, userID uuid.UUID, bucket string) (bool, error) {
	l.userID = userID
	l.bucket = bucket
	return l.allowed, l.err
}

func TestAllowReturnsTooManyRequestsAndRetryAfter(t *testing.T) {
	handler := &Handler{limiter: &testRequestLimiter{}}
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
	handler := &Handler{limiter: &testRequestLimiter{err: errors.New("redis unavailable")}}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/chat/conversations", nil)

	if handler.allow(recorder, request, uuid.New(), "conversation-list") {
		t.Fatal("allow() returned true while limiter was unavailable")
	}
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusServiceUnavailable)
	}
}

func TestAllowFailsClosedWhenLimiterIsNotConfigured(t *testing.T) {
	handler := &Handler{}
	recorder := httptest.NewRecorder()
	if handler.allow(recorder, httptest.NewRequest(http.MethodGet, "/api/chat/groups", nil), uuid.New(), application.RateBucketGroupList) {
		t.Fatal("allow() returned true without the shared limiter")
	}
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusServiceUnavailable)
	}
}

func TestGroupMutationUsesSharedUserScopedBucket(t *testing.T) {
	limiter := &testRequestLimiter{allowed: true}
	handler := &Handler{limiter: limiter}
	request := httptest.NewRequest(http.MethodPatch, "/api/chat/groups/group-1", nil)

	if !handler.allowGroupMutation(httptest.NewRecorder(), request, uuid.New()) {
		t.Fatal("allowGroupMutation() rejected an allowed request")
	}
	if limiter.bucket != application.RateBucketGroupMutation {
		t.Fatalf("group mutation bucket = %q, want %q", limiter.bucket, application.RateBucketGroupMutation)
	}
}

func TestGroupReadsRateLimitBeforeQuery(t *testing.T) {
	const secret = "0123456789abcdef0123456789abcdef"
	userID := uuid.New()
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, sharedauth.Claims{
		SessionVersion: 7,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   userID.String(),
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Minute)),
		},
	}).SignedString([]byte(secret))
	if err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name   string
		method string
		path   string
		bucket string
	}{
		{name: "list", method: http.MethodGet, path: "/api/chat/groups", bucket: application.RateBucketGroupList},
		{name: "get", method: http.MethodGet, path: "/api/chat/groups/" + uuid.NewString(), bucket: application.RateBucketGroupGet},
	}
	for _, test := range tests {
		for _, outcome := range []struct {
			name       string
			limiterErr error
			status     int
		}{
			{name: "denied", status: http.StatusTooManyRequests},
			{name: "unavailable", limiterErr: errors.New("redis unavailable"), status: http.StatusServiceUnavailable},
		} {
			t.Run(test.name+"/"+outcome.name, func(t *testing.T) {
				limiter := &testRequestLimiter{allowed: false, err: outcome.limiterErr}
				store := &rateLimitGroupStore{}
				handler := &Handler{
					groups:   application.NewGroups(store),
					limiter:  limiter,
					sessions: sharedauth.NewSessionValidator(rateLimitSessionReader{}, []byte(secret)),
				}
				mux := http.NewServeMux()
				handler.Register(mux)
				request := httptest.NewRequest(test.method, test.path, nil)
				request.Header.Set("Authorization", "Bearer "+token)
				recorder := httptest.NewRecorder()
				mux.ServeHTTP(recorder, request)

				if recorder.Code != outcome.status {
					t.Fatalf("status = %d, want %d; body=%s", recorder.Code, outcome.status, recorder.Body)
				}
				if limiter.bucket != test.bucket {
					t.Fatalf("limiter bucket = %q, want %q", limiter.bucket, test.bucket)
				}
				if limiter.userID != userID {
					t.Fatalf("limiter user ID = %s, want authenticated user %s", limiter.userID, userID)
				}
				if store.listCalls != 0 || store.getCalls != 0 {
					t.Fatalf("rejected request queried groups: list=%d get=%d", store.listCalls, store.getCalls)
				}
				if outcome.status == http.StatusTooManyRequests && recorder.Header().Get("Retry-After") != "60" {
					t.Fatalf("Retry-After = %q, want 60", recorder.Header().Get("Retry-After"))
				}
			})
		}
	}
}

type rateLimitGroupStore struct {
	application.GroupStore
	listCalls int
	getCalls  int
}

func (s *rateLimitGroupStore) ListGroupsPage(context.Context, uuid.UUID, int, bool, *application.GroupPageCursor) (application.GroupPage, error) {
	s.listCalls++
	return application.GroupPage{}, nil
}

func (s *rateLimitGroupStore) GetGroup(context.Context, uuid.UUID, uuid.UUID) (conversation.Group, error) {
	s.getCalls++
	return conversation.Group{}, nil
}

type rateLimitSessionReader struct{}

func (rateLimitSessionReader) QueryRow(context.Context, string, ...any) pgx.Row {
	return rateLimitSessionRow{}
}

type rateLimitSessionRow struct{}

func (rateLimitSessionRow) Scan(dest ...any) error {
	if len(dest) != 1 {
		return errors.New("unexpected session scan")
	}
	version, ok := dest[0].(*int64)
	if !ok {
		return errors.New("unexpected session version destination")
	}
	*version = 7
	return nil
}
