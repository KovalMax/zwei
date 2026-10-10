package httptransport

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"

	"github.com/KovalMax/zwei/services/chat/internal/application"
	"github.com/KovalMax/zwei/services/chat/internal/domain/conversation"
	sharedauth "github.com/KovalMax/zwei/services/shared/auth"
)

type groupPageStoreFake struct {
	application.GroupStore
	calls    int
	userID   uuid.UUID
	limit    int
	cursor   *application.GroupPageCursor
	archived bool
	page     application.GroupPage
}

func (s *groupPageStoreFake) ListGroupsPage(_ context.Context, userID uuid.UUID, limit int, archived bool, cursor *application.GroupPageCursor) (application.GroupPage, error) {
	s.calls++
	s.userID, s.limit, s.cursor, s.archived = userID, limit, cursor, archived
	return s.page, nil
}

func TestParseGroupPageQueryRejectsRepeatedMalformedAndOversizedValues(t *testing.T) {
	for _, raw := range []string{
		"limit=1&limit=2", "limit=", "limit=0", "limit=-1", "limit=26", "limit=999999999999999999999999",
		"cursor=a&cursor=b", "cursor=", "cursor=" + strings.Repeat("a", maxGroupCursorLength+1), "cursor=%%%",
	} {
		t.Run(raw, func(t *testing.T) {
			if _, _, _, err := parseGroupPageQuery(raw); err == nil {
				t.Fatalf("parseGroupPageQuery(%q) succeeded", raw)
			}
		})
	}
}

func TestParseGroupPageQueryDefaultsAndParsesVersionedCursor(t *testing.T) {
	limit, archived, cursor, err := parseGroupPageQuery("")
	if err != nil || limit != 25 || archived || cursor != nil {
		t.Fatalf("default parse = (%d, %v, %v), want (25, nil, nil)", limit, cursor, err)
	}
	id := uuid.New()
	key := application.GroupSortKey{SortAt: time.Date(2026, 2, 3, 4, 5, 6, 123456000, time.UTC), GroupID: id}
	encoded, err := encodeGroupCursor(application.GroupPageCursor{Upper: key, After: key})
	if err != nil {
		t.Fatal(err)
	}
	limit, archived, cursor, err = parseGroupPageQuery("limit=25&cursor=" + encoded)
	if err != nil || limit != 25 || archived || cursor == nil || cursor.Upper != key || cursor.After != key {
		t.Fatalf("cursor parse = (%d, %+v, %v), want matching typed cursor", limit, cursor, err)
	}
}

func TestGroupCursorScopeIsEncodedAndV1MeansActive(t *testing.T) {
	id := uuid.New()
	key := application.GroupSortKey{SortAt: time.Date(2026, 4, 5, 6, 7, 8, 0, time.UTC), GroupID: id}
	activeV1 := groupCursorWire{Version: 1, Upper: encodeGroupSortKey(key), After: encodeGroupSortKey(key)}
	data, err := json.Marshal(activeV1)
	if err != nil {
		t.Fatal(err)
	}
	legacy := base64.RawURLEncoding.EncodeToString(data)
	cursor, err := decodeGroupCursor(legacy)
	if err != nil || cursor.Archived {
		t.Fatalf("legacy cursor=%+v err=%v", cursor, err)
	}
	archived, err := encodeGroupCursor(application.GroupPageCursor{Upper: key, After: key, Archived: true})
	if err != nil {
		t.Fatal(err)
	}
	archivedData, err := base64.RawURLEncoding.DecodeString(archived)
	if err != nil {
		t.Fatal(err)
	}
	var archivedWire groupCursorWire
	if err := json.Unmarshal(archivedData, &archivedWire); err != nil || archivedWire.Version != 2 || !archivedWire.Archived {
		t.Fatalf("archived cursor wire=%+v err=%v, want v2 archived", archivedWire, err)
	}
	if _, archivedScope, _, err := parseGroupPageQuery("archived=true&cursor=" + archived); err != nil || !archivedScope {
		t.Fatalf("archived cursor scope=%t err=%v", archivedScope, err)
	}
	if _, _, _, err := parseGroupPageQuery("cursor=" + archived); err == nil {
		t.Fatal("accepted archived cursor in active scope")
	}
	active, err := encodeGroupCursor(application.GroupPageCursor{Upper: key, After: key})
	if err != nil {
		t.Fatal(err)
	}
	if active != legacy {
		t.Fatalf("encoded active cursor = %q, want legacy v1 %q", active, legacy)
	}
	activeData, err := base64.RawURLEncoding.DecodeString(active)
	if err != nil {
		t.Fatal(err)
	}
	var activeWire groupCursorWire
	if err := json.Unmarshal(activeData, &activeWire); err != nil || activeWire.Version != 1 || activeWire.Archived {
		t.Fatalf("active cursor wire=%+v err=%v, want legacy v1", activeWire, err)
	}
	if _, _, _, err := parseGroupPageQuery("archived=true&cursor=" + active); err == nil {
		t.Fatal("accepted active cursor in archived scope")
	}
	if _, activeScope, _, err := parseGroupPageQuery("archived=false&cursor=" + legacy); err != nil || activeScope {
		t.Fatalf("explicit active scope=%t err=%v", activeScope, err)
	}
	for _, raw := range []string{"archived=maybe", "archived=true&archived=false"} {
		if _, _, _, err := parseGroupPageQuery(raw); err == nil {
			t.Fatalf("accepted malformed archive scope %q", raw)
		}
	}
}

func TestListGroupsReturnsBoundedEnvelopeAndUsesAuthenticatedIdentity(t *testing.T) {
	const secret = "0123456789abcdef0123456789abcdef"
	userID := uuid.New()
	groupID := uuid.New()
	key := application.GroupSortKey{SortAt: time.Date(2026, 3, 4, 5, 6, 7, 0, time.UTC), GroupID: groupID}
	store := &groupPageStoreFake{page: application.GroupPage{
		Items:      []conversation.Group{{ID: groupID, Name: "Team", LastMessageAt: key.SortAt, Members: []conversation.GroupMember{{UserID: userID, DisplayName: "Caller", Role: conversation.RoleOwner}}}},
		NextCursor: &application.GroupPageCursor{Upper: key, After: key},
	}}
	limiter := &testRequestLimiter{allowed: true}
	handler := &Handler{groups: application.NewGroups(store), limiter: limiter, sessions: sharedauth.NewSessionValidator(rateLimitSessionReader{}, []byte(secret))}
	mux := http.NewServeMux()
	handler.Register(mux)
	request := authenticatedGroupRequest(t, secret, userID, "/api/chat/groups")
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", recorder.Code, recorder.Body)
	}
	var response struct {
		Items      []conversation.Group `json:"items"`
		NextCursor *string              `json:"next_cursor"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if len(response.Items) != 1 || response.Items[0].ID != groupID || response.NextCursor == nil {
		t.Fatalf("response = %+v, want group and cursor", response)
	}
	if store.calls != 1 || store.userID != userID || store.limit != 25 || limiter.bucket != application.RateBucketGroupList {
		t.Fatalf("store calls/user/limit=%d/%s/%d limiter=%q", store.calls, store.userID, store.limit, limiter.bucket)
	}
}

func TestListGroupsRejectsBadQueryBeforeStoreAndCapsAtTwentyFive(t *testing.T) {
	const secret = "0123456789abcdef0123456789abcdef"
	userID := uuid.New()
	for _, path := range []string{"/api/chat/groups?limit=26", "/api/chat/groups?limit=2&limit=3", "/api/chat/groups?cursor=not-a-cursor"} {
		store := &groupPageStoreFake{}
		handler := testGroupListHandler(secret, store, &testRequestLimiter{allowed: true})
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, authenticatedGroupRequest(t, secret, userID, path))
		if recorder.Code != http.StatusBadRequest || store.calls != 0 {
			t.Fatalf("path %s status=%d store calls=%d", path, recorder.Code, store.calls)
		}
	}
	store := &groupPageStoreFake{}
	handler := testGroupListHandler(secret, store, &testRequestLimiter{allowed: true})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, authenticatedGroupRequest(t, secret, userID, "/api/chat/groups?limit=25"))
	if recorder.Code != http.StatusOK || store.limit != 25 {
		t.Fatalf("max request status=%d requested limit=%d", recorder.Code, store.limit)
	}
}

func TestListGroupsPassesArchivedScopeToApplication(t *testing.T) {
	const secret = "0123456789abcdef0123456789abcdef"
	userID := uuid.New()
	store := &groupPageStoreFake{}
	handler := testGroupListHandler(secret, store, &testRequestLimiter{allowed: true})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, authenticatedGroupRequest(t, secret, userID, "/api/chat/groups?archived=true"))
	if recorder.Code != http.StatusOK || store.calls != 1 || !store.archived {
		t.Fatalf("status=%d calls=%d archived=%t", recorder.Code, store.calls, store.archived)
	}
}

func TestListGroupsRateLimitDenialAndFailureAreBeforeStore(t *testing.T) {
	const secret = "0123456789abcdef0123456789abcdef"
	userID := uuid.New()
	for _, test := range []struct {
		name    string
		limiter *testRequestLimiter
		status  int
	}{
		{name: "denied", limiter: &testRequestLimiter{allowed: false}, status: http.StatusTooManyRequests},
		{name: "unavailable", limiter: &testRequestLimiter{err: fmt.Errorf("redis unavailable")}, status: http.StatusServiceUnavailable},
	} {
		t.Run(test.name, func(t *testing.T) {
			store := &groupPageStoreFake{}
			handler := testGroupListHandler(secret, store, test.limiter)
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, authenticatedGroupRequest(t, secret, userID, "/api/chat/groups"))
			if recorder.Code != test.status || store.calls != 0 {
				t.Fatalf("status=%d calls=%d, want %d/0", recorder.Code, store.calls, test.status)
			}
			if test.status == http.StatusTooManyRequests && recorder.Header().Get("Retry-After") != "60" {
				t.Fatalf("Retry-After = %q", recorder.Header().Get("Retry-After"))
			}
		})
	}
}

func testGroupListHandler(secret string, store *groupPageStoreFake, limiter *testRequestLimiter) http.Handler {
	handler := &Handler{groups: application.NewGroups(store), limiter: limiter, sessions: sharedauth.NewSessionValidator(rateLimitSessionReader{}, []byte(secret))}
	mux := http.NewServeMux()
	handler.Register(mux)
	return mux
}

func authenticatedGroupRequest(t *testing.T, secret string, userID uuid.UUID, path string) *http.Request {
	t.Helper()
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, sharedauth.Claims{SessionVersion: 7, RegisteredClaims: jwt.RegisteredClaims{Subject: userID.String(), ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Minute))}}).SignedString([]byte(secret))
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, path, nil)
	request.Header.Set("Authorization", "Bearer "+token)
	return request
}
