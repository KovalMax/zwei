package httptransport

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"

	"github.com/KovalMax/zwei/services/chat/internal/domain/conversation"
	sharedauth "github.com/KovalMax/zwei/services/shared/auth"
)

func TestParseHistoryPageQuery(t *testing.T) {
	tests := []struct {
		name       string
		query      string
		wantLimit  int
		wantBefore int64
		wantErr    error
	}{
		{name: "defaults", wantLimit: 20},
		{name: "maximum limit and positive cursor", query: "limit=100&before=42", wantLimit: 100, wantBefore: 42},
		{name: "minimum limit", query: "limit=1", wantLimit: 1},
		{name: "limit prefix junk", query: "limit=20junk", wantErr: errInvalidHistoryLimit},
		{name: "cursor suffix junk", query: "before=42x", wantErr: errInvalidHistoryCursor},
		{name: "repeated limit", query: "limit=20&limit=30", wantErr: errInvalidHistoryLimit},
		{name: "repeated cursor", query: "before=42&before=43", wantErr: errInvalidHistoryCursor},
		{name: "unknown key", query: "limit=20&offset=1", wantErr: errInvalidHistoryLimit},
		{name: "malformed escaping", query: "limit=%2", wantErr: errInvalidHistoryLimit},
		{name: "empty limit", query: "limit=", wantErr: errInvalidHistoryLimit},
		{name: "empty cursor", query: "before=", wantErr: errInvalidHistoryCursor},
		{name: "out of range limit", query: "limit=101", wantErr: errInvalidHistoryLimit},
		{name: "zero cursor", query: "before=0", wantErr: errInvalidHistoryCursor},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			limit, before, err := parseHistoryPageQuery(test.query)
			if test.wantErr != nil {
				if !errors.Is(err, test.wantErr) {
					t.Fatalf("error = %v, want %v", err, test.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseHistoryPageQuery() error = %v", err)
			}
			if limit != test.wantLimit || before != test.wantBefore {
				t.Fatalf("got limit=%d before=%d, want limit=%d before=%d", limit, before, test.wantLimit, test.wantBefore)
			}
		})
	}
}

func TestHistoryMessagesRejectsInvalidQueryBeforeStoreCall(t *testing.T) {
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

	for _, test := range []struct {
		query        string
		wantResponse string
	}{
		{query: "limit=20junk", wantResponse: `{"error":"invalid limit"}`},
		{query: "before=42x", wantResponse: `{"error":"invalid cursor"}`},
		{query: "limit=20&limit=30", wantResponse: `{"error":"invalid limit"}`},
		{query: "before=42&before=43", wantResponse: `{"error":"invalid cursor"}`},
		{query: "unknown=1", wantResponse: `{"error":"invalid limit"}`},
		{query: "limit=%2", wantResponse: `{"error":"invalid limit"}`},
	} {
		t.Run(test.query, func(t *testing.T) {
			store := &historyQueryStore{}
			handler := &Handler{
				history:  store,
				limiter:  &testRequestLimiter{allowed: true},
				sessions: sharedauth.NewSessionValidator(rateLimitSessionReader{}, []byte(secret)),
			}
			mux := http.NewServeMux()
			handler.Register(mux)
			request := httptest.NewRequest(http.MethodGet, "/api/chat/conversations/"+uuid.NewString()+"/messages?"+test.query, nil)
			request.Header.Set("Authorization", "Bearer "+token)
			recorder := httptest.NewRecorder()
			mux.ServeHTTP(recorder, request)

			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want %d; body=%s", recorder.Code, http.StatusBadRequest, recorder.Body)
			}
			if !strings.Contains(recorder.Body.String(), test.wantResponse) {
				t.Fatalf("body = %s, want error response %s", recorder.Body, test.wantResponse)
			}
			if store.calls != 0 {
				t.Fatalf("history store called %d times for invalid query", store.calls)
			}
		})
	}
}

type historyQueryStore struct {
	calls  int
	before int64
	limit  int
}

func (s *historyQueryStore) List(_ context.Context, _, _ uuid.UUID, before int64, limit int) ([]conversation.Message, string, error) {
	s.calls++
	s.before, s.limit = before, limit
	return []conversation.Message{}, "", nil
}

func TestHistoryMessagesPassesDefaultAndValidatedBounds(t *testing.T) {
	const secret = "0123456789abcdef0123456789abcdef"
	userID := uuid.New()
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, sharedauth.Claims{
		SessionVersion:   7,
		RegisteredClaims: jwt.RegisteredClaims{Subject: userID.String(), ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Minute))},
	}).SignedString([]byte(secret))
	if err != nil {
		t.Fatal(err)
	}

	for _, test := range []struct {
		query  string
		limit  int
		before int64
	}{{query: "", limit: 20}, {query: "limit=100&before=9223372036854775807", limit: 100, before: 9223372036854775807}} {
		store := &historyQueryStore{}
		handler := &Handler{
			history:  store,
			limiter:  &testRequestLimiter{allowed: true},
			sessions: sharedauth.NewSessionValidator(rateLimitSessionReader{}, []byte(secret)),
		}
		mux := http.NewServeMux()
		handler.Register(mux)
		request := httptest.NewRequest(http.MethodGet, "/api/chat/conversations/"+uuid.NewString()+"/messages?"+test.query, nil)
		request.Header.Set("Authorization", "Bearer "+token)
		recorder := httptest.NewRecorder()
		mux.ServeHTTP(recorder, request)

		if recorder.Code != http.StatusOK {
			t.Fatalf("query %q: status = %d, want %d; body=%s", test.query, recorder.Code, http.StatusOK, recorder.Body)
		}
		if store.calls != 1 || store.limit != test.limit || store.before != test.before {
			t.Fatalf("query %q: store calls=%d limit=%d before=%d", test.query, store.calls, store.limit, store.before)
		}
	}
}
