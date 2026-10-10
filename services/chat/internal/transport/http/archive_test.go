package httptransport

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"

	"github.com/KovalMax/zwei/services/chat/internal/application"
	sharedauth "github.com/KovalMax/zwei/services/shared/auth"
)

type archiveServiceFake struct {
	userID, conversationID uuid.UUID
	archived               bool
	err                    error
	calls                  int
}

func (f *archiveServiceFake) Set(_ context.Context, userID, conversationID uuid.UUID, archived bool) error {
	f.calls++
	f.userID = userID
	f.conversationID = conversationID
	f.archived = archived
	return f.err
}

func TestArchiveRoutesUseAuthenticatedUserAndMapNonEnumeration(t *testing.T) {
	const secret = "0123456789abcdef0123456789abcdef"
	userID, conversationID := uuid.New(), uuid.New()
	store := &archiveServiceFake{}
	h := &Handler{archive: store, limiter: &testRequestLimiter{allowed: true}, sessions: sharedauth.NewSessionValidator(rateLimitSessionReader{}, []byte(secret))}
	mux := http.NewServeMux()
	h.Register(mux)
	for _, test := range []struct {
		method   string
		archived bool
	}{{http.MethodPut, true}, {http.MethodDelete, false}} {
		req := authenticatedGroupRequest(t, secret, userID, "/api/chat/conversations/"+conversationID.String()+"/archive")
		req.Method = test.method
		recorder := httptest.NewRecorder()
		mux.ServeHTTP(recorder, req)
		if recorder.Code != http.StatusNoContent || store.userID != userID || store.conversationID != conversationID || store.archived != test.archived {
			t.Fatalf("%s status=%d store=%+v", test.method, recorder.Code, store)
		}
	}
	store.err = application.ErrConversationNotFound
	req := authenticatedGroupRequest(t, secret, userID, "/api/chat/conversations/"+conversationID.String()+"/archive")
	req.Method = http.MethodPut
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("inaccessible status=%d, want 404", recorder.Code)
	}
	store.err = errors.New("database unavailable")
	req = authenticatedGroupRequest(t, secret, userID, "/api/chat/conversations/"+conversationID.String()+"/archive")
	req.Method = http.MethodPut
	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("storage failure status=%d, want 500", recorder.Code)
	}
}

func TestArchiveRouteRejectsMalformedID(t *testing.T) {
	const secret = "0123456789abcdef0123456789abcdef"
	store := &archiveServiceFake{}
	h := &Handler{archive: store, limiter: &testRequestLimiter{allowed: true}, sessions: sharedauth.NewSessionValidator(rateLimitSessionReader{}, []byte(secret))}
	mux := http.NewServeMux()
	h.Register(mux)
	req := authenticatedGroupRequest(t, secret, uuid.New(), "/api/chat/conversations/not-a-uuid/archive")
	req.Method = http.MethodPut
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusBadRequest || store.calls != 0 {
		t.Fatalf("status=%d calls=%d", recorder.Code, store.calls)
	}
}

func TestArchiveMutationFailsClosedWhenSharedLimiterDeniesOrIsUnavailable(t *testing.T) {
	const secret = "0123456789abcdef0123456789abcdef"
	userID, conversationID := uuid.New(), uuid.New()
	for _, method := range []string{http.MethodPut, http.MethodDelete} {
		for _, test := range []struct {
			name    string
			limiter *testRequestLimiter
			status  int
		}{
			{name: "denied", limiter: &testRequestLimiter{allowed: false}, status: http.StatusTooManyRequests},
			{name: "unavailable", limiter: &testRequestLimiter{err: errors.New("redis unavailable")}, status: http.StatusServiceUnavailable},
		} {
			t.Run(method+"/"+test.name, func(t *testing.T) {
				store := &archiveServiceFake{}
				h := &Handler{archive: store, limiter: test.limiter, sessions: sharedauth.NewSessionValidator(rateLimitSessionReader{}, []byte(secret))}
				mux := http.NewServeMux()
				h.Register(mux)
				req := authenticatedGroupRequest(t, secret, userID, "/api/chat/conversations/"+conversationID.String()+"/archive")
				req.Method = method
				recorder := httptest.NewRecorder()
				mux.ServeHTTP(recorder, req)
				if recorder.Code != test.status || store.calls != 0 {
					t.Fatalf("status=%d calls=%d, want %d/0", recorder.Code, store.calls, test.status)
				}
				if test.limiter.bucket != application.RateBucketGroupMutation || test.limiter.userID != userID {
					t.Fatalf("limiter bucket/user=%q/%s", test.limiter.bucket, test.limiter.userID)
				}
				if test.status == http.StatusTooManyRequests && recorder.Header().Get("Retry-After") != "60" {
					t.Fatalf("Retry-After=%q, want 60", recorder.Header().Get("Retry-After"))
				}
			})
		}
	}
}
