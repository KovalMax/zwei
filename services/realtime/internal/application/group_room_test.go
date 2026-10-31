package application

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	sharedauth "github.com/KovalMax/zwei/services/shared/auth"
)

func TestGroupCallSignalNegotiationIDShape(t *testing.T) {
	for _, tc := range []struct {
		signal string
		valid  bool
	}{
		{`{"type":"offer","sdp":"opaque","negotiation_id":"8c72dd14-fafe-4e2d-9735-e09c37358bf1"}`, true},
		{`{"type":"answer","sdp":"opaque","negotiation_id":"8c72dd14-fafe-4e2d-9735-e09c37358bf1"}`, true},
		{`{"type":"offer","sdp":"opaque"}`, false},
		{`{"type":"answer","sdp":"opaque","negotiation_id":"bad"}`, false},
		{`{"type":"answer","sdp":"opaque","negotiation_id":"00000000-0000-0000-0000-000000000000"}`, false},
		{`{"type":"offer","sdp":"opaque","negotiation_id":42}`, false},
		{`{"type":"candidate","candidate":{"candidate":"","usernameFragment":"ice","sdpMid":"audio"}}`, true},
		{`{"type":"screen-share-started"}`, true},
		{`{"type":"candidate","candidate":{},"negotiation_id":"8c72dd14-fafe-4e2d-9735-e09c37358bf1"}`, false},
	} {
		if got := validGroupCallSignal(json.RawMessage(tc.signal)); got != tc.valid {
			t.Errorf("signal %s: got %v, want %v", tc.signal, got, tc.valid)
		}
	}
}

func TestGroupCandidateIdentity(t *testing.T) {
	const prefix = `{"type":"candidate","candidate":`
	for _, tc := range []struct {
		name, candidate string
		valid           bool
	}{
		{"empty marker", `{"candidate":"","usernameFragment":"abc","sdpMid":"0"}`, true},
		{"line ufrag", `{"candidate":"candidate:1 1 udp 1 example.invalid 9 typ host ufrag abc","sdpMLineIndex":0}`, true},
		{"line tab separator", `{"candidate":"candidate:1\t1 udp 1 x 9 typ host ufrag abc","sdpMLineIndex":0}`, true},
		{"line non-ascii separator", `{"candidate":"candidate:1\u00a01 udp 1 x 9 typ host ufrag abc","sdpMLineIndex":0}`, false},
		{"line non-ascii token", `{"candidate":"candidate:a\u00a0b 1 udp 1 x 9 typ host ufrag abc","sdpMLineIndex":0}`, true},
		{"non-ascii username whitespace", `{"candidate":"","usernameFragment":"a\u0085b","sdpMid":"0"}`, false},
		{"both selectors", `{"candidate":"","usernameFragment":"abc","sdpMid":"0","sdpMLineIndex":65535}`, true},
		{"null optional fields", `{"candidate":"","usernameFragment":"abc","sdpMid":null,"sdpMLineIndex":0}`, true},
		{"integral number", `{"candidate":"","usernameFragment":"abc","sdpMLineIndex":1.0}`, true},
		{"missing identity", `{}`, false},
		{"missing ufrag", `{"candidate":"","sdpMid":"0"}`, false},
		{"missing selector", `{"candidate":"","usernameFragment":"abc"}`, false},
		{"negative index", `{"candidate":"","usernameFragment":"abc","sdpMLineIndex":-1}`, false},
		{"index overflow", `{"candidate":"","usernameFragment":"abc","sdpMLineIndex":65536}`, false},
		{"fractional index", `{"candidate":"","usernameFragment":"abc","sdpMLineIndex":1.5}`, false},
		{"invalid line", `{"candidate":"opaque","usernameFragment":"abc","sdpMid":"0"}`, false},
		{"conflicting ufrag", `{"candidate":"candidate:1 1 udp 1 x 9 typ host ufrag old","usernameFragment":"new","sdpMid":"0"}`, false},
		{"duplicate ufrag", `{"candidate":"candidate:1 1 udp 1 x 9 typ host ufrag old ufrag old","sdpMid":"0"}`, false},
		{"unknown field", `{"candidate":"","usernameFragment":"abc","sdpMid":"0","extra":true}`, false},
		{"incorrect field case", `{"Candidate":"","usernameFragment":"abc","sdpMid":"0"}`, false},
		{"oversized mid", `{"candidate":"","usernameFragment":"abc","sdpMid":"` + strings.Repeat("a", 257) + `"}`, false},
		{"oversized ufrag", `{"candidate":"","usernameFragment":"` + strings.Repeat("a", 257) + `","sdpMid":"0"}`, false},
		{"oversized line", `{"candidate":"candidate:1 1 udp 1 x 9 typ host ` + strings.Repeat("a", 4096) + `","usernameFragment":"abc","sdpMid":"0"}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := validGroupCallSignal(json.RawMessage(prefix + tc.candidate + `}`)); got != tc.valid {
				t.Fatalf("valid = %v, want %v", got, tc.valid)
			}
		})
	}
}

func TestGroupCallSignalRoutesOnlyToOwningSocket(t *testing.T) {
	ownerID, peerID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	room := GroupRoom{ID: roomID, ConversationID: conversationID, MembershipRevision: 3, Generation: 1, Status: GroupRoomActive, Participants: []GroupParticipant{{UserID: ownerID, DeviceID: "owner", ConnectionID: "owner-socket"}, {UserID: peerID, DeviceID: "peer", ConnectionID: "peer-socket"}}}
	presence := &groupTestPresence{revision: 3, memberIDs: []uuid.UUID{ownerID, peerID}}
	var logs bytes.Buffer
	hub := NewHubWithGroupCallAuthorizer(nil, presence, presence, &groupTestRooms{room: room}, nil, nil, nil, nil, nil, slog.New(slog.NewJSONHandler(&logs, nil)))
	owner := &recordingClient{identity: sharedauth.Identity{UserID: ownerID, DeviceID: "owner"}, connectionID: "owner-socket"}
	sibling := &recordingClient{identity: owner.identity, connectionID: "sibling"}
	peer := &recordingClient{identity: sharedauth.Identity{UserID: peerID, DeviceID: "peer"}, connectionID: "peer-socket"}
	for _, client := range []*recordingClient{owner, sibling, peer} {
		hub.Add(context.Background(), client)
		client.events = nil
	}
	for _, signal := range []string{
		`{"type":"answer","sdp":"private","negotiation_id":"8c72dd14-fafe-4e2d-9735-e09c37358bf1"}`,
		`{"type":"candidate","candidate":{"candidate":"","sdpMid":"audio","sdpMLineIndex":0,"usernameFragment":"secret-fragment"}}`,
	} {
		owner.events, sibling.events = nil, nil
		request := `{"version":3,"type":"group.call.signal","request_id":"signal","payload":{"conversation_id":"` + conversationID.String() + `","room_id":"` + roomID.String() + `","generation":1,"target_user_id":"` + ownerID.String() + `","target_device_id":"owner","signal":` + signal + `}}`
		if err := hub.HandleVersion(context.Background(), peer, 3, []byte(request)); err != nil {
			t.Fatal(err)
		}
		if len(owner.events) != 1 || len(sibling.events) != 0 {
			t.Fatalf("events: owner=%d sibling=%d", len(owner.events), len(sibling.events))
		}
		payload, err := json.Marshal(owner.events[0].(serverEvent).Payload)
		if err != nil || !bytes.Contains(payload, []byte(signal)) {
			t.Fatalf("signal not preserved, err=%v", err)
		}
	}
	if strings.Contains(logs.String(), "secret-fragment") || strings.Contains(logs.String(), "private") {
		t.Fatal("signal content leaked into logs")
	}
}

func TestHubRejectsExtraFieldsOnGroupScreenShareMarkers(t *testing.T) {
	for _, signal := range []string{
		`{"type":"screen-share-started","sdp":"private"}`,
		`{"type":"screen-share-stopped","candidate":{}}`,
	} {
		t.Run(signal, func(t *testing.T) {
			client := &recordingClient{identity: sharedauth.Identity{UserID: uuid.New(), DeviceID: "device"}}
			hub := NewHubWithGroupCallAuthorizer(nil, nil, nil, nil, nil, nil, nil, nil, nil, nil)
			request := `{"version":3,"type":"group.call.signal","request_id":"group-signal-shape","payload":{"conversation_id":"` + uuid.NewString() + `","room_id":"` + uuid.NewString() + `","generation":1,"target_user_id":"` + uuid.NewString() + `","target_device_id":"target","signal":` + signal + `}}`
			err := hub.HandleVersion(context.Background(), client, 3, []byte(request))
			if err == nil || !strings.Contains(err.Error(), "invalid group call signal") {
				t.Fatalf("HandleVersion() error = %v, want invalid group call signal", err)
			}
		})
	}
}

func TestHubRejectsInvalidGroupNegotiationIDBeforeRouting(t *testing.T) {
	client := &recordingClient{identity: sharedauth.Identity{UserID: uuid.New(), DeviceID: "device"}}
	hub := NewHubWithGroupCallAuthorizer(nil, nil, nil, nil, nil, nil, nil, nil, nil, nil)
	for _, signal := range []string{`{"type":"offer","sdp":"private"}`, `{"type":"answer","sdp":"private","negotiation_id":"invalid"}`, `{"type":"candidate","candidate":{"candidate":"","sdpMid":"audio"}}`} {
		request := `{"version":3,"type":"group.call.signal","request_id":"invalid","payload":{"conversation_id":"` + uuid.NewString() + `","room_id":"` + uuid.NewString() + `","generation":1,"target_user_id":"` + uuid.NewString() + `","target_device_id":"target","signal":` + signal + `}}`
		if err := hub.HandleVersion(context.Background(), client, 3, []byte(request)); err == nil || err.Error() != "invalid group call signal" {
			t.Fatalf("expected invalid group call signal, got %v", err)
		}
	}
}

func TestHubStartsGroupRoomOnlyForCurrentV2Member(t *testing.T) {
	userID, memberID, conversationID := uuid.New(), uuid.New(), uuid.New()
	presence := &groupTestPresence{revision: 4, memberIDs: []uuid.UUID{userID, memberID}}
	rooms := &groupTestRooms{}
	hub := NewHubWithGroupCallAuthorizer(nil, presence, presence, rooms, nil, nil, nil, nil, nil, nil)
	pushQueue := &callPushRecorder{}
	hub.SetCallPushQueue(pushQueue)
	client := &recordingClient{identity: sharedauth.Identity{UserID: userID, DeviceID: "device"}, connectionID: "socket"}
	member := &recordingClient{identity: sharedauth.Identity{UserID: memberID, DeviceID: "member-device"}, connectionID: "member-socket"}
	hub.Add(context.Background(), client)
	hub.Add(context.Background(), member)
	member.events = nil

	err := hub.HandleVersion(context.Background(), client, 3, []byte(`{"version":3,"type":"group.call.start","request_id":"start-1","payload":{"attempt_id":"00000000-0000-4000-8000-000000000001","conversation_id":"`+conversationID.String()+`"}}`))
	if err != nil {
		t.Fatalf("start group room: %v", err)
	}
	if rooms.room.ConversationID != conversationID || rooms.room.MembershipRevision != 4 || len(rooms.room.Participants) != 1 || rooms.room.Participants[0].ConnectionID != "socket" {
		t.Fatalf("room = %#v", rooms.room)
	}
	if len(member.events) != 1 {
		t.Fatalf("member events = %#v", member.events)
	}
	if len(pushQueue.jobs) != 1 || pushQueue.jobs[0].CallID != rooms.room.ID || !pushQueue.jobs[0].Group || len(pushQueue.jobs[0].Recipients) != 1 || pushQueue.jobs[0].Recipients[0] != memberID || pushQueue.jobs[0].StarterID != userID {
		t.Fatalf("group call push job = %+v; want authorized member only, excluding starter", pushQueue.jobs)
	}
	if !pushQueue.jobs[0].ExpiresAt.Equal(rooms.room.RingExpiresAt) || !rooms.room.RingExpiresAt.Before(rooms.room.ExpiresAt) {
		t.Fatalf("push must expire at invitation deadline, not room deadline: job=%+v room=%+v", pushQueue.jobs[0], rooms.room)
	}
}

func TestGroupCallStartLinearizesWithMembershipRevocation(t *testing.T) {
	ownerID, memberID, conversationID := uuid.New(), uuid.New(), uuid.New()
	order := &groupStartOrder{revision: 4, memberIDs: []uuid.UUID{ownerID, memberID}}
	rooms := &orderedGroupStartRooms{groupTestRooms: groupTestRooms{}, entered: make(chan struct{}), continueStart: make(chan struct{}), order: order}
	hub := NewHubWithGroupCallAuthorizer(nil, order, order, rooms, nil, nil, nil, nil, nil, nil)
	client := &recordingClient{identity: sharedauth.Identity{UserID: ownerID, DeviceID: "device"}, connectionID: "socket"}
	request := []byte(`{"version":3,"type":"group.call.start","request_id":"start-1","payload":{"attempt_id":"00000000-0000-4000-8000-000000000001","conversation_id":"` + conversationID.String() + `"}}`)
	started := make(chan error, 1)
	go func() { started <- hub.HandleVersion(context.Background(), client, 3, request) }()
	<-rooms.entered // Redis Start is inside the held PostgreSQL-style lease.

	revocationStarted := make(chan struct{})
	revocationCommitted := make(chan struct{})
	allowProjection := make(chan struct{})
	revocationDone := make(chan error, 1)
	go func() {
		close(revocationStarted)
		revocationDone <- order.revokeAndProject(hub, conversationID, ownerID, revocationCommitted, allowProjection)
	}()
	<-revocationStarted
	select {
	case err := <-revocationDone:
		t.Fatalf("revocation passed the start lease before Redis Start completed: %v", err)
	default:
	}

	close(rooms.continueStart)
	if err := <-started; err != nil {
		t.Fatalf("start group room: %v", err)
	}
	<-revocationCommitted
	close(allowProjection)
	if err := <-revocationDone; err != nil {
		t.Fatalf("revoke after start: %v", err)
	}
	got := order.snapshot()
	if !(indexOf(got, "admission.acquire") < indexOf(got, "lease.begin") && indexOf(got, "lease.begin") < indexOf(got, "redis.start") && indexOf(got, "redis.start") < indexOf(got, "lease.commit") && indexOf(got, "lease.commit") < indexOf(got, "membership.revoke") && indexOf(got, "membership.revoke") < indexOf(got, "projection.cleanup")) {
		t.Fatalf("invalid admission/lease/start/commit ordering: %v", got)
	}
	if rooms.room.Status != GroupRoomEnded {
		t.Fatalf("projection did not clean up started room: %#v", rooms.room)
	}
}

func TestGroupCallDiscoveryReturnsOnlyCurrentJoinableRoom(t *testing.T) {
	ownerID, memberID, conversationID := uuid.New(), uuid.New(), uuid.New()
	roomID := uuid.New()
	for _, test := range []struct {
		name       string
		room       GroupRoom
		roomErr    error
		revision   int64
		wantRoom   bool
		wantStatus string
		wantEnd    bool
	}{
		{name: "no room", roomErr: ErrCallNotFound, revision: 4},
		{name: "ringing room", room: GroupRoom{ID: roomID, ConversationID: conversationID, MembershipRevision: 4, Generation: 2, StateRevision: 1, Status: GroupRoomRinging}, revision: 4, wantRoom: true, wantStatus: GroupRoomRinging},
		{name: "active room", room: GroupRoom{ID: roomID, ConversationID: conversationID, MembershipRevision: 4, Generation: 2, StateRevision: 3, Status: GroupRoomActive, Participants: []GroupParticipant{{UserID: ownerID, DeviceID: "owner", ConnectionID: "owner-socket"}, {UserID: memberID, DeviceID: "member", ConnectionID: "member-socket"}}}, revision: 4, wantRoom: true, wantStatus: GroupRoomActive},
		{name: "ended room", room: GroupRoom{ID: roomID, ConversationID: conversationID, MembershipRevision: 4, Generation: 2, StateRevision: 4, Status: GroupRoomEnded}, revision: 4},
		{name: "stale membership room", room: GroupRoom{ID: roomID, ConversationID: conversationID, MembershipRevision: 3, Generation: 2, StateRevision: 3, Status: GroupRoomActive}, revision: 4, wantEnd: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			rooms := &discoveryGroupRooms{groupTestRooms: groupTestRooms{room: test.room}, getErr: test.roomErr}
			authorizer := &discoveryAuthorizer{groupTestPresence: &groupTestPresence{}, revision: test.revision, memberIDs: []uuid.UUID{ownerID, memberID}}
			hub := NewHubWithGroupCallAuthorizer(nil, authorizer, authorizer, rooms, nil, nil, nil, nil, nil, nil)
			client := &recordingClient{identity: sharedauth.Identity{UserID: ownerID, DeviceID: "owner"}, connectionID: "owner-socket"}
			request := []byte(`{"version":3,"type":"group.call.discover","request_id":"discover-1","payload":{"conversation_id":"` + conversationID.String() + `"}}`)
			if err := hub.HandleVersion(context.Background(), client, 3, request); err != nil {
				t.Fatalf("discover: %v", err)
			}
			if len(client.events) != 1 {
				t.Fatalf("events = %#v, want one correlated response", client.events)
			}
			event := client.events[0].(serverEvent)
			if event.Type != "group.call.discovered" || event.RequestID != "discover-1" {
				t.Fatalf("response = %#v", event)
			}
			payload := event.Payload.(struct {
				ConversationID uuid.UUID  `json:"conversation_id"`
				Room           *GroupRoom `json:"room"`
			})
			if payload.ConversationID != conversationID || (payload.Room != nil) != test.wantRoom || rooms.endCalls != boolCount(test.wantEnd) {
				t.Fatalf("payload=%#v endCalls=%d", payload, rooms.endCalls)
			}
			if payload.Room != nil && (payload.Room.Status != test.wantStatus || payload.Room.Generation != 2) {
				t.Fatalf("discovered room=%#v", payload.Room)
			}
			if payload.Room != nil {
				encoded, marshalErr := json.Marshal(event)
				if marshalErr != nil {
					t.Fatal(marshalErr)
				}
				if !bytes.Contains(encoded, []byte(`"state_revision":`+fmt.Sprint(test.room.StateRevision))) || bytes.Contains(encoded, []byte("connection_id")) || bytes.Contains(encoded, []byte("ice_servers")) {
					t.Fatalf("discovery wire DTO differs from safe room contract: %s", encoded)
				}
			}
			if !authorizer.rolledBack {
				t.Fatal("authorization lease was not released")
			}
		})
	}
}

func TestGroupCallDiscoveryRejectsNonmemberWithoutRoomDisclosure(t *testing.T) {
	userID, conversationID := uuid.New(), uuid.New()
	authorizer := &discoveryAuthorizer{groupTestPresence: &groupTestPresence{}, err: ErrCallNotAllowed}
	rooms := &discoveryGroupRooms{groupTestRooms: groupTestRooms{room: GroupRoom{ID: uuid.New(), ConversationID: conversationID, Status: GroupRoomActive}}}
	hub := NewHubWithGroupCallAuthorizer(nil, authorizer, authorizer, rooms, nil, nil, nil, nil, nil, nil)
	client := &recordingClient{identity: sharedauth.Identity{UserID: userID, DeviceID: "device"}, connectionID: "socket"}
	err := hub.HandleVersion(context.Background(), client, 3, []byte(`{"version":3,"type":"group.call.discover","request_id":"private","payload":{"conversation_id":"`+conversationID.String()+`"}}`))
	var requestErr *RequestError
	if !errors.As(err, &requestErr) || !errors.Is(err, ErrCallNotAllowed) {
		t.Fatalf("discover error=%v, want not allowed", err)
	}
	if len(client.events) != 0 || rooms.getCalls != 0 {
		t.Fatalf("nonmember received data or reached Redis: events=%#v reads=%d", client.events, rooms.getCalls)
	}
}

func TestGroupCallDiscoveryUsesSharedRealtimeRateLimit(t *testing.T) {
	userID, conversationID := uuid.New(), uuid.New()
	authorizer := &discoveryAuthorizer{groupTestPresence: &groupTestPresence{}, revision: 1}
	rooms := &discoveryGroupRooms{groupTestRooms: groupTestRooms{room: GroupRoom{ID: uuid.New(), ConversationID: conversationID, MembershipRevision: 1, Generation: 1, Status: GroupRoomActive}}, rateLimited: true}
	hub := NewHubWithGroupCallAuthorizer(nil, authorizer, authorizer, rooms, nil, nil, nil, nil, nil, nil)
	client := &recordingClient{identity: sharedauth.Identity{UserID: userID, DeviceID: "device"}, connectionID: "socket"}
	err := hub.HandleVersion(context.Background(), client, 3, []byte(`{"version":3,"type":"group.call.discover","request_id":"limited","payload":{"conversation_id":"`+conversationID.String()+`"}}`))
	var requestErr *RequestError
	if !errors.As(err, &requestErr) || !strings.Contains(err.Error(), "rate limit") {
		t.Fatalf("discover error=%v, want rate limit rejection", err)
	}
	if rooms.getCalls != 0 || len(client.events) != 0 {
		t.Fatalf("rate-limited discovery touched room state or replied: reads=%d events=%#v", rooms.getCalls, client.events)
	}
}

func TestGroupCallFailsClosedWhenCoordinatorLacksSharedRateLimit(t *testing.T) {
	userID, conversationID := uuid.New(), uuid.New()
	authorizer := &discoveryAuthorizer{groupTestPresence: &groupTestPresence{}, revision: 1}
	rooms := &groupTestRooms{room: GroupRoom{ID: uuid.New(), ConversationID: conversationID, MembershipRevision: 1, Generation: 1, Status: GroupRoomActive}}
	coordinator := groupCoordinatorWithoutRateLimit{GroupRoomCoordinator: rooms, PresenceCoordinator: rooms}
	hub := NewHubWithGroupCallAuthorizer(nil, authorizer, authorizer, coordinator, nil, nil, nil, nil, nil, nil)
	client := &recordingClient{identity: sharedauth.Identity{UserID: userID, DeviceID: "device"}}

	err := hub.HandleVersion(context.Background(), client, 3, []byte(`{"version":3,"type":"group.call.discover","request_id":"missing-limiter","payload":{"conversation_id":"`+conversationID.String()+`"}}`))
	var requestErr *RequestError
	if !errors.As(err, &requestErr) || requestErr.RequestID != "missing-limiter" || requestErr.Error() != "call rate limit exceeded" {
		t.Fatalf("discover error = %#v, want correlated call rate limit rejection", err)
	}
	if len(client.events) != 0 {
		t.Fatalf("coordinator without limiter was allowed through: events=%#v", client.events)
	}
}

func TestGroupCallDiscoveryHonorsCancellationAndReleasesLease(t *testing.T) {
	ownerID, conversationID := uuid.New(), uuid.New()
	authorizer := &discoveryAuthorizer{groupTestPresence: &groupTestPresence{}, revision: 1, memberIDs: []uuid.UUID{ownerID}}
	rooms := &discoveryGroupRooms{waitForCancellation: true, entered: make(chan struct{})}
	hub := NewHubWithGroupCallAuthorizer(nil, authorizer, authorizer, rooms, nil, nil, nil, nil, nil, nil)
	client := &recordingClient{identity: sharedauth.Identity{UserID: ownerID, DeviceID: "device"}, connectionID: "socket"}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- hub.HandleVersion(ctx, client, 3, []byte(`{"version":3,"type":"group.call.discover","request_id":"cancel","payload":{"conversation_id":"`+conversationID.String()+`"}}`))
	}()
	<-rooms.entered
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("discovery error=%v, want cancellation", err)
	}
	if !authorizer.rolledBack || len(client.events) != 0 {
		t.Fatalf("lease rolled back=%v events=%#v", authorizer.rolledBack, client.events)
	}
}

func boolCount(value bool) int {
	if value {
		return 1
	}
	return 0
}

type ownershipTestRooms struct {
	groupTestRooms
	status      string
	reads       int
	absent      bool
	absenceErr  error
	checkedUser uuid.UUID
	participant GroupParticipant
	roomReads   int
}

type credentialsTestIssuer struct {
	expiry time.Time
	err    error
	calls  int
}

func (i *credentialsTestIssuer) Issue(_ Call, _ uuid.UUID) (ICEServer, error) {
	i.calls++
	return ICEServer{URLs: []string{"turn:example"}, Username: "secret-user", Credential: "secret-value", ExpiresAt: i.expiry}, i.err
}

func TestGroupCredentialsOwnedSocketOnly(t *testing.T) {
	user, conversation, roomID := uuid.New(), uuid.New(), uuid.New()
	expiry := time.Now().UTC().Add(time.Minute).Truncate(time.Second)
	presence := &groupTestPresence{revision: 9, memberIDs: []uuid.UUID{user}}
	rooms := &ownershipTestRooms{groupTestRooms: groupTestRooms{room: GroupRoom{ID: roomID, ConversationID: conversation, Generation: 3, MembershipRevision: 9, Status: GroupRoomRinging, ExpiresAt: expiry.Add(time.Minute), Participants: []GroupParticipant{{UserID: user, DeviceID: "device", ConnectionID: "socket"}}}}, status: "active"}
	issuer := &credentialsTestIssuer{expiry: expiry}
	hub := NewHubWithGroupCallAuthorizer(nil, presence, presence, rooms, nil, nil, nil, nil, issuer, nil)
	owner := &recordingClient{identity: sharedauth.Identity{UserID: user, DeviceID: "device"}, connectionID: "socket"}
	sibling := &recordingClient{identity: owner.identity, connectionID: "sibling"}
	request := []byte(`{"version":3,"type":"group.call.credentials","request_id":"refresh-1","payload":{"conversation_id":"` + conversation.String() + `","room_id":"` + roomID.String() + `","generation":3}}`)
	if err := hub.Handle(context.Background(), sibling, request); err == nil || len(sibling.events) != 0 || issuer.calls != 0 {
		t.Fatal("sibling received credentials")
	}
	if err := hub.Handle(context.Background(), owner, request); err != nil {
		t.Fatal(err)
	}
	if len(owner.events) != 1 || len(rooms.published) != 0 {
		t.Fatal("credentials must be sent only as a direct response")
	}
	encoded, err := json.Marshal(owner.events[0])
	if err != nil {
		t.Fatal(err)
	}
	var response struct {
		Type      string `json:"type"`
		RequestID string `json:"request_id"`
		Payload   struct {
			ICEExpiresAt time.Time   `json:"ice_expires_at"`
			ICEServers   []ICEServer `json:"ice_servers"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(encoded, &response); err != nil {
		t.Fatal(err)
	}
	if response.Type != "group.call.credentials" || response.RequestID != "refresh-1" || !response.Payload.ICEExpiresAt.Equal(expiry) || len(response.Payload.ICEServers) != 1 {
		t.Fatalf("invalid response: %s", encoded)
	}
	issuer.err = errors.New("private issuer failure")
	if err := hub.Handle(context.Background(), owner, request); err == nil || strings.Contains(err.Error(), "private") || len(owner.events) != 1 {
		t.Fatal("issuer failure must fail closed")
	}
	rooms.status = "room_unavailable"
	issuer.err = nil
	if err := hub.Handle(context.Background(), owner, request); err == nil || len(owner.events) != 1 {
		t.Fatal("unavailable room issued credentials")
	}
	rooms.status = "active"
	rooms.room.Generation++
	if err := hub.Handle(context.Background(), owner, request); err == nil || len(owner.events) != 1 {
		t.Fatal("stale generation issued credentials")
	}
	rooms.room.Generation--
	owner.sendFailure = true
	if err := hub.Handle(context.Background(), owner, request); err == nil {
		t.Fatal("rejected socket enqueue must fail")
	}
	owner.sendFailure = false
	deniedHub := NewHubWithGroupCallAuthorizer(nil, presence, &discoveryAuthorizer{groupTestPresence: presence, err: ErrCallNotAllowed}, rooms, nil, nil, nil, nil, issuer, nil)
	calls := issuer.calls
	if err := deniedHub.Handle(context.Background(), owner, request); err == nil || issuer.calls != calls {
		t.Fatal("revoked member issued credentials")
	}
	limitedHub := NewHubWithGroupCallAuthorizer(nil, presence, presence, rateLimitedCoordinator{}, nil, nil, nil, nil, issuer, nil)
	if err := limitedHub.Handle(context.Background(), owner, request); err == nil || issuer.calls != calls {
		t.Fatal("rate-limited request issued credentials")
	}
}

func TestGroupLifecycleCredentialExpiryOnlyForOwnedSocket(t *testing.T) {
	user, conversation, roomID := uuid.New(), uuid.New(), uuid.New()
	expiry := time.Now().UTC().Add(time.Minute).Truncate(time.Second)
	issuer := &credentialsTestIssuer{expiry: expiry}
	hub := NewHubWithGroupCallAuthorizer(nil, nil, nil, nil, nil, nil, nil, nil, issuer, nil)
	owner := &recordingClient{identity: sharedauth.Identity{UserID: user, DeviceID: "device"}, connectionID: "socket"}
	sibling := &recordingClient{identity: owner.identity, connectionID: "sibling"}
	room := GroupRoom{ID: roomID, ConversationID: conversation, Generation: 1, Status: GroupRoomRinging, ExpiresAt: expiry.Add(time.Minute), Participants: []GroupParticipant{{UserID: user, DeviceID: "device", ConnectionID: "socket"}}}
	hub.sendFullGroupRoom(context.Background(), GroupRoomChange{Type: "started"}, room, owner)
	hub.sendFullGroupRoom(context.Background(), GroupRoomChange{Type: "started"}, room, sibling)
	ownerJSON, _ := json.Marshal(owner.events[0])
	siblingJSON, _ := json.Marshal(sibling.events[0])
	if !bytes.Contains(ownerJSON, []byte(`"ice_expires_at":"`+expiry.Format(time.RFC3339)+`"`)) || !bytes.Contains(ownerJSON, []byte(`"ice_servers"`)) || bytes.Contains(siblingJSON, []byte(`"ice_servers"`)) || issuer.calls != 1 {
		t.Fatal("credential expiry or socket ownership not preserved in lifecycle event")
	}
}

func (r *ownershipTestRooms) GetGroupRoom(ctx context.Context, roomID uuid.UUID) (GroupRoom, error) {
	r.roomReads++
	return r.groupTestRooms.GetGroupRoom(ctx, roomID)
}

func (r *ownershipTestRooms) GroupReservationAbsent(_ context.Context, userID uuid.UUID) (bool, error) {
	r.checkedUser = userID
	return r.absent, r.absenceErr
}

func (r *ownershipTestRooms) SyncGroupRoomOwnership(_ context.Context, _, _ uuid.UUID, _, _ int64, participant GroupParticipant) (GroupRoom, string, error) {
	r.reads++
	r.participant = participant
	return r.room, r.status, nil
}

func TestGroupCallSyncOwnershipRingingSnapshot(t *testing.T) {
	userID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New()
	presence := &groupTestPresence{revision: 9, memberIDs: []uuid.UUID{userID}}
	rooms := &ownershipTestRooms{groupTestRooms: groupTestRooms{room: GroupRoom{ID: roomID, ConversationID: conversationID, Generation: 3, MembershipRevision: 9, Status: GroupRoomRinging, Participants: []GroupParticipant{{UserID: userID, DeviceID: "device", ConnectionID: "socket"}}}}, status: "active"}
	hub := NewHubWithGroupCallAuthorizer(nil, presence, presence, rooms, nil, nil, nil, nil, nil, nil)
	client := &recordingClient{identity: sharedauth.Identity{UserID: userID, DeviceID: "device"}, connectionID: "socket"}
	request := []byte(`{"version":3,"type":"group.call.sync","request_id":"sync","payload":{"conversation_id":"` + conversationID.String() + `","room_id":"` + roomID.String() + `","generation":3,"ownership_status":true}}`)
	if err := hub.HandleVersion(context.Background(), client, 3, request); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(client.events[0])
	if err != nil {
		t.Fatal(err)
	}
	if rooms.participant.UserID != userID || rooms.participant.DeviceID != "device" || rooms.participant.ConnectionID != "socket" || !bytes.Contains(encoded, []byte(`"status":"ringing"`)) || !bytes.Contains(encoded, []byte(`"ownership_status":"active"`)) || !bytes.Contains(encoded, []byte(`"participants"`)) || bytes.Contains(encoded, []byte("connection_id")) {
		t.Fatalf("ringing snapshot: %s participant=%#v", encoded, rooms.participant)
	}
	rooms.status = "owned_elsewhere"
	sibling := &recordingClient{identity: sharedauth.Identity{UserID: userID, DeviceID: "device"}, connectionID: "sibling"}
	if err := hub.HandleVersion(context.Background(), sibling, 3, request); err != nil {
		t.Fatal(err)
	}
	encoded, err = json.Marshal(sibling.events[0])
	if err != nil {
		t.Fatal(err)
	}
	if rooms.participant.ConnectionID != "sibling" || !bytes.Contains(encoded, []byte(`"ownership_status":"owned_elsewhere"`)) || bytes.Contains(encoded, []byte("participants")) || bytes.Contains(encoded, []byte("conversation_id")) || bytes.Contains(encoded, []byte("connection_id")) {
		t.Fatalf("sibling response: %s participant=%#v", encoded, rooms.participant)
	}
}

func TestGroupCallSyncRequiresOwnershipStatus(t *testing.T) {
	userID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New()
	presence := &groupTestPresence{revision: 9, memberIDs: []uuid.UUID{userID}}
	rooms := &ownershipTestRooms{}
	hub := NewHubWithGroupCallAuthorizer(nil, presence, presence, rooms, nil, nil, nil, nil, nil, nil)
	for _, field := range []string{"", `,"ownership_status":false`, `,"ownership_status":null`} {
		client := &recordingClient{identity: sharedauth.Identity{UserID: userID, DeviceID: "device"}, connectionID: "socket"}
		request := []byte(`{"version":3,"type":"group.call.sync","request_id":"sync","payload":{"conversation_id":"` + conversationID.String() + `","room_id":"` + roomID.String() + `","generation":3` + field + `}}`)
		if err := hub.HandleVersion(context.Background(), client, 3, request); err == nil || len(client.events) != 0 {
			t.Fatalf("field %q: expected rejection without event, got %v %#v", field, err, client.events)
		}
	}
}

func TestGroupCallSyncOwnershipIsMinimal(t *testing.T) {
	userID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New()
	presence := &groupTestPresence{revision: 9, memberIDs: []uuid.UUID{userID}}
	rooms := &ownershipTestRooms{groupTestRooms: groupTestRooms{room: GroupRoom{ID: roomID, ConversationID: conversationID, Generation: 3, MembershipRevision: 9, Status: GroupRoomActive, Participants: []GroupParticipant{{UserID: userID, DeviceID: "device", ConnectionID: "socket"}}}}}
	hub := NewHubWithGroupCallAuthorizer(nil, presence, presence, rooms, nil, nil, nil, nil, nil, nil)
	for _, status := range []string{"active", "participant_absent", "owned_elsewhere", "room_unavailable"} {
		t.Run(status, func(t *testing.T) {
			rooms.status = status
			client := &recordingClient{identity: sharedauth.Identity{UserID: userID, DeviceID: "device"}, connectionID: "socket"}
			request := []byte(`{"version":3,"type":"group.call.sync","request_id":"sync","payload":{"conversation_id":"` + conversationID.String() + `","room_id":"` + roomID.String() + `","generation":3,"ownership_status":true}}`)
			if err := hub.HandleVersion(context.Background(), client, 3, request); err != nil {
				t.Fatal(err)
			}
			encoded, err := json.Marshal(client.events[0])
			if err != nil {
				t.Fatal(err)
			}
			var event struct {
				Payload map[string]json.RawMessage `json:"payload"`
			}
			if err := json.Unmarshal(encoded, &event); err != nil {
				t.Fatal(err)
			}
			if string(event.Payload["ownership_status"]) != `"`+status+`"` {
				t.Fatalf("response: %s", encoded)
			}
			_, hasRoster := event.Payload["participants"]
			if hasRoster != (status == "active") || bytes.Contains(encoded, []byte("connection_id")) {
				t.Fatalf("disclosure: %s", encoded)
			}
		})
	}
	denied := &discoveryAuthorizer{groupTestPresence: presence, err: ErrCallNotAllowed}
	deniedHub := NewHubWithGroupCallAuthorizer(nil, presence, denied, rooms, nil, nil, nil, nil, nil, nil)
	client := &recordingClient{identity: sharedauth.Identity{UserID: userID, DeviceID: "device"}, connectionID: "socket"}
	request := []byte(`{"version":3,"type":"group.call.sync","request_id":"sync","payload":{"conversation_id":"` + conversationID.String() + `","room_id":"` + roomID.String() + `","generation":3,"ownership_status":true}}`)
	reads := rooms.reads
	roomReads := rooms.roomReads
	if err := deniedHub.HandleVersion(context.Background(), client, 3, request); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(client.events[0])
	if err != nil {
		t.Fatal(err)
	}
	if rooms.reads != reads || rooms.roomReads != roomReads || !bytes.Contains(encoded, []byte(`"ownership_status":"room_unavailable"`)) || bytes.Contains(encoded, []byte("participants")) {
		t.Fatalf("authorization denial classified or disclosed room: %s", encoded)
	}
	rooms.absent = true
	client.events = nil
	if err := deniedHub.HandleVersion(context.Background(), client, 3, request); err != nil {
		t.Fatal(err)
	}
	encoded, _ = json.Marshal(client.events[0])
	if rooms.checkedUser != userID || !bytes.Contains(encoded, []byte(`"ownership_status":"participant_absent"`)) || bytes.Contains(encoded, []byte("participants")) || bytes.Contains(encoded, []byte("device")) || bytes.Contains(encoded, []byte("conversation_id")) {
		t.Fatalf("denied absence response: %s", encoded)
	}
	rooms.absenceErr = errors.New("redis failed")
	client.events = nil
	if err := deniedHub.HandleVersion(context.Background(), client, 3, request); err == nil || len(client.events) != 0 {
		t.Fatalf("absence failure must fail closed: %v %#v", err, client.events)
	}
}

func TestGroupCallSyncCleansStaleMembershipWithoutDisclosingRoom(t *testing.T) {
	userID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New()
	presence := &groupTestPresence{revision: 10, memberIDs: []uuid.UUID{userID}}
	rooms := &ownershipTestRooms{groupTestRooms: groupTestRooms{room: GroupRoom{ID: roomID, ConversationID: conversationID, Generation: 3, MembershipRevision: 9, StateRevision: 7, Status: GroupRoomActive, Participants: []GroupParticipant{{UserID: userID}}}}, status: "room_unavailable"}
	hub := NewHubWithGroupCallAuthorizer(nil, presence, presence, rooms, nil, nil, nil, nil, nil, nil)
	client := &recordingClient{identity: sharedauth.Identity{UserID: userID, DeviceID: "device"}, connectionID: "socket"}
	request := []byte(`{"version":3,"type":"group.call.sync","request_id":"sync","payload":{"conversation_id":"` + conversationID.String() + `","room_id":"` + roomID.String() + `","generation":3,"ownership_status":true}}`)
	wrongGeneration := bytes.Replace(request, []byte(`"generation":3`), []byte(`"generation":4`), 1)
	if err := hub.HandleVersion(context.Background(), client, 3, wrongGeneration); err != nil || rooms.room.Status != GroupRoomActive {
		t.Fatalf("wrong generation must not end room: %v %#v", err, rooms.room)
	}
	client.events = nil
	if err := hub.HandleVersion(context.Background(), client, 3, request); err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(client.events[0])
	if rooms.room.Status != GroupRoomEnded || bytes.Contains(encoded, []byte("participants")) || bytes.Contains(encoded, []byte("conversation_id")) || !bytes.Contains(encoded, []byte(`"ownership_status":"room_unavailable"`)) {
		t.Fatalf("stale sync: room=%#v response=%s", rooms.room, encoded)
	}
}

func TestStaleSyncWinsProjectionRaceAndFansOutTerminal(t *testing.T) {
	ownerID, removedID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	room := GroupRoom{ID: roomID, ConversationID: conversationID, Generation: 3, MembershipRevision: 2, StateRevision: 7, Status: GroupRoomActive, Participants: []GroupParticipant{
		{UserID: ownerID, DeviceID: "owner", ConnectionID: "owner-socket"},
		{UserID: removedID, DeviceID: "removed", ConnectionID: "removed-socket"},
	}}
	presence := &groupTestPresence{revision: 3, memberIDs: []uuid.UUID{ownerID}}
	rooms := &ownershipTestRooms{groupTestRooms: groupTestRooms{room: room}, status: "room_unavailable"}
	publisher := NewHubWithGroupCallAuthorizer(nil, presence, presence, rooms, nil, nil, nil, nil, nil, nil)
	owner := &recordingClient{identity: sharedauth.Identity{UserID: ownerID, DeviceID: "owner"}, connectionID: "owner-socket"}
	publisher.Add(context.Background(), owner)
	owner.events = nil
	request := []byte(`{"version":3,"type":"group.call.sync","request_id":"sync","payload":{"conversation_id":"` + conversationID.String() + `","room_id":"` + roomID.String() + `","generation":3,"ownership_status":true}}`)
	if err := publisher.Handle(context.Background(), owner, request); err != nil {
		t.Fatal(err)
	}
	if err := publisher.NotifyGroupProjection(context.Background(), conversationID, 3, false, []uuid.UUID{ownerID}); err != nil {
		t.Fatal(err)
	}
	if len(rooms.published) != 1 {
		t.Fatalf("terminal publication = %#v", rooms.published)
	}
	change := rooms.published[0]
	if change.Type != "ended" || change.Room.StateRevision != 8 || change.MembershipProjectionRevision != 3 || len(change.Room.Participants) != 2 {
		t.Fatalf("terminal change = %#v", change)
	}
	var localTerminal bool
	for _, event := range owner.events {
		if event.(serverEvent).Type == "group.call.ended" {
			localTerminal = true
		}
	}
	if !localTerminal {
		t.Fatal("local owner did not receive terminal event")
	}
	encoded, _ := json.Marshal(change)
	var remoteChange GroupRoomChange
	if err := json.Unmarshal(encoded, &remoteChange); err != nil {
		t.Fatal(err)
	}
	verifier := currentProjectionAuthorizer{revision: 3, activeUserIDs: map[uuid.UUID]bool{ownerID: true}}
	remote := NewHubWithGroupCallAuthorizer(nil, &groupTestPresence{}, verifier, &groupTestRooms{}, nil, nil, nil, nil, nil, nil)
	removed := &recordingClient{identity: sharedauth.Identity{UserID: removedID, DeviceID: "removed"}, connectionID: "removed-socket"}
	sibling := &recordingClient{identity: sharedauth.Identity{UserID: removedID, DeviceID: "removed"}, connectionID: "sibling"}
	remote.Add(context.Background(), removed)
	remote.Add(context.Background(), sibling)
	removed.events, sibling.events = nil, nil
	remote.DeliverGroupRoom(context.Background(), remoteChange)
	if len(removed.events) != 1 || len(sibling.events) != 0 {
		t.Fatalf("remote events removed=%#v sibling=%#v", removed.events, sibling.events)
	}
	payload, _ := json.Marshal(removed.events[0].(serverEvent).Payload)
	if bytes.Contains(payload, []byte("participants")) || bytes.Contains(payload, []byte("conversation_id")) || !bytes.Contains(payload, []byte(`"state_revision":8`)) {
		t.Fatalf("removed payload: %s", payload)
	}
}

type racedStaleSyncRooms struct{ ownershipTestRooms }

func (r *racedStaleSyncRooms) EndGroupRoomForMembershipChange(_ context.Context, _ uuid.UUID, _ uuid.UUID, _, _, _ int64) (GroupRoom, error) {
	// Model another replica changing the room between observation and CAS.
	r.room.Generation++
	r.room.StateRevision++
	return GroupRoom{}, ErrCallNotAllowed
}

func TestStaleSyncDoesNotPublishWhenConditionalRetirementLosesRace(t *testing.T) {
	userID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New()
	presence := &groupTestPresence{revision: 3, memberIDs: []uuid.UUID{userID}}
	rooms := &racedStaleSyncRooms{ownershipTestRooms: ownershipTestRooms{groupTestRooms: groupTestRooms{room: GroupRoom{ID: roomID, ConversationID: conversationID, Generation: 3, MembershipRevision: 2, StateRevision: 7, Status: GroupRoomActive}}, status: "room_unavailable"}}
	hub := NewHubWithGroupCallAuthorizer(nil, presence, presence, rooms, nil, nil, nil, nil, nil, nil)
	client := &recordingClient{identity: sharedauth.Identity{UserID: userID, DeviceID: "device"}, connectionID: "socket"}
	request := []byte(`{"version":3,"type":"group.call.sync","request_id":"sync","payload":{"conversation_id":"` + conversationID.String() + `","room_id":"` + roomID.String() + `","generation":3,"ownership_status":true}}`)
	if err := hub.Handle(context.Background(), client, request); err != nil {
		t.Fatal(err)
	}
	if len(rooms.published) != 0 || rooms.room.Status != GroupRoomActive || rooms.room.Generation != 4 {
		t.Fatalf("lost CAS published or ended newer room: %#v %#v", rooms.published, rooms.room)
	}
}

func TestStaleDiscoveryPublishesTerminalToPreRetirementOwners(t *testing.T) {
	userID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New()
	room := GroupRoom{ID: roomID, ConversationID: conversationID, Generation: 2, MembershipRevision: 1, StateRevision: 4, Status: GroupRoomActive, Participants: []GroupParticipant{{UserID: userID, DeviceID: "device", ConnectionID: "socket"}}}
	presence := &groupTestPresence{revision: 2, memberIDs: []uuid.UUID{userID}}
	rooms := &groupTestRooms{room: room}
	hub := NewHubWithGroupCallAuthorizer(nil, presence, presence, rooms, nil, nil, nil, nil, nil, nil)
	client := &recordingClient{identity: sharedauth.Identity{UserID: userID, DeviceID: "device"}, connectionID: "socket"}
	hub.Add(context.Background(), client)
	client.events = nil
	request := []byte(`{"version":3,"type":"group.call.discover","request_id":"discover","payload":{"conversation_id":"` + conversationID.String() + `"}}`)
	if err := hub.Handle(context.Background(), client, request); err != nil {
		t.Fatal(err)
	}
	if len(rooms.published) != 1 || rooms.published[0].Room.StateRevision != 5 || rooms.published[0].MembershipProjectionRevision != 2 || rooms.published[0].ParticipantConnectionIDs[groupParticipantKey(userID, "device")] != "socket" {
		t.Fatalf("published=%#v", rooms.published)
	}
	var ended bool
	for _, event := range client.events {
		if event.(serverEvent).Type == "group.call.ended" {
			ended = true
		}
	}
	if !ended {
		t.Fatalf("missing local terminal: %#v", client.events)
	}
}

type cancelRetirementRooms struct {
	ownershipTestRooms
	cancel          context.CancelFunc
	cancelOnPublish bool
}

func (r *cancelRetirementRooms) EndGroupRoomForMembershipChange(ctx context.Context, conversationID, roomID uuid.UUID, generation, stateRevision, membershipRevision int64) (GroupRoom, error) {
	room, err := r.ownershipTestRooms.EndGroupRoomForMembershipChange(ctx, conversationID, roomID, generation, stateRevision, membershipRevision)
	if err == nil && !r.cancelOnPublish {
		r.cancel()
	}
	return room, err
}

func (r *cancelRetirementRooms) PublishGroupRoom(ctx context.Context, change GroupRoomChange) error {
	if r.cancelOnPublish {
		r.cancel()
	}
	return ctx.Err()
}

func TestStaleRetirementDeliversLocallyAfterRequestCancellation(t *testing.T) {
	for _, command := range []string{"discover", "sync"} {
		for _, cancelOnPublish := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/publish=%t", command, cancelOnPublish), func(t *testing.T) {
				userID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New()
				room := GroupRoom{ID: roomID, ConversationID: conversationID, Generation: 2, MembershipRevision: 1, StateRevision: 4, Status: GroupRoomActive, Participants: []GroupParticipant{{UserID: userID, DeviceID: "device", ConnectionID: "socket"}}}
				presence := &groupTestPresence{revision: 2, memberIDs: []uuid.UUID{userID}}
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				rooms := &cancelRetirementRooms{ownershipTestRooms: ownershipTestRooms{groupTestRooms: groupTestRooms{room: room}, status: "room_unavailable"}, cancel: cancel, cancelOnPublish: cancelOnPublish}
				hub := NewHubWithGroupCallAuthorizer(nil, presence, presence, rooms, nil, nil, nil, nil, nil, nil)
				client := &recordingClient{identity: sharedauth.Identity{UserID: userID, DeviceID: "device"}, connectionID: "socket"}
				hub.Add(context.Background(), client)
				client.events = nil
				if command == "discover" {
					_ = hub.handleGroupRoomDiscovery(ctx, client, "request", conversationID)
				} else {
					_ = hub.handleGroupRoomSync(ctx, client, "request", conversationID, roomID, 2)
				}
				if rooms.room.Status != GroupRoomEnded || ctx.Err() == nil {
					t.Fatalf("retirement or cancellation missing: room=%#v err=%v", rooms.room, ctx.Err())
				}
				var ended bool
				for _, event := range client.events {
					if event.(serverEvent).Type == "group.call.ended" {
						ended = true
					}
				}
				if !ended {
					t.Fatalf("missing local terminal: %#v", client.events)
				}
			})
		}
	}
}

func TestGroupCallSignalHoldsMembershipLeaseThroughFanout(t *testing.T) {
	ownerID, memberID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	order := &groupStartOrder{revision: 4, memberIDs: []uuid.UUID{ownerID, memberID}}
	room := GroupRoom{ID: roomID, ConversationID: conversationID, MembershipRevision: 4, Generation: 1, Status: GroupRoomActive, Participants: []GroupParticipant{{UserID: ownerID, DeviceID: "owner-device", ConnectionID: "owner-socket"}, {UserID: memberID, DeviceID: "member-device", ConnectionID: "member-socket"}}}
	rooms := &blockingGroupSignalRooms{groupTestRooms: groupTestRooms{room: room}, publishing: make(chan struct{}), continuePublish: make(chan struct{}), order: order}
	var logs bytes.Buffer
	hub := NewHubWithGroupCallAuthorizer(nil, order, order, rooms, nil, nil, nil, nil, nil, slog.New(slog.NewJSONHandler(&logs, nil)))
	owner := &recordingClient{identity: sharedauth.Identity{UserID: ownerID, DeviceID: "owner-device"}, connectionID: "owner-socket"}
	member := &recordingClient{identity: sharedauth.Identity{UserID: memberID, DeviceID: "member-device"}, connectionID: "member-socket"}
	hub.Add(context.Background(), owner)
	hub.Add(context.Background(), member)
	owner.events, member.events = nil, nil
	request := []byte(`{"version":3,"type":"group.call.signal","request_id":"signal-locked","payload":{"conversation_id":"` + conversationID.String() + `","room_id":"` + roomID.String() + `","generation":1,"target_user_id":"` + memberID.String() + `","target_device_id":"member-device","signal":{"type":"offer","sdp":"opaque","negotiation_id":"8c72dd14-fafe-4e2d-9735-e09c37358bf1"}}}`)
	commandDone := make(chan error, 1)
	go func() { commandDone <- hub.HandleVersion(context.Background(), owner, 3, request) }()
	<-rooms.publishing // Redis fanout is still inside the membership lease.

	revocationCommitted := make(chan struct{})
	allowProjection := make(chan struct{})
	revocationDone := make(chan error, 1)
	go func() {
		revocationDone <- order.revokeAndProject(hub, conversationID, ownerID, revocationCommitted, allowProjection)
	}()
	select {
	case err := <-revocationDone:
		t.Fatalf("revocation passed a signal still being fanned out: %v", err)
	default:
	}
	close(rooms.continuePublish)
	if err := <-commandDone; err != nil {
		t.Fatalf("signal command: %v", err)
	}
	if strings.Contains(logs.String(), "group call command accepted") {
		t.Fatalf("successful group.call.signal emitted lifecycle log: %s", logs.String())
	}
	<-revocationCommitted
	close(allowProjection)
	if err := <-revocationDone; err != nil {
		t.Fatalf("revoke after signal: %v", err)
	}
	// Either queue-admission lease may win: revocation first means ended only;
	// enqueue first means signal followed by ended. No other order is valid.
	if len(member.events) < 1 || len(member.events) > 2 {
		t.Fatalf("target events = %#v, want ended only or signal then ended", member.events)
	}
	endedIndex := len(member.events) - 1
	endedEvent, ok := member.events[endedIndex].(serverEvent)
	if !ok || endedEvent.Type != "group.call.ended" {
		t.Fatalf("last target event = %#v, want group.call.ended", member.events[endedIndex])
	}
	if endedIndex == 1 {
		if signalEvent, ok := member.events[0].(serverEvent); !ok || signalEvent.Type != "group.call.signal" {
			t.Fatalf("first target event = %#v, want signal before terminal", member.events[0])
		}
	}
	endedPayload, err := json.Marshal(endedEvent.Payload)
	if err != nil {
		t.Fatalf("marshal ended payload: %v", err)
	}
	var endedAck struct {
		RoomID        uuid.UUID `json:"room_id"`
		Generation    int64     `json:"generation"`
		Status        string    `json:"status"`
		StateRevision int64     `json:"state_revision"`
	}
	if err := json.Unmarshal(endedPayload, &endedAck); err != nil {
		t.Fatalf("decode ended payload: %v", err)
	}
	var endedFields map[string]json.RawMessage
	if err := json.Unmarshal(endedPayload, &endedFields); err != nil {
		t.Fatalf("decode ended payload fields: %v", err)
	}
	if endedAck.RoomID != roomID || endedAck.Generation != 1 || endedAck.Status != GroupRoomEnded || endedAck.StateRevision != 1 || len(endedFields) != 4 {
		t.Fatalf("delivered ended payload = %s", endedPayload)
	}
	for index, rawEvent := range member.events {
		if event, ok := rawEvent.(serverEvent); ok && event.Type == "group.call.signal" && index > endedIndex {
			t.Fatalf("signal event at position %d followed terminal event: %#v", index, rawEvent)
		}
	}
	steps := order.snapshot()
	if !(indexOf(steps, "lease.begin") < indexOf(steps, "signal.publish") && indexOf(steps, "signal.publish") < indexOf(steps, "lease.commit") && indexOf(steps, "lease.commit") < indexOf(steps, "membership.revoke") && indexOf(steps, "membership.revoke") < indexOf(steps, "projection.cleanup")) {
		t.Fatalf("signal/revocation ordering = %v", steps)
	}
}

func TestSuccessfulGroupCallLifecycleCommandRemainsLogged(t *testing.T) {
	userID, peerID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	room := GroupRoom{ID: roomID, ConversationID: conversationID, MembershipRevision: 4, Generation: 1, Status: GroupRoomActive, Participants: []GroupParticipant{
		{UserID: userID, DeviceID: "owner-device", ConnectionID: "owner-socket"},
		{UserID: peerID, DeviceID: "peer-device", ConnectionID: "peer-socket"},
	}}
	presence := &groupTestPresence{revision: 4, memberIDs: []uuid.UUID{userID, peerID}}
	rooms := &groupTestRooms{room: room}
	var logs bytes.Buffer
	hub := NewHubWithGroupCallAuthorizer(nil, presence, presence, rooms, nil, nil, nil, nil, nil, slog.New(slog.NewJSONHandler(&logs, nil)))
	owner := &recordingClient{identity: sharedauth.Identity{UserID: userID, DeviceID: "owner-device"}, connectionID: "owner-socket"}
	request := []byte(`{"version":3,"type":"group.call.join","request_id":"join-lifecycle","payload":{"conversation_id":"` + conversationID.String() + `","room_id":"` + roomID.String() + `","generation":1}}`)
	if err := hub.HandleVersion(context.Background(), owner, 3, request); err != nil {
		t.Fatalf("group.call.join: %v", err)
	}
	if !strings.Contains(logs.String(), "group call command accepted") || !strings.Contains(logs.String(), "group.call.join") {
		t.Fatalf("successful group lifecycle command was not logged: %s", logs.String())
	}
}

func TestGroupConversationLockHonorsCanceledContext(t *testing.T) {
	hub := NewHubWithGroupCallAuthorizer(nil, nil, nil, nil, nil, nil, nil, nil, nil, nil)
	conversationID := uuid.New()
	unlock, err := hub.lockGroupConversation(context.Background(), conversationID)
	if err != nil {
		t.Fatalf("acquire initial stripe: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := hub.lockGroupConversation(ctx, conversationID); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled stripe acquisition error = %v, want context.Canceled", err)
	}
	deadlineCtx, deadlineCancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer deadlineCancel()
	if err := hub.NotifyGroupProjection(deadlineCtx, conversationID, 1, false, nil); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("NotifyGroupProjection while stripe held = %v, want context.DeadlineExceeded", err)
	}

	// Cancellation must not leave a semaphore permit behind or compromise the
	// held lock; acquisition succeeds once the original owner releases it.
	unlock()
	unlock, err = hub.lockGroupConversation(context.Background(), conversationID)
	if err != nil {
		t.Fatalf("acquire stripe after release: %v", err)
	}
	unlock()
}

func TestGroupSignalQueueLeaseWinsBeforeRevocation(t *testing.T) {
	ownerID, memberID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	order := &groupStartOrder{revision: 4, memberIDs: []uuid.UUID{ownerID, memberID}}
	room := GroupRoom{ID: roomID, ConversationID: conversationID, MembershipRevision: 4, Generation: 1, Status: GroupRoomActive, Participants: []GroupParticipant{{UserID: ownerID, DeviceID: "owner-device", ConnectionID: "owner-socket"}, {UserID: memberID, DeviceID: "member-device", ConnectionID: "member-socket"}}}
	hub := NewHubWithGroupCallAuthorizer(nil, order, order, &groupTestRooms{room: room}, nil, nil, nil, nil, nil, nil)
	member := &blockingRecordingClient{recordingClient: recordingClient{identity: sharedauth.Identity{UserID: memberID, DeviceID: "member-device"}, connectionID: "member-socket"}, entered: make(chan struct{}), release: make(chan struct{})}
	hub.Add(context.Background(), member)
	member.events = nil
	signal := GroupRoomChange{Type: "signal", Room: room, FromUserID: ownerID, FromDeviceID: "owner-device", ToUserID: memberID, ToDeviceID: "member-device", Signal: json.RawMessage(`{"type":"offer","sdp":"opaque"}`), ParticipantConnectionIDs: groupParticipantConnectionIDs(room)}
	deliveryDone := make(chan struct{})
	go func() {
		hub.DeliverGroupRoom(context.Background(), signal)
		close(deliveryDone)
	}()
	<-member.entered // Target enqueue is in progress while its membership lease is held.

	revocationCommitted := make(chan struct{})
	allowProjection := make(chan struct{})
	revocationDone := make(chan error, 1)
	go func() {
		revocationDone <- order.revokeAndProject(hub, conversationID, ownerID, revocationCommitted, allowProjection)
	}()
	select {
	case <-revocationCommitted:
		t.Fatal("revocation passed the target queue-admission lease")
	default:
	}
	close(member.release)
	<-deliveryDone
	<-revocationCommitted
	close(allowProjection)
	if err := <-revocationDone; err != nil {
		t.Fatalf("revoke after admitted signal: %v", err)
	}
	if len(member.events) != 2 {
		t.Fatalf("member events = %#v, want signal then terminal", member.events)
	}
	first, firstOK := member.events[0].(serverEvent)
	second, secondOK := member.events[1].(serverEvent)
	if !firstOK || first.Type != "group.call.signal" || !secondOK || second.Type != "group.call.ended" {
		t.Fatalf("event order = %#v, want signal followed by ended", member.events)
	}
}

type blockingGroupSignalRooms struct {
	groupTestRooms
	publishing      chan struct{}
	continuePublish chan struct{}
	order           *groupStartOrder
}

func (r *blockingGroupSignalRooms) PublishGroupRoom(ctx context.Context, change GroupRoomChange) error {
	if change.Type == "signal" {
		close(r.publishing)
		// The command owns order.mu through its lease, so append under that lock.
		r.order.steps = append(r.order.steps, "signal.publish")
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-r.continuePublish:
			return nil
		}
	}
	return nil
}

func indexOf(values []string, value string) int {
	for index, candidate := range values {
		if candidate == value {
			return index
		}
	}
	return len(values)
}

func TestGroupCallStartAfterProjectionCleanupIsRejected(t *testing.T) {
	ownerID, conversationID := uuid.New(), uuid.New()
	presence := &revokedGroupStartPresence{groupTestPresence: groupTestPresence{revision: 5}}
	rooms := &groupTestRooms{}
	hub := NewHubWithGroupCallAuthorizer(nil, presence, presence, rooms, nil, nil, nil, nil, nil, nil)
	client := &recordingClient{identity: sharedauth.Identity{UserID: ownerID, DeviceID: "device"}, connectionID: "socket"}
	err := hub.HandleVersion(context.Background(), client, 3, []byte(`{"version":3,"type":"group.call.start","request_id":"start-2","payload":{"attempt_id":"00000000-0000-4000-8000-000000000001","conversation_id":"`+conversationID.String()+`"}}`))
	if !errors.Is(err, ErrCallNotAllowed) {
		t.Fatalf("start after committed revocation = %v, want not allowed", err)
	}
	if rooms.room.ID != uuid.Nil {
		t.Fatalf("stale room was created after projection cleanup: %#v", rooms.room)
	}
}

func TestGroupCallCommandRejectsMemberRemovedBeforeLease(t *testing.T) {
	userID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New()
	removed := &revokedGroupStartPresence{groupTestPresence: groupTestPresence{revision: 6}}
	rooms := &groupTestRooms{room: GroupRoom{ID: roomID, ConversationID: conversationID, MembershipRevision: 5, Generation: 1, Status: GroupRoomActive, Participants: []GroupParticipant{{UserID: userID, DeviceID: "device", ConnectionID: "socket"}}}}
	hub := NewHubWithGroupCallAuthorizer(nil, removed, removed, rooms, nil, nil, nil, nil, nil, nil)
	client := &recordingClient{identity: sharedauth.Identity{UserID: userID, DeviceID: "device"}, connectionID: "socket"}
	request := []byte(`{"version":3,"type":"group.call.end","request_id":"revoked-end","payload":{"conversation_id":"` + conversationID.String() + `","room_id":"` + roomID.String() + `","generation":1}}`)
	if err := hub.HandleVersion(context.Background(), client, 3, request); !errors.Is(err, ErrCallNotAllowed) {
		t.Fatalf("removed member command error = %v, want not allowed", err)
	}
	if rooms.mutationCalls != 0 {
		t.Fatalf("removed member caused %d Redis mutations", rooms.mutationCalls)
	}
}

func TestGroupCallJoinPubSubFailureCommitsLeaseAndDeliversLocalSnapshot(t *testing.T) {
	userID, peerID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	lease := &trackedGroupCallLease{revision: 3, members: []uuid.UUID{userID, peerID}}
	publishErr := errors.New("fanout unavailable")
	rooms := &failingJoinGroupRoomPublisher{
		failingGroupRoomPublisher: failingGroupRoomPublisher{
			groupTestRooms: groupTestRooms{room: GroupRoom{ID: roomID, ConversationID: conversationID, MembershipRevision: 3, Generation: 1, Status: GroupRoomActive, Participants: []GroupParticipant{{UserID: peerID, DeviceID: "peer-device", ConnectionID: "peer-socket"}}}},
			publishErr:     publishErr,
		},
	}
	hub := NewHubWithGroupCallAuthorizer(nil, &groupTestPresence{}, &commandThenDeliveryAuthorizer{commandLease: lease, deliveryRevision: 3, deliveryMembers: []uuid.UUID{userID, peerID}}, rooms, nil, nil, nil, nil, nil, nil)
	client := &recordingClient{identity: sharedauth.Identity{UserID: userID, DeviceID: "device"}, connectionID: "socket"}
	hub.Add(context.Background(), client)
	client.events = nil
	request := []byte(`{"version":3,"type":"group.call.join","request_id":"publisher-failure","payload":{"conversation_id":"` + conversationID.String() + `","room_id":"` + roomID.String() + `","generation":1}}`)
	if err := hub.HandleVersion(context.Background(), client, 3, request); err != nil {
		t.Fatalf("join error = %v, want accepted despite Pub/Sub failure", err)
	}
	if !lease.committed || lease.rolledBack {
		t.Fatalf("lease committed=%v rolled_back=%v, want commit only", lease.committed, lease.rolledBack)
	}
	if len(client.events) != 1 {
		t.Fatalf("local events = %#v, want committed room snapshot", client.events)
	}
	event, ok := client.events[0].(serverEvent)
	if !ok || event.Type != "group.call.participant.joined" {
		t.Fatalf("local event = %#v, want participant.joined snapshot", client.events[0])
	}
	encoded, err := json.Marshal(event.Payload)
	if err != nil || !bytes.Contains(encoded, []byte(userID.String())) {
		t.Fatalf("local snapshot = %s, err=%v; want joining user", encoded, err)
	}
}

type failingJoinGroupRoomPublisher struct{ failingGroupRoomPublisher }

func (r *failingJoinGroupRoomPublisher) JoinGroupRoom(_ context.Context, _ uuid.UUID, participant GroupParticipant, _ int64, _ string) (GroupRoom, error) {
	r.mutationCalls++
	r.room.Participants = append(r.room.Participants, participant)
	r.room.StateRevision++
	return r.room, nil
}

func TestGroupCallPresenterAndEndUseLocalFallbackAfterPubSubFailure(t *testing.T) {
	for _, test := range []struct {
		name, command, wantEvent string
	}{
		{
			name:      "presenter",
			command:   "group.call.presenter.start",
			wantEvent: "group.call.presenter.start",
		},
		{
			name:      "end",
			command:   "group.call.end",
			wantEvent: "group.call.ended",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			userID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New()
			lease := &trackedGroupCallLease{revision: 3, members: []uuid.UUID{userID}}
			rooms := &failingGroupRoomPublisher{groupTestRooms: groupTestRooms{room: GroupRoom{
				ID: roomID, ConversationID: conversationID, MembershipRevision: 3, Generation: 1,
				Status:       GroupRoomActive,
				Participants: []GroupParticipant{{UserID: userID, DeviceID: "device", ConnectionID: "socket"}},
			}}, publishErr: errors.New("fanout unavailable")}
			mutatingRooms := &fallbackGroupRoomPublisher{failingGroupRoomPublisher: rooms}
			hub := NewHubWithGroupCallAuthorizer(nil, &groupTestPresence{}, &commandThenDeliveryAuthorizer{commandLease: lease, deliveryRevision: 3, deliveryMembers: []uuid.UUID{userID}}, mutatingRooms, nil, nil, nil, nil, nil, nil)
			client := &recordingClient{identity: sharedauth.Identity{UserID: userID, DeviceID: "device"}, connectionID: "socket"}
			hub.Add(context.Background(), client)
			client.events = nil
			request := []byte(`{"version":3,"type":"` + test.command + `","request_id":"fallback","payload":{"conversation_id":"` + conversationID.String() + `","room_id":"` + roomID.String() + `","generation":1}}`)
			if err := hub.HandleVersion(context.Background(), client, 3, request); err != nil {
				t.Fatalf("command error = %v, want accepted", err)
			}
			if !lease.committed || lease.rolledBack {
				t.Fatalf("lease committed=%v rolled_back=%v", lease.committed, lease.rolledBack)
			}
			if len(client.events) != 1 {
				t.Fatalf("local events = %#v, want fallback snapshot", client.events)
			}
			event, ok := client.events[0].(serverEvent)
			if !ok || event.Type != test.wantEvent {
				t.Fatalf("local event = %#v, want %q", client.events[0], test.wantEvent)
			}
		})
	}
}

func TestGroupCallSignalPubSubFailureRemainsRejectedWithoutLocalDelivery(t *testing.T) {
	userID, targetID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	lease := &trackedGroupCallLease{revision: 3, members: []uuid.UUID{userID, targetID}}
	rooms := &failingGroupRoomPublisher{
		groupTestRooms: groupTestRooms{room: GroupRoom{
			ID: roomID, ConversationID: conversationID, MembershipRevision: 3, Generation: 1, Status: GroupRoomActive,
			Participants: []GroupParticipant{{UserID: userID, DeviceID: "device", ConnectionID: "socket"}, {UserID: targetID, DeviceID: "target-device", ConnectionID: "target-socket"}},
		}},
		publishErr: errors.New("fanout unavailable"),
	}
	hub := NewHubWithGroupCallAuthorizer(nil, &groupTestPresence{}, trackedGroupCallAuthorizer{lease: lease}, rooms, nil, nil, nil, nil, nil, nil)
	client := &recordingClient{identity: sharedauth.Identity{UserID: targetID, DeviceID: "target-device"}, connectionID: "target-socket"}
	hub.Add(context.Background(), client)
	client.events = nil
	request := []byte(`{"version":3,"type":"group.call.signal","request_id":"signal-failure","payload":{"conversation_id":"` + conversationID.String() + `","room_id":"` + roomID.String() + `","generation":1,"target_user_id":"` + targetID.String() + `","target_device_id":"target-device","signal":{"type":"offer","sdp":"opaque","negotiation_id":"8c72dd14-fafe-4e2d-9735-e09c37358bf1"}}}`)
	if err := hub.HandleVersion(context.Background(), &recordingClient{identity: sharedauth.Identity{UserID: userID, DeviceID: "device"}, connectionID: "socket"}, 3, request); !errors.Is(err, rooms.publishErr) {
		t.Fatalf("signal error = %v, want Pub/Sub failure", err)
	}
	if len(client.events) != 0 {
		t.Fatalf("remote signal delivery = %#v, want none", client.events)
	}
	if lease.committed || !lease.rolledBack {
		t.Fatalf("lease committed=%v rolled_back=%v, want rollback", lease.committed, lease.rolledBack)
	}
}

func TestGroupCallJoinMutationFailureOrCancellationDoesNotDeliverLocally(t *testing.T) {
	for _, test := range []struct {
		name      string
		cancel    bool
		wantError error
	}{
		{name: "redis mutation error", wantError: errors.New("redis mutation failed")},
		{name: "canceled after mutation", cancel: true, wantError: context.Canceled},
	} {
		t.Run(test.name, func(t *testing.T) {
			userID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New()
			lease := &trackedGroupCallLease{revision: 3, members: []uuid.UUID{userID}}
			mutationErr := test.wantError
			if test.cancel {
				mutationErr = nil
			}
			rooms := &failedJoinGroupRoomPublisher{groupTestRooms: groupTestRooms{room: GroupRoom{
				ID: roomID, ConversationID: conversationID, MembershipRevision: 3, Generation: 1, Status: GroupRoomActive,
				Participants: []GroupParticipant{{UserID: userID, DeviceID: "device", ConnectionID: "socket"}},
			}}, mutationErr: mutationErr}
			ctx, cancel := context.WithCancel(context.Background())
			if test.cancel {
				rooms.cancel = cancel
			}
			defer cancel()
			hub := NewHubWithGroupCallAuthorizer(nil, &groupTestPresence{}, trackedGroupCallAuthorizer{lease: lease}, rooms, nil, nil, nil, nil, nil, nil)
			client := &recordingClient{identity: sharedauth.Identity{UserID: userID, DeviceID: "device"}, connectionID: "socket"}
			hub.Add(context.Background(), client)
			client.events = nil
			request := []byte(`{"version":3,"type":"group.call.join","request_id":"mutation-failure","payload":{"conversation_id":"` + conversationID.String() + `","room_id":"` + roomID.String() + `","generation":1}}`)
			if err := hub.HandleVersion(ctx, client, 3, request); !errors.Is(err, test.wantError) {
				t.Fatalf("join error = %v, want %v", err, test.wantError)
			}
			if len(client.events) != 0 {
				t.Fatalf("local delivery after unsuccessful/canceled mutation = %#v, want none", client.events)
			}
			if lease.committed || !lease.rolledBack {
				t.Fatalf("lease committed=%v rolled_back=%v", lease.committed, lease.rolledBack)
			}
		})
	}
}

type fallbackGroupRoomPublisher struct{ *failingGroupRoomPublisher }

type failedJoinGroupRoomPublisher struct {
	groupTestRooms
	mutationErr error
	cancel      context.CancelFunc
}

func (r *failedJoinGroupRoomPublisher) JoinGroupRoom(_ context.Context, _ uuid.UUID, _ GroupParticipant, _ int64, _ string) (GroupRoom, error) {
	if r.cancel != nil {
		r.cancel()
	}
	return r.room, r.mutationErr
}

type commandThenDeliveryAuthorizer struct {
	commandLease     *trackedGroupCallLease
	deliveryRevision int64
	deliveryMembers  []uuid.UUID
	called           bool
}

func (a *commandThenDeliveryAuthorizer) BeginGroupCall(context.Context, uuid.UUID, uuid.UUID) (GroupCallLease, error) {
	if !a.called {
		a.called = true
		return a.commandLease, nil
	}
	return &trackedGroupCallLease{revision: a.deliveryRevision, members: a.deliveryMembers}, nil
}

func (r *fallbackGroupRoomPublisher) SetGroupPresenter(_ context.Context, _ uuid.UUID, participant GroupParticipant, enabled bool) (GroupRoom, error) {
	r.mutationCalls++
	if enabled {
		r.room.Presenter = &participant
	} else {
		r.room.Presenter = nil
	}
	r.room.StateRevision++
	return r.room, nil
}

func (r *fallbackGroupRoomPublisher) EndGroupRoom(_ context.Context, _ uuid.UUID, _ GroupParticipant) (GroupRoom, error) {
	r.mutationCalls++
	room := r.room
	room.Status = GroupRoomEnded
	room.StateRevision++
	room.Participants = nil
	return room, nil
}

func TestGroupCallEnqueuesLocallyOnlyAfterFanoutAndLeaseRelease(t *testing.T) {
	userID, targetID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	lease := &trackedGroupCallLease{revision: 3, members: []uuid.UUID{userID, targetID}}
	room := GroupRoom{ID: roomID, ConversationID: conversationID, MembershipRevision: 3, Generation: 1, Status: GroupRoomActive, Participants: []GroupParticipant{{UserID: userID, DeviceID: "device", ConnectionID: "socket"}, {UserID: targetID, DeviceID: "target-device", ConnectionID: "target-socket"}}}
	rooms := &leaseObservingPublisher{groupTestRooms: groupTestRooms{room: room}, lease: lease}
	hub := NewHubWithGroupCallAuthorizer(nil, &groupTestPresence{}, trackedGroupCallAuthorizer{lease: lease}, rooms, nil, nil, nil, nil, nil, nil)
	client := &leaseCheckingClient{recordingClient: recordingClient{identity: sharedauth.Identity{UserID: targetID, DeviceID: "target-device"}, connectionID: "target-socket"}, lease: lease}
	hub.Add(context.Background(), client)
	client.events = nil
	owner := &recordingClient{identity: sharedauth.Identity{UserID: userID, DeviceID: "device"}, connectionID: "socket"}
	request := []byte(`{"version":3,"type":"group.call.presenter.start","request_id":"lease-order","payload":{"conversation_id":"` + conversationID.String() + `","room_id":"` + roomID.String() + `","generation":1}}`)
	if err := hub.HandleVersion(context.Background(), owner, 3, request); err != nil {
		t.Fatalf("group call command: %v", err)
	}
	if !rooms.publishedWhileLeased {
		t.Fatal("PubSub was not accepted while the PostgreSQL-style membership lease was held")
	}
	if !client.deliveredAfterRelease {
		t.Fatal("local socket enqueue did not happen after lease commit")
	}
	if len(client.events) != 1 {
		t.Fatalf("local events = %#v, want one", client.events)
	}
}

func TestGroupCommandLocalSignalPrecedesCommittedRevocationProjection(t *testing.T) {
	ownerID, memberID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	lease := &commitNotifyingLease{trackedGroupCallLease: trackedGroupCallLease{revision: 3, members: []uuid.UUID{ownerID, memberID}}, committed: make(chan struct{})}
	room := GroupRoom{ID: roomID, SupportRef: uuid.New(), ConversationID: conversationID, MembershipRevision: 3, Generation: 1, Status: GroupRoomActive, Participants: []GroupParticipant{{UserID: ownerID, DeviceID: "owner-device", ConnectionID: "owner-socket"}, {UserID: memberID, DeviceID: "member-device", ConnectionID: "member-socket"}}}
	hub := NewHubWithGroupCallAuthorizer(nil, &groupTestPresence{}, commitNotifyingAuthorizer{lease: lease}, &groupTestRooms{room: room}, nil, nil, nil, nil, nil, nil)
	owner := &recordingClient{identity: sharedauth.Identity{UserID: ownerID, DeviceID: "owner-device"}, connectionID: "owner-socket"}
	member := &blockingRecordingClient{recordingClient: recordingClient{identity: sharedauth.Identity{UserID: memberID, DeviceID: "member-device"}, connectionID: "member-socket"}, entered: make(chan struct{}), release: make(chan struct{})}
	hub.Add(context.Background(), owner)
	hub.Add(context.Background(), member)
	owner.events, member.events = nil, nil
	request := []byte(`{"version":3,"type":"group.call.signal","request_id":"ordered-signal","payload":{"conversation_id":"` + conversationID.String() + `","room_id":"` + roomID.String() + `","generation":1,"target_user_id":"` + memberID.String() + `","target_device_id":"member-device","signal":{"type":"offer","sdp":"opaque-test-sdp","negotiation_id":"8c72dd14-fafe-4e2d-9735-e09c37358bf1"}}}`)
	commandDone := make(chan error, 1)
	go func() { commandDone <- hub.HandleVersion(context.Background(), owner, 3, request) }()
	<-lease.committed
	<-member.entered // the lease is committed, but the command still owns the stripe while enqueueing.
	projectionDone := make(chan struct{})
	go func() {
		hub.DeliverGroupProjection(context.Background(), conversationID, 4, false, []uuid.UUID{memberID})
		close(projectionDone)
	}()
	close(member.release)
	if err := <-commandDone; err != nil {
		t.Fatalf("signal command: %v", err)
	}
	<-projectionDone
	if len(member.events) != 2 {
		t.Fatalf("member events = %#v, want signal then membership projection", member.events)
	}
	signal, ok := member.events[0].(serverEvent)
	if !ok || signal.Type != "group.call.signal" {
		t.Fatalf("first event = %#v, want signal", member.events[0])
	}
	payload, err := json.Marshal(signal.Payload)
	wantPayload := `{"room_id":"` + roomID.String() + `","generation":1,"from_user_id":"` + ownerID.String() + `","from_device_id":"owner-device","signal":{"type":"offer","sdp":"opaque-test-sdp","negotiation_id":"8c72dd14-fafe-4e2d-9735-e09c37358bf1"}}`
	if err != nil || !bytes.Equal(payload, []byte(wantPayload)) {
		t.Fatalf("signal payload = %s, want %s (err=%v)", payload, wantPayload, err)
	}
	projection, ok := member.events[1].(serverEvent)
	if !ok || projection.Type != "group.membership.changed" {
		t.Fatalf("second event = %#v, want membership projection", member.events[1])
	}
}

func TestHubDropsStalePubSubGroupSignalAfterCommittedRevocation(t *testing.T) {
	ownerID, memberID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	current := &trackedGroupCallLease{revision: 4, members: []uuid.UUID{ownerID, memberID}}
	hub := NewHubWithGroupCallAuthorizer(nil, &groupTestPresence{}, trackedGroupCallAuthorizer{lease: current}, &groupTestRooms{}, nil, nil, nil, nil, nil, nil)
	member := &recordingClient{identity: sharedauth.Identity{UserID: memberID, DeviceID: "member-device"}, connectionID: "member-socket"}
	hub.Add(context.Background(), member)
	member.events = nil
	room := GroupRoom{ID: roomID, ConversationID: conversationID, MembershipRevision: 3, Generation: 1, Status: GroupRoomActive, Participants: []GroupParticipant{{UserID: ownerID, DeviceID: "owner-device", ConnectionID: "owner-socket"}, {UserID: memberID, DeviceID: "member-device", ConnectionID: "member-socket"}}}
	hub.DeliverGroupRoom(context.Background(), GroupRoomChange{Type: "signal", Room: room, FromUserID: ownerID, FromDeviceID: "owner-device", ToUserID: memberID, ToDeviceID: "member-device", Signal: json.RawMessage(`{"type":"offer","sdp":"stale-secret"}`), ParticipantConnectionIDs: groupParticipantConnectionIDs(room)})
	if len(member.events) != 0 {
		t.Fatalf("stale room event delivered after revision advanced: %#v", member.events)
	}
}

type commitNotifyingLease struct {
	trackedGroupCallLease
	committed chan struct{}
}

type commitNotifyingAuthorizer struct{ lease *commitNotifyingLease }

func (a commitNotifyingAuthorizer) BeginGroupCall(context.Context, uuid.UUID, uuid.UUID) (GroupCallLease, error) {
	return a.lease, nil
}

func (l *commitNotifyingLease) Commit(context.Context) error {
	l.trackedGroupCallLease.Commit(context.Background())
	close(l.committed)
	return nil
}

type blockingRecordingClient struct {
	recordingClient
	entered chan struct{}
	release chan struct{}
}

func (c *blockingRecordingClient) SendJSON(event any) bool {
	if value, ok := event.(serverEvent); ok && value.Type == "group.call.signal" {
		close(c.entered)
		<-c.release
	}
	return c.recordingClient.SendJSON(event)
}

type leaseObservingPublisher struct {
	groupTestRooms
	lease                *trackedGroupCallLease
	publishedWhileLeased bool
}

func (r *leaseObservingPublisher) PublishGroupRoom(context.Context, GroupRoomChange) error {
	r.publishedWhileLeased = !r.lease.committed && !r.lease.rolledBack
	return nil
}

type leaseCheckingClient struct {
	recordingClient
	lease                 *trackedGroupCallLease
	deliveredAfterRelease bool
}

func (c *leaseCheckingClient) SendJSON(event any) bool {
	c.deliveredAfterRelease = c.lease.committed
	return c.recordingClient.SendJSON(event)
}

type trackedGroupCallAuthorizer struct{ lease *trackedGroupCallLease }

func (a trackedGroupCallAuthorizer) BeginGroupCall(context.Context, uuid.UUID, uuid.UUID) (GroupCallLease, error) {
	return a.lease, nil
}

type trackedGroupCallLease struct {
	revision   int64
	members    []uuid.UUID
	committed  bool
	rolledBack bool
}

func (l *trackedGroupCallLease) MembershipRevision() int64    { return l.revision }
func (l *trackedGroupCallLease) ActiveMemberIDs() []uuid.UUID { return l.members }
func (l *trackedGroupCallLease) Commit(context.Context) error {
	l.committed = true
	return nil
}
func (l *trackedGroupCallLease) Rollback(context.Context) error {
	l.rolledBack = true
	return nil
}

type failingGroupRoomPublisher struct {
	groupTestRooms
	publishErr error
}

func (r *failingGroupRoomPublisher) PublishGroupRoom(context.Context, GroupRoomChange) error {
	return r.publishErr
}

func TestExpiredGroupRoomReportsPublicationFailure(t *testing.T) {
	want := errors.New("publish failed")
	rooms := &failingGroupRoomPublisher{publishErr: want}
	hub := NewHubWithGroupCallAuthorizer(nil, nil, nil, rooms, nil, nil, nil, nil, nil, nil)
	err := hub.NotifyExpiredGroupRoom(context.Background(), GroupRoom{ID: uuid.New(), ConversationID: uuid.New(), Generation: 1, StateRevision: 2})
	if !errors.Is(err, want) {
		t.Fatalf("expiry publication error = %v, want %v", err, want)
	}
}

func TestGroupCallStartCommitErrorCleansOnlyAttemptedRoom(t *testing.T) {
	ownerID, conversationID, newerRoomID := uuid.New(), uuid.New(), uuid.New()
	presence := &commitErrorGroupStartAuthorizer{groupTestPresence: groupTestPresence{revision: 9, memberIDs: []uuid.UUID{ownerID}}}
	rooms := &groupTestRooms{newerRoom: GroupRoom{ID: newerRoomID, Generation: 2, Status: GroupRoomActive}}
	hub := NewHubWithGroupCallAuthorizer(nil, presence, presence, rooms, nil, nil, nil, nil, nil, nil)
	client := &recordingClient{identity: sharedauth.Identity{UserID: ownerID, DeviceID: "device"}, connectionID: "socket"}
	err := hub.HandleVersion(context.Background(), client, 3, []byte(`{"version":3,"type":"group.call.start","request_id":"commit-failure","payload":{"attempt_id":"00000000-0000-4000-8000-000000000001","conversation_id":"`+conversationID.String()+`"}}`))
	if err == nil {
		t.Fatal("expected commit failure")
	}
	if rooms.abortedRoom == uuid.Nil || rooms.abortedRoom == newerRoomID || rooms.abortCalls != 1 {
		t.Fatalf("abort room=%s calls=%d newer=%s", rooms.abortedRoom, rooms.abortCalls, newerRoomID)
	}
	if rooms.room.Status != GroupRoomEnded || rooms.room.ID != rooms.abortedRoom {
		t.Fatalf("attempted room not ended: %#v", rooms.room)
	}
	if rooms.newerRoom.ID != newerRoomID || rooms.newerRoom.Status != GroupRoomActive || rooms.newerRoom.Generation != 2 {
		t.Fatalf("newer room was affected: %#v", rooms.newerRoom)
	}
}

func TestGroupCallStartCancellationReleasesAdmissionAndLease(t *testing.T) {
	ownerID, conversationID := uuid.New(), uuid.New()
	presence := &cancelGroupStartAuthorizer{groupTestPresence: groupTestPresence{revision: 2, memberIDs: []uuid.UUID{ownerID}}}
	rooms := &cancelGroupStartRooms{}
	hub := NewHubWithGroupCallAuthorizer(nil, presence, presence, rooms, nil, nil, nil, nil, nil, nil)
	client := &recordingClient{identity: sharedauth.Identity{UserID: ownerID, DeviceID: "device"}, connectionID: "socket"}
	err := hub.HandleVersion(context.Background(), client, 3, []byte(`{"version":3,"type":"group.call.start","request_id":"cancel","payload":{"attempt_id":"00000000-0000-4000-8000-000000000001","conversation_id":"`+conversationID.String()+`"}}`))
	if err == nil || !errors.Is(err, context.Canceled) {
		t.Fatalf("start error = %v, want cancellation", err)
	}
	if !presence.rolledBack || rooms.releaseCalls != 1 || rooms.abortCalls != 1 {
		t.Fatalf("rollback=%v release=%d cleanup=%d", presence.rolledBack, rooms.releaseCalls, rooms.abortCalls)
	}
}

type cancelGroupStartAuthorizer struct {
	groupTestPresence
	rolledBack bool
}

func (a *cancelGroupStartAuthorizer) BeginGroupCall(context.Context, uuid.UUID, uuid.UUID) (GroupCallLease, error) {
	return &cancellableGroupStartLease{owner: a}, nil
}

type cancellableGroupStartLease struct{ owner *cancelGroupStartAuthorizer }

func (l *cancellableGroupStartLease) MembershipRevision() int64    { return l.owner.revision }
func (l *cancellableGroupStartLease) ActiveMemberIDs() []uuid.UUID { return l.owner.memberIDs }
func (*cancellableGroupStartLease) Commit(context.Context) error   { return nil }
func (l *cancellableGroupStartLease) Rollback(context.Context) error {
	l.owner.rolledBack = true
	return nil
}

type commitErrorGroupStartAuthorizer struct{ groupTestPresence }

func (a *commitErrorGroupStartAuthorizer) BeginGroupCall(context.Context, uuid.UUID, uuid.UUID) (GroupCallLease, error) {
	return commitErrorGroupStartLease{revision: a.revision, members: a.memberIDs}, nil
}

type commitErrorGroupStartLease struct {
	revision int64
	members  []uuid.UUID
}

func (l commitErrorGroupStartLease) MembershipRevision() int64    { return l.revision }
func (l commitErrorGroupStartLease) ActiveMemberIDs() []uuid.UUID { return l.members }
func (commitErrorGroupStartLease) Commit(context.Context) error {
	return errors.New("commit outcome unknown")
}
func (commitErrorGroupStartLease) Rollback(context.Context) error { return nil }

type cancelGroupStartRooms struct {
	groupTestRooms
	releaseCalls int
	abortCalls   int
}

func (r *cancelGroupStartRooms) StartGroupRoom(_ context.Context, room GroupRoom, _ string) (GroupRoom, error) {
	r.room = room
	return GroupRoom{}, context.Canceled
}

func (r *cancelGroupStartRooms) StartPreparedGroupRoom(ctx context.Context, room GroupRoom, token string, _ uuid.UUID) (GroupRoom, error) {
	return r.StartGroupRoom(ctx, room, token)
}

func (r *cancelGroupStartRooms) AcquireCallAdmission(context.Context, []uuid.UUID) (string, error) {
	return "admission", nil
}
func (r *cancelGroupStartRooms) ReleaseCallAdmission(context.Context, []uuid.UUID, string) {
	r.releaseCalls++
}
func (r *cancelGroupStartRooms) AbortGroupRoomStart(_ context.Context, roomID uuid.UUID, _ int64, _ GroupParticipant) error {
	r.abortCalls++
	r.abortedRoom = roomID
	return nil
}

type groupStartOrder struct {
	mu        sync.Mutex
	revision  int64
	memberIDs []uuid.UUID
	steps     []string
}

func (o *groupStartOrder) record(step string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.steps = append(o.steps, step)
}

func (o *groupStartOrder) snapshot() []string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return append([]string(nil), o.steps...)
}

func (o *groupStartOrder) PeerIDs(context.Context, uuid.UUID) ([]uuid.UUID, error) { return nil, nil }
func (o *groupStartOrder) RecipientID(context.Context, uuid.UUID, uuid.UUID) (uuid.UUID, error) {
	return uuid.Nil, nil
}
func (o *groupStartOrder) BeginGroupCall(context.Context, uuid.UUID, uuid.UUID) (GroupCallLease, error) {
	o.record("lease.begin")
	o.mu.Lock()
	return &orderedGroupStartLease{order: o, revision: o.revision, members: append([]uuid.UUID(nil), o.memberIDs...)}, nil
}

func (o *groupStartOrder) revokeAndProject(hub *Hub, conversationID, retainedMemberID uuid.UUID, committed chan struct{}, allowProjection <-chan struct{}) error {
	o.mu.Lock() // waits for the start lease's Commit/Rollback
	o.revision++
	o.memberIDs = []uuid.UUID{retainedMemberID}
	o.steps = append(o.steps, "membership.revoke")
	o.mu.Unlock()
	close(committed)
	<-allowProjection
	if err := hub.NotifyGroupProjection(context.Background(), conversationID, o.revision, false, o.memberIDs); err != nil {
		return err
	}
	o.record("projection.cleanup")
	return nil
}

type orderedGroupStartLease struct {
	order    *groupStartOrder
	revision int64
	members  []uuid.UUID
}

func (l *orderedGroupStartLease) MembershipRevision() int64    { return l.revision }
func (l *orderedGroupStartLease) ActiveMemberIDs() []uuid.UUID { return l.members }
func (l *orderedGroupStartLease) Commit(context.Context) error {
	l.order.steps = append(l.order.steps, "lease.commit")
	l.order.mu.Unlock()
	return nil
}
func (l *orderedGroupStartLease) Rollback(context.Context) error {
	l.order.mu.Unlock()
	return nil
}

type orderedGroupStartRooms struct {
	groupTestRooms
	entered       chan struct{}
	continueStart chan struct{}
	order         *groupStartOrder
}

func (r *orderedGroupStartRooms) StartGroupRoom(ctx context.Context, room GroupRoom, token string) (GroupRoom, error) {
	close(r.entered)
	select {
	case <-ctx.Done():
		return GroupRoom{}, ctx.Err()
	case <-r.continueStart:
	}
	r.order.steps = append(r.order.steps, "redis.start")
	return r.groupTestRooms.StartGroupRoom(ctx, room, token)
}

func (r *orderedGroupStartRooms) StartPreparedGroupRoom(ctx context.Context, room GroupRoom, token string, _ uuid.UUID) (GroupRoom, error) {
	return r.StartGroupRoom(ctx, room, token)
}

func (r *orderedGroupStartRooms) AcquireCallAdmission(ctx context.Context, ids []uuid.UUID) (string, error) {
	r.order.record("admission.acquire")
	return r.groupTestRooms.AcquireCallAdmission(ctx, ids)
}

func (r *orderedGroupStartRooms) ReleaseCallAdmission(ctx context.Context, ids []uuid.UUID, token string) {
	r.order.record("admission.release")
	r.groupTestRooms.ReleaseCallAdmission(ctx, ids, token)
}

type revokedGroupStartPresence struct{ groupTestPresence }

func (p *revokedGroupStartPresence) BeginGroupCall(context.Context, uuid.UUID, uuid.UUID) (GroupCallLease, error) {
	return nil, ErrCallNotAllowed
}

func TestHubQueuesGroupStartForInitiatorBeforeMembers(t *testing.T) {
	ownerID, memberID, conversationID := uuid.New(), uuid.New(), uuid.New()
	presence := &groupTestPresence{revision: 4, memberIDs: []uuid.UUID{ownerID, memberID}}
	rooms := &groupTestRooms{}
	hub := NewHubWithGroupCallAuthorizer(nil, presence, presence, rooms, nil, nil, nil, nil, nil, nil)
	var deliveryOrder []string
	owner := &orderedRecordingClient{recordingClient: recordingClient{identity: sharedauth.Identity{UserID: ownerID, DeviceID: "owner-device"}, connectionID: "owner-socket"}, delivered: &deliveryOrder, name: "owner"}
	member := &orderedRecordingClient{recordingClient: recordingClient{identity: sharedauth.Identity{UserID: memberID, DeviceID: "member-device"}, connectionID: "member-socket"}, delivered: &deliveryOrder, name: "member"}
	hub.Add(context.Background(), owner)
	hub.Add(context.Background(), member)
	deliveryOrder = nil
	owner.events = nil
	member.events = nil

	if err := hub.HandleVersion(context.Background(), owner, 3, []byte(`{"version":3,"type":"group.call.start","request_id":"start-1","payload":{"attempt_id":"00000000-0000-4000-8000-000000000001","conversation_id":"`+conversationID.String()+`"}}`)); err != nil {
		t.Fatalf("start group room: %v", err)
	}
	if got, want := deliveryOrder, []string{"owner:group.call.start_accepted", "owner:group.call.started", "member:group.call.started"}; !equalStrings(got, want) {
		t.Fatalf("delivery order = %v, want %v", got, want)
	}
	ack := owner.events[0].(serverEvent)
	if ack.RequestID != "start-1" {
		t.Fatalf("start acknowledgement request ID = %q", ack.RequestID)
	}
	peerPayload, err := json.Marshal(member.events[0])
	if err != nil || bytes.Contains(peerPayload, []byte("00000000-0000-4000-8000-000000000001")) || bytes.Contains(peerPayload, []byte("attempt_id")) {
		t.Fatalf("capability leaked to peer: %s err=%v", peerPayload, err)
	}
}

func TestHubRejectsGroupSignalFromSiblingSocket(t *testing.T) {
	userID, targetID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	rooms := &groupTestRooms{room: GroupRoom{ID: roomID, ConversationID: conversationID, MembershipRevision: 2, Generation: 1, Status: GroupRoomActive, Participants: []GroupParticipant{{UserID: userID, DeviceID: "device", ConnectionID: "owner"}, {UserID: targetID, DeviceID: "target", ConnectionID: "target-owner"}}}}
	hub := NewHub(nil, &groupTestPresence{revision: 2}, rooms, nil, nil, nil, nil)
	client := &recordingClient{identity: sharedauth.Identity{UserID: userID, DeviceID: "device"}, connectionID: "sibling"}

	err := hub.HandleVersion(context.Background(), client, 3, []byte(`{"version":3,"type":"group.call.signal","request_id":"signal-1","payload":{"conversation_id":"`+conversationID.String()+`","room_id":"`+roomID.String()+`","generation":1,"target_user_id":"`+targetID.String()+`","target_device_id":"target","signal":{"type":"offer","sdp":"safe","negotiation_id":"8c72dd14-fafe-4e2d-9735-e09c37358bf1"}}}`))
	if err == nil || err.Error() != ErrCallNotAllowed.Error() {
		t.Fatalf("signal error = %v", err)
	}
}

func TestHubRejectsGroupRoomActionsForDifferentConversation(t *testing.T) {
	userID, targetID, actualConversationID, suppliedConversationID, roomID := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	for _, action := range []string{"group.call.join", "group.call.leave", "group.call.end", "group.call.presenter.start", "group.call.signal"} {
		t.Run(action, func(t *testing.T) {
			rooms := &groupTestRooms{room: GroupRoom{ID: roomID, ConversationID: actualConversationID, MembershipRevision: 2, Generation: 1, Status: GroupRoomActive, Participants: []GroupParticipant{{UserID: userID, DeviceID: "device", ConnectionID: "socket"}, {UserID: targetID, DeviceID: "target-device", ConnectionID: "target"}}}}
			hub := NewHub(nil, &groupTestPresence{revision: 2}, rooms, nil, nil, nil, nil)
			client := &recordingClient{identity: sharedauth.Identity{UserID: userID, DeviceID: "device"}, connectionID: "socket"}
			payload := `{"version":3,"type":"` + action + `","request_id":"mismatch","payload":{"conversation_id":"` + suppliedConversationID.String() + `","room_id":"` + roomID.String() + `","generation":1,"target_user_id":"` + targetID.String() + `","target_device_id":"target-device","signal":{"type":"offer","sdp":"safe","negotiation_id":"8c72dd14-fafe-4e2d-9735-e09c37358bf1"}}}`
			if err := hub.HandleVersion(context.Background(), client, 3, []byte(payload)); err == nil {
				t.Fatal("action using another conversation was authorized")
			}
			if rooms.mutationCalls != 0 {
				t.Fatalf("Redis mutation calls = %d, want none", rooms.mutationCalls)
			}
		})
	}
}

func TestHubBindsEveryV2GroupRoomCommandToPositiveGeneration(t *testing.T) {
	userID, targetID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	commands := []string{
		"group.call.join",
		"group.call.leave",
		"group.call.end",
		"group.call.presenter.start",
		"group.call.presenter.stop",
		"group.call.signal",
	}
	for _, command := range commands {
		for _, testCase := range []struct {
			name       string
			generation string
			wantErr    bool
		}{
			{name: "missing", wantErr: true},
			{name: "wrong", generation: `,"generation":2`, wantErr: true},
			{name: "valid", generation: `,"generation":1`},
		} {
			t.Run(command+"/"+testCase.name, func(t *testing.T) {
				rooms := &groupTestRooms{room: GroupRoom{
					ID: roomID, ConversationID: conversationID, MembershipRevision: 2,
					Generation: 1, Status: GroupRoomActive,
					Participants: []GroupParticipant{
						{UserID: userID, DeviceID: "device", ConnectionID: "socket"},
						{UserID: targetID, DeviceID: "target-device", ConnectionID: "target"},
					},
				}}
				presence := &groupTestPresence{revision: 2, memberIDs: []uuid.UUID{userID, targetID}}
				hub := NewHub(nil, presence, rooms, nil, nil, nil, nil)
				client := &recordingClient{identity: sharedauth.Identity{UserID: userID, DeviceID: "device"}, connectionID: "socket"}
				payload := `{"version":3,"type":"` + command + `","request_id":"generation-test","payload":{"conversation_id":"` + conversationID.String() + `","room_id":"` + roomID.String() + `"` + testCase.generation + `,"target_user_id":"` + targetID.String() + `","target_device_id":"target-device","signal":{"type":"offer","sdp":"safe","negotiation_id":"8c72dd14-fafe-4e2d-9735-e09c37358bf1"}}}`

				err := hub.HandleVersion(context.Background(), client, 3, []byte(payload))
				if testCase.wantErr && err == nil {
					t.Fatal("command without the exact positive room generation was accepted")
				}
				if !testCase.wantErr && err != nil {
					t.Fatalf("command with matching generation was rejected: %v", err)
				}
				if testCase.wantErr && rooms.mutationCalls != 0 {
					t.Fatalf("rejected command made %d room mutations", rooms.mutationCalls)
				}
			})
		}
	}
}

func TestHubDeliversGroupEndToRemainingParticipant(t *testing.T) {
	ownerID, memberID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	rooms := &groupTestRooms{room: GroupRoom{ID: roomID, ConversationID: conversationID, MembershipRevision: 2, Generation: 1, StateRevision: 7, Status: GroupRoomActive, Participants: []GroupParticipant{{UserID: ownerID, DeviceID: "owner-device", ConnectionID: "owner-socket"}, {UserID: memberID, DeviceID: "member-device", ConnectionID: "member-socket"}}}}
	hub := NewHub(nil, &groupTestPresence{revision: 2}, rooms, nil, nil, nil, nil)
	owner := &recordingClient{identity: sharedauth.Identity{UserID: ownerID, DeviceID: "owner-device"}, connectionID: "owner-socket"}
	member := &recordingClient{identity: sharedauth.Identity{UserID: memberID, DeviceID: "member-device"}, connectionID: "member-socket"}
	sibling := &recordingClient{identity: sharedauth.Identity{UserID: memberID, DeviceID: "member-device"}, connectionID: "member-sibling"}
	hub.Add(context.Background(), owner)
	hub.Add(context.Background(), member)
	hub.Add(context.Background(), sibling)
	owner.events = nil
	member.events = nil
	sibling.events = nil

	err := hub.HandleVersion(context.Background(), owner, 3, []byte(`{"version":3,"type":"group.call.end","request_id":"end-1","payload":{"conversation_id":"`+conversationID.String()+`","room_id":"`+roomID.String()+`","generation":1}}`))
	if err != nil {
		t.Fatalf("end group room: %v", err)
	}
	if len(member.events) != 1 {
		t.Fatalf("member events = %#v", member.events)
	}
	event, ok := member.events[0].(serverEvent)
	if !ok || event.Type != "group.call.ended" {
		t.Fatalf("member terminal event = %#v", member.events[0])
	}
	endedPayload, err := json.Marshal(event.Payload)
	if err != nil {
		t.Fatalf("marshal terminal payload: %v", err)
	}
	var ended struct {
		StateRevision int64 `json:"state_revision"`
	}
	if err := json.Unmarshal(endedPayload, &ended); err != nil {
		t.Fatalf("decode terminal payload: %v", err)
	}
	if ended.StateRevision != 8 {
		t.Fatalf("terminal state revision = %d, want post-end revision 8: %s", ended.StateRevision, endedPayload)
	}
	if len(sibling.events) != 0 {
		t.Fatalf("sibling events = %#v", sibling.events)
	}
}

func TestHubDeliversGroupEndAfterPubSubRoundTrip(t *testing.T) {
	ownerID, memberID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	room := GroupRoom{ID: roomID, ConversationID: conversationID, MembershipRevision: 2, Generation: 1, Status: GroupRoomEnded, Participants: []GroupParticipant{{UserID: ownerID, DeviceID: "owner-device", ConnectionID: "owner-socket"}, {UserID: memberID, DeviceID: "member-device", ConnectionID: "member-socket"}}}
	hub := NewHub(nil, &groupTestPresence{revision: 2}, &groupTestRooms{}, nil, nil, nil, nil)
	member := &recordingClient{identity: sharedauth.Identity{UserID: memberID, DeviceID: "member-device"}, connectionID: "member-socket"}
	hub.Add(context.Background(), member)
	member.events = nil

	change := GroupRoomChange{Type: "ended", Room: room, ParticipantConnectionIDs: groupParticipantConnectionIDs(room)}
	payload, err := json.Marshal(change)
	if err != nil {
		t.Fatalf("marshal group room change: %v", err)
	}
	var delivered GroupRoomChange
	if err := json.Unmarshal(payload, &delivered); err != nil {
		t.Fatalf("unmarshal group room change: %v", err)
	}
	if delivered.Room.Participants[1].ConnectionID != "" {
		t.Fatalf("connection ID leaked into room payload: %#v", delivered.Room.Participants[1])
	}

	hub.DeliverGroupRoom(context.Background(), delivered)
	if len(member.events) != 1 {
		t.Fatalf("member events = %#v", member.events)
	}
	event, ok := member.events[0].(serverEvent)
	if !ok || event.Type != "group.call.ended" {
		t.Fatalf("member terminal event = %#v", member.events[0])
	}
}

func TestHubGroupRoomFanoutRequiresV2Protocol(t *testing.T) {
	ownerID, peerID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	room := GroupRoom{ID: roomID, ConversationID: conversationID, MembershipRevision: 2, Generation: 1, Status: GroupRoomActive, ExpiresAt: time.Now().Add(time.Minute), Participants: []GroupParticipant{
		{UserID: ownerID, DeviceID: "owner", ConnectionID: "owner-socket"},
		{UserID: peerID, DeviceID: "peer", ConnectionID: "peer-v1-socket"},
		{UserID: peerID, DeviceID: "peer", ConnectionID: "peer-v2-socket"},
	}}
	for _, eventType := range []string{"started", "participant.joined", "participant.left", "ended", "presenter.start", "presenter.stop", "signal"} {
		t.Run(eventType, func(t *testing.T) {
			presence := &groupTestPresence{revision: 2, memberIDs: []uuid.UUID{ownerID, peerID}}
			hub := NewHubWithGroupCallAuthorizer(nil, presence, presence, &groupTestRooms{room: room}, nil, nil, nil, nil, nil, nil)
			v1 := &versionedRecordingClient{recordingClient: recordingClient{identity: sharedauth.Identity{UserID: peerID, DeviceID: "peer"}, connectionID: "peer-v1-socket"}, version: 1}
			v2 := &versionedRecordingClient{recordingClient: recordingClient{identity: sharedauth.Identity{UserID: peerID, DeviceID: "peer"}, connectionID: "peer-v2-socket"}, version: 3}
			hub.Add(context.Background(), v1)
			hub.Add(context.Background(), v2)
			v1.events = nil
			v2.events = nil
			change := GroupRoomChange{Type: eventType, Room: room, ParticipantConnectionIDs: groupParticipantConnectionIDs(room), ToUserID: peerID, ToDeviceID: "peer", Signal: json.RawMessage(`{"type":"offer","sdp":"safe"}`)}
			hub.DeliverGroupRoom(context.Background(), change)
			if len(v1.events) != 0 {
				t.Fatalf("v1 received group call event: %#v", v1.events)
			}
			if len(v2.events) != 1 {
				t.Fatalf("v2 events = %#v, want one", v2.events)
			}
			got := v2.events[0].(serverEvent).Type
			want := "group.call." + eventType
			if got != want {
				t.Fatalf("v2 event = %q, want %q", got, want)
			}
		})
	}
}

type versionedRecordingClient struct {
	recordingClient
	version int
}

func (c *versionedRecordingClient) ProtocolVersion() int { return c.version }

func TestHubMembershipChangeTerminatesRemovedParticipantRoomSocket(t *testing.T) {
	ownerID, removedID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	rooms := &groupTestRooms{room: GroupRoom{ID: roomID, ConversationID: conversationID, MembershipRevision: 2, StateRevision: 7, Generation: 4, Status: GroupRoomActive, Participants: []GroupParticipant{{UserID: ownerID, DeviceID: "owner", ConnectionID: "owner-socket"}, {UserID: removedID, DeviceID: "removed", ConnectionID: "removed-socket"}}}}
	hub := NewHubWithGroupCallAuthorizer(nil, &groupTestPresence{}, currentProjectionAuthorizer{revision: 3, activeUserIDs: map[uuid.UUID]bool{ownerID: true}}, rooms, nil, nil, nil, nil, nil, nil)
	owner := &recordingClient{identity: sharedauth.Identity{UserID: ownerID, DeviceID: "owner"}, connectionID: "owner-socket"}
	removed := &recordingClient{identity: sharedauth.Identity{UserID: removedID, DeviceID: "removed"}, connectionID: "removed-socket"}
	hub.Add(context.Background(), owner)
	hub.Add(context.Background(), removed)
	owner.events, removed.events = nil, nil

	if err := hub.NotifyGroupProjection(context.Background(), conversationID, 3, false, []uuid.UUID{ownerID}); err != nil {
		t.Fatalf("notify projection: %v", err)
	}
	var activeEvent serverEvent
	for _, rawEvent := range owner.events {
		if event, ok := rawEvent.(serverEvent); ok && event.Type == "group.call.ended" {
			activeEvent = event
			break
		}
	}
	if activeEvent.Type != "group.call.ended" {
		t.Fatalf("active terminal event not delivered: %#v", owner.events)
	}
	activePayload, err := json.Marshal(activeEvent.Payload)
	if err != nil {
		t.Fatalf("marshal active payload: %v", err)
	}
	var activeRoom map[string]json.RawMessage
	if err := json.Unmarshal(activePayload, &activeRoom); err != nil {
		t.Fatalf("decode active payload: %v", err)
	}
	if _, ok := activeRoom["conversation_id"]; !ok || activeRoom["participants"] == nil {
		t.Fatalf("active member did not receive full terminal room: %s", activePayload)
	}
	if len(removed.events) != 1 {
		t.Fatalf("removed participant events = %#v", removed.events)
	}
	event, ok := removed.events[0].(serverEvent)
	if !ok || event.Type != "group.call.ended" {
		t.Fatalf("removed terminal event = %#v", removed.events[0])
	}
	payload, err := json.Marshal(event.Payload)
	if err != nil {
		t.Fatalf("marshal removed payload: %v", err)
	}
	var minimal map[string]json.RawMessage
	if err := json.Unmarshal(payload, &minimal); err != nil {
		t.Fatalf("decode removed payload: %v", err)
	}
	for _, forbidden := range []string{"conversation_id", "participants", "presenter", "ice_servers", "connection_id", "participant_connection_ids"} {
		if _, exists := minimal[forbidden]; exists {
			t.Errorf("removed payload leaked %q: %s", forbidden, payload)
		}
	}
	if len(minimal) != 4 || string(minimal["status"]) != `"ended"` || string(minimal["state_revision"]) != "8" {
		t.Fatalf("removed terminal payload = %s; want minimal revision 8", payload)
	}
}

type retryMembershipRetirementRooms struct {
	groupTestRooms
	retired      GroupRoom
	revision     int64
	loseResponse bool
	raceNotFound bool
	raceOnRead   bool
	failPublish  bool
	attempts     []GroupRoomChange
}

func (r *retryMembershipRetirementRooms) GetGroupRoomForConversation(ctx context.Context, conversation uuid.UUID) (GroupRoom, error) {
	if r.raceOnRead {
		r.raceOnRead = false
		r.retired = r.room
		r.retired.Status = GroupRoomEnded
		r.retired.StateRevision++
		r.revision = r.room.MembershipRevision + 1
		return GroupRoom{}, ErrCallNotFound
	}
	return r.groupTestRooms.GetGroupRoomForConversation(ctx, conversation)
}

func (r *retryMembershipRetirementRooms) EndGroupRoomForMembershipChange(ctx context.Context, conversation, id uuid.UUID, generation, stateRevision, membershipRevision int64) (GroupRoom, error) {
	old := r.room
	terminal, err := r.groupTestRooms.EndGroupRoomForMembershipChange(ctx, conversation, id, generation, stateRevision, membershipRevision)
	if err != nil {
		return GroupRoom{}, err
	}
	old.Status, old.StateRevision = GroupRoomEnded, terminal.StateRevision
	r.retired, r.revision = old, membershipRevision
	if r.raceNotFound {
		r.raceNotFound = false
		return GroupRoom{}, ErrCallNotFound
	}
	if r.loseResponse {
		r.loseResponse = false
		return GroupRoom{}, errors.New("lost retirement response")
	}
	return terminal, nil
}

func TestMembershipProjectionRecoversConcurrentRetirementAfterNotFound(t *testing.T) {
	for _, onRead := range []bool{false, true} {
		t.Run(map[bool]string{false: "cas", true: "room read"}[onRead], func(t *testing.T) {
			ownerID, conversation, roomID := uuid.New(), uuid.New(), uuid.New()
			room := GroupRoom{ID: roomID, ConversationID: conversation, MembershipRevision: 1, Generation: 1, StateRevision: 3, Status: GroupRoomActive, Participants: []GroupParticipant{{UserID: ownerID, DeviceID: "owner", ConnectionID: "socket"}}}
			rooms := &retryMembershipRetirementRooms{groupTestRooms: groupTestRooms{room: room}, raceNotFound: !onRead, raceOnRead: onRead}
			hub := NewHub(nil, &groupTestPresence{}, rooms, nil, nil, nil, nil)
			if err := hub.NotifyGroupProjection(context.Background(), conversation, 2, false, []uuid.UUID{ownerID}); err != nil {
				t.Fatal(err)
			}
			if len(rooms.attempts) != 1 || rooms.attempts[0].Room.ID != roomID || rooms.attempts[0].Room.StateRevision != 4 {
				t.Fatalf("concurrent retirement was not published: %+v", rooms.attempts)
			}
		})
	}
}

func (r *retryMembershipRetirementRooms) GetGroupMembershipRetirement(_ context.Context, conversation uuid.UUID, revision int64) (GroupRoom, error) {
	if r.retired.ID == uuid.Nil || r.retired.ConversationID != conversation || r.revision != revision {
		return GroupRoom{}, ErrCallNotFound
	}
	return r.retired, nil
}

func (r *retryMembershipRetirementRooms) PublishGroupRoom(_ context.Context, change GroupRoomChange) error {
	r.attempts = append(r.attempts, change)
	if r.failPublish {
		r.failPublish = false
		return errors.New("publication failed")
	}
	return nil
}

func TestMembershipProjectionRetriesLostRetirementAndPublication(t *testing.T) {
	ownerID, removedID, conversation, oldID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	old := GroupRoom{ID: oldID, ConversationID: conversation, MembershipRevision: 1, Generation: 1, StateRevision: 3, Status: GroupRoomActive, Participants: []GroupParticipant{{UserID: ownerID, DeviceID: "owner", ConnectionID: "owner-socket"}, {UserID: removedID, DeviceID: "removed", ConnectionID: "removed-socket"}}}
	rooms := &retryMembershipRetirementRooms{groupTestRooms: groupTestRooms{room: old}, loseResponse: true, failPublish: true}
	verifier := currentProjectionAuthorizer{revision: 2, activeUserIDs: map[uuid.UUID]bool{ownerID: true}}
	hub := NewHubWithGroupCallAuthorizer(nil, &groupTestPresence{}, verifier, rooms, nil, nil, nil, nil, nil, nil)
	removed := &recordingClient{identity: sharedauth.Identity{UserID: removedID, DeviceID: "removed"}, connectionID: "removed-socket"}
	sibling := &recordingClient{identity: removed.identity, connectionID: "other-socket"}
	hub.Add(context.Background(), removed)
	hub.Add(context.Background(), sibling)
	removed.events, sibling.events = nil, nil
	if err := hub.NotifyGroupProjection(context.Background(), conversation, 2, false, []uuid.UUID{ownerID}); err == nil {
		t.Fatal("lost retirement response was acknowledged")
	}
	newRoom := GroupRoom{ID: uuid.New(), ConversationID: conversation, MembershipRevision: 2, Generation: 2, StateRevision: 1, Status: GroupRoomRinging}
	rooms.room = newRoom
	if err := hub.NotifyGroupProjection(context.Background(), conversation, 2, false, []uuid.UUID{ownerID}); err == nil {
		t.Fatal("failed publication was acknowledged")
	}
	if err := hub.NotifyGroupProjection(context.Background(), conversation, 2, false, []uuid.UUID{ownerID}); err != nil {
		t.Fatalf("publication retry: %v", err)
	}
	if len(rooms.attempts) != 2 {
		t.Fatalf("publication attempts=%+v", rooms.attempts)
	}
	for _, change := range rooms.attempts {
		if change.Type != "ended" || change.Room.ID != oldID || change.Room.StateRevision != 4 || change.MembershipProjectionRevision != 2 || change.ParticipantConnectionIDs[groupParticipantKey(removedID, "removed")] != "removed-socket" {
			t.Fatalf("wrong terminal retry: %+v", change)
		}
	}
	if rooms.room.ID != newRoom.ID || rooms.room.Status != GroupRoomRinging {
		t.Fatalf("new room changed: %+v", rooms.room)
	}
	if len(removed.events) == 0 || len(sibling.events) != 0 {
		t.Fatalf("retired socket delivery=%+v sibling=%+v", removed.events, sibling.events)
	}
}

type cutoffProjectionRooms struct {
	retryMembershipRetirementRooms
	projectionCount int
}

func (r *cutoffProjectionRooms) PublishGroupProjection(_ context.Context, _ uuid.UUID, _ int64, _ bool, _ []uuid.UUID) error {
	r.projectionCount++
	return nil
}

func TestMembershipProjectionAfterTerminalEvidenceExpires(t *testing.T) {
	ownerID, removedID, conversation, roomID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	room := GroupRoom{ID: roomID, ConversationID: conversation, MembershipRevision: 1, Generation: 1, StateRevision: 3, Status: GroupRoomActive, Participants: []GroupParticipant{{UserID: ownerID, DeviceID: "owner", ConnectionID: "owner-socket"}, {UserID: removedID, DeviceID: "removed", ConnectionID: "removed-socket"}}}
	rooms := &cutoffProjectionRooms{retryMembershipRetirementRooms: retryMembershipRetirementRooms{groupTestRooms: groupTestRooms{room: room}, failPublish: true}}
	verifier := currentProjectionAuthorizer{revision: 2, activeUserIDs: map[uuid.UUID]bool{ownerID: true}}
	hub := NewHubWithGroupCallAuthorizer(nil, &groupTestPresence{}, verifier, rooms, nil, nil, nil, nil, nil, nil)
	if err := hub.NotifyGroupProjection(context.Background(), conversation, 2, false, []uuid.UUID{ownerID, removedID}); err == nil {
		t.Fatal("terminal publish failure must retry while evidence exists")
	}
	if len(rooms.attempts) != 1 || rooms.projectionCount != 0 {
		t.Fatalf("before cutoff terminal=%d projection=%d", len(rooms.attempts), rooms.projectionCount)
	}
	// Simulate the bounded Redis tombstone expiring before the outbox retries.
	rooms.retired = GroupRoom{}
	owner := &recordingClient{identity: sharedauth.Identity{UserID: ownerID, DeviceID: "owner"}, connectionID: "owner-socket"}
	removed := &recordingClient{identity: sharedauth.Identity{UserID: removedID, DeviceID: "removed"}, connectionID: "removed-socket"}
	hub.Add(context.Background(), owner)
	hub.Add(context.Background(), removed)
	owner.events, removed.events = nil, nil
	if err := hub.NotifyGroupProjection(context.Background(), conversation, 2, false, []uuid.UUID{ownerID, removedID}); err != nil {
		t.Fatalf("projection after terminal cutoff: %v", err)
	}
	if len(rooms.attempts) != 1 || rooms.projectionCount != 1 {
		t.Fatalf("after cutoff terminal=%d projection=%d", len(rooms.attempts), rooms.projectionCount)
	}
	for name, client := range map[string]*recordingClient{"owner": owner, "removed": removed} {
		if len(client.events) != 1 || client.events[0].(serverEvent).Type != "group.membership.changed" {
			t.Fatalf("%s received events=%+v, want only membership projection", name, client.events)
		}
	}
}

func TestGroupProjectionTerminalFanoutReachesRemotePreTerminalSockets(t *testing.T) {
	for _, deleted := range []bool{false, true} {
		t.Run(map[bool]string{false: "removal", true: "deletion"}[deleted], func(t *testing.T) {
			ownerID, removedID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
			room := GroupRoom{ID: roomID, ConversationID: conversationID, MembershipRevision: 2, Generation: 4, Status: GroupRoomActive, Participants: []GroupParticipant{
				{UserID: ownerID, DeviceID: "owner", ConnectionID: "owner-socket"},
				{UserID: removedID, DeviceID: "removed", ConnectionID: "removed-socket"},
			}}
			publisherRooms := &groupTestRooms{room: room}
			publisher := NewHub(nil, &groupTestPresence{}, publisherRooms, nil, nil, nil, nil)
			if err := publisher.NotifyGroupProjection(context.Background(), conversationID, 3, deleted, []uuid.UUID{ownerID}); err != nil {
				t.Fatalf("publish projection: %v", err)
			}
			if len(publisherRooms.published) != 1 {
				t.Fatalf("published room changes = %#v, want one terminal projection", publisherRooms.published)
			}

			// The remote replica has the pre-terminal sockets, but authorization
			// confirms that no actor is currently active (as after removal/delete).
			verifier := currentProjectionAuthorizer{revision: 3, activeUserIDs: map[uuid.UUID]bool{ownerID: !deleted}}
			remote := NewHubWithGroupCallAuthorizer(nil, &groupTestPresence{}, verifier, &groupTestRooms{}, nil, nil, nil, nil, nil, nil)
			owner := &recordingClient{identity: sharedauth.Identity{UserID: ownerID, DeviceID: "owner"}, connectionID: "owner-socket"}
			removed := &recordingClient{identity: sharedauth.Identity{UserID: removedID, DeviceID: "removed"}, connectionID: "removed-socket"}
			sibling := &recordingClient{identity: sharedauth.Identity{UserID: removedID, DeviceID: "removed"}, connectionID: "removed-sibling"}
			remote.Add(context.Background(), owner)
			remote.Add(context.Background(), removed)
			remote.Add(context.Background(), sibling)
			owner.events, removed.events, sibling.events = nil, nil, nil

			change := publisherRooms.published[0]
			if change.MembershipProjectionRevision != 3 || change.MembershipProjectionDeleted != deleted {
				t.Fatalf("terminal projection metadata = %#v", change)
			}
			if change.Room.StateRevision <= room.StateRevision || len(change.Room.Participants) != len(room.Participants) {
				t.Fatalf("terminal event lost post-end revision or pre-end socket roster: %#v", change.Room)
			}
			payload, err := json.Marshal(change)
			if err != nil {
				t.Fatalf("marshal internal pub/sub event: %v", err)
			}
			var remoteChange GroupRoomChange
			if err := json.Unmarshal(payload, &remoteChange); err != nil {
				t.Fatalf("unmarshal internal pub/sub event: %v", err)
			}
			remote.DeliverGroupRoom(context.Background(), remoteChange)

			for name, client := range map[string]*recordingClient{"owner": owner, "removed": removed} {
				if len(client.events) != 1 || client.events[0].(serverEvent).Type != "group.call.ended" {
					t.Errorf("%s terminal events = %#v", name, client.events)
					continue
				}
				payload, err := json.Marshal(client.events[0].(serverEvent).Payload)
				if err != nil {
					t.Errorf("marshal %s payload: %v", name, err)
					continue
				}
				var fields map[string]json.RawMessage
				_ = json.Unmarshal(payload, &fields)
				wantMinimal := deleted || name == "removed"
				_, hasConversation := fields["conversation_id"]
				if hasConversation == wantMinimal {
					t.Errorf("%s payload authorization mismatch (deleted=%v): %s", name, deleted, payload)
				}
				if wantMinimal && len(fields) != 4 {
					t.Errorf("%s minimal payload has unexpected fields: %s", name, payload)
				}
			}
			if len(sibling.events) != 0 {
				t.Errorf("nonparticipant sibling received terminal event: %#v", sibling.events)
			}
		})
	}
}

func TestOutOfOrderGroupProjectionRevalidatesCurrentRecipientMembership(t *testing.T) {
	ownerID, removedID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	room := GroupRoom{ID: roomID, ConversationID: conversationID, MembershipRevision: 1, Generation: 4, StateRevision: 8, Status: GroupRoomEnded, Participants: []GroupParticipant{
		{UserID: ownerID, DeviceID: "owner", ConnectionID: "owner-socket"},
		{UserID: removedID, DeviceID: "removed", ConnectionID: "removed-socket"},
	}}
	// This is the earlier terminal projection (revision 2), delivered after a
	// committed removal at revision 3. The historical projection included both
	// participants, but only the owner remains active now.
	change := GroupRoomChange{Type: "ended", Room: room, ParticipantConnectionIDs: groupParticipantConnectionIDs(room), MembershipProjectionRevision: 2}
	authorizer := currentProjectionAuthorizer{revision: 3, activeUserIDs: map[uuid.UUID]bool{ownerID: true}}
	hub := NewHubWithGroupCallAuthorizer(nil, &groupTestPresence{}, authorizer, &groupTestRooms{}, nil, nil, nil, nil, nil, nil)
	owner := &recordingClient{identity: sharedauth.Identity{UserID: ownerID, DeviceID: "owner"}, connectionID: "owner-socket"}
	removed := &recordingClient{identity: sharedauth.Identity{UserID: removedID, DeviceID: "removed"}, connectionID: "removed-socket"}
	hub.Add(context.Background(), owner)
	hub.Add(context.Background(), removed)
	owner.events, removed.events = nil, nil

	hub.DeliverGroupRoom(context.Background(), change)

	assertTerminalPayload := func(client *recordingClient, wantMinimal bool) {
		t.Helper()
		if len(client.events) != 1 {
			t.Fatalf("terminal events for %s = %#v", client.Identity().UserID, client.events)
		}
		payload, err := json.Marshal(client.events[0].(serverEvent).Payload)
		if err != nil {
			t.Fatalf("marshal terminal payload: %v", err)
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(payload, &fields); err != nil {
			t.Fatalf("decode terminal payload: %v", err)
		}
		_, fullRoster := fields["participants"]
		if fullRoster == wantMinimal || (wantMinimal && len(fields) != 4) {
			t.Errorf("payload minimal=%v, want %v: %s", !fullRoster, wantMinimal, payload)
		}
	}
	assertTerminalPayload(owner, false)
	assertTerminalPayload(removed, true)
}

func TestGroupRoomQueueAdmissionRevalidatesEveryRecipient(t *testing.T) {
	ownerID, activeID, removedID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	room := GroupRoom{ID: roomID, ConversationID: conversationID, MembershipRevision: 5, Generation: 2, StateRevision: 8, Status: GroupRoomActive, Participants: []GroupParticipant{
		{UserID: ownerID, DeviceID: "owner", ConnectionID: "owner-socket"},
		{UserID: activeID, DeviceID: "active", ConnectionID: "active-socket"},
		{UserID: removedID, DeviceID: "removed", ConnectionID: "removed-socket"},
	}, Presenter: &GroupParticipant{UserID: removedID, DeviceID: "removed", ConnectionID: "removed-socket"}}
	authorizer := currentProjectionAuthorizer{revision: 5, activeUserIDs: map[uuid.UUID]bool{ownerID: true, activeID: true}}
	hub := NewHubWithGroupCallAuthorizer(nil, &groupTestPresence{}, authorizer, &groupTestRooms{}, nil, nil, nil, nil, nil, nil)
	clients := []*recordingClient{
		{identity: sharedauth.Identity{UserID: ownerID, DeviceID: "owner"}, connectionID: "owner-socket"},
		{identity: sharedauth.Identity{UserID: activeID, DeviceID: "active"}, connectionID: "active-socket"},
		{identity: sharedauth.Identity{UserID: removedID, DeviceID: "removed"}, connectionID: "removed-socket"},
	}
	for _, client := range clients {
		hub.Add(context.Background(), client)
		client.events = nil
	}
	change := GroupRoomChange{Type: "participant.joined", Room: room, ParticipantConnectionIDs: groupParticipantConnectionIDs(room), RecipientUserIDs: []uuid.UUID{ownerID, activeID, removedID}}
	hub.deliverGroupRoomLockedContext(context.Background(), change)
	for _, client := range clients[:2] {
		if len(client.events) != 1 {
			t.Fatalf("active recipient %s events = %#v", client.Identity().UserID, client.events)
		}
		payload, _ := json.Marshal(client.events[0].(serverEvent).Payload)
		var got struct {
			Participants []GroupParticipant `json:"participants"`
			Presenter    *GroupParticipant  `json:"presenter"`
		}
		if err := json.Unmarshal(payload, &got); err != nil {
			t.Fatal(err)
		}
		if len(got.Participants) != 2 || got.Presenter != nil {
			t.Errorf("removed member leaked in active recipient roster: %s", payload)
		}
	}
	if len(clients[2].events) != 0 {
		t.Fatalf("revoked recipient got queued full payload: %#v", clients[2].events)
	}

	// Even an active recipient gets no historical event if its room revision is stale.
	clients[0].events = nil
	stale := change
	stale.Room.MembershipRevision = 4
	hub.deliverGroupRoomLockedContext(context.Background(), stale)
	if len(clients[0].events) != 0 {
		t.Fatalf("stale nonterminal event was queued: %#v", clients[0].events)
	}
}

func TestDeletedGroupProjectionSendsMinimalTerminalPayloadToEveryone(t *testing.T) {
	ownerID, removedID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	room := GroupRoom{ID: roomID, ConversationID: conversationID, MembershipRevision: 1, Generation: 1, StateRevision: 2, Status: GroupRoomEnded, Participants: []GroupParticipant{
		{UserID: ownerID, DeviceID: "owner", ConnectionID: "owner-socket"},
		{UserID: removedID, DeviceID: "removed", ConnectionID: "removed-socket"},
	}}
	hub := NewHubWithGroupCallAuthorizer(nil, &groupTestPresence{}, currentProjectionAuthorizer{revision: 2, activeUserIDs: map[uuid.UUID]bool{ownerID: true, removedID: true}}, &groupTestRooms{}, nil, nil, nil, nil, nil, nil)
	clients := []*recordingClient{
		{identity: sharedauth.Identity{UserID: ownerID, DeviceID: "owner"}, connectionID: "owner-socket"},
		{identity: sharedauth.Identity{UserID: removedID, DeviceID: "removed"}, connectionID: "removed-socket"},
	}
	for _, client := range clients {
		hub.Add(context.Background(), client)
		client.events = nil
	}
	hub.DeliverGroupRoom(context.Background(), GroupRoomChange{Type: "ended", Room: room, ParticipantConnectionIDs: groupParticipantConnectionIDs(room), MembershipProjectionRevision: 2, MembershipProjectionDeleted: true})
	for _, client := range clients {
		if len(client.events) != 1 {
			t.Fatalf("terminal events = %#v", client.events)
		}
		payload, _ := json.Marshal(client.events[0].(serverEvent).Payload)
		var fields map[string]json.RawMessage
		_ = json.Unmarshal(payload, &fields)
		if len(fields) != 4 {
			t.Errorf("deleted group sent non-minimal payload: %s", payload)
		}
	}
}

type currentProjectionAuthorizer struct {
	revision      int64
	activeUserIDs map[uuid.UUID]bool
}

func (a currentProjectionAuthorizer) BeginGroupCall(_ context.Context, _ uuid.UUID, userID uuid.UUID) (GroupCallLease, error) {
	if !a.activeUserIDs[userID] {
		return nil, ErrCallNotAllowed
	}
	memberIDs := make([]uuid.UUID, 0, len(a.activeUserIDs))
	for activeUserID, active := range a.activeUserIDs {
		if active {
			memberIDs = append(memberIDs, activeUserID)
		}
	}
	return &trackedGroupCallLease{revision: a.revision, members: memberIDs}, nil
}

func (a currentProjectionAuthorizer) GroupMembershipRevision(context.Context, uuid.UUID) (int64, error) {
	return a.revision, nil
}

func TestRemoteGroupProjectionRejectsStaleSignalsAndUnverifiedRemoval(t *testing.T) {
	ownerID, memberID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	room := GroupRoom{ID: roomID, ConversationID: conversationID, MembershipRevision: 2, Generation: 1, Status: GroupRoomActive, Participants: []GroupParticipant{
		{UserID: ownerID, DeviceID: "owner", ConnectionID: "owner-socket"},
		{UserID: memberID, DeviceID: "member", ConnectionID: "member-socket"},
	}}
	remote := NewHubWithGroupCallAuthorizer(nil, &groupTestPresence{}, inactiveProjectionAuthorizer{revision: 2}, &groupTestRooms{}, nil, nil, nil, nil, nil, nil)
	member := &recordingClient{identity: sharedauth.Identity{UserID: memberID, DeviceID: "member"}, connectionID: "member-socket"}
	remote.Add(context.Background(), member)
	member.events = nil
	connections := groupParticipantConnectionIDs(room)

	remote.DeliverGroupRoom(context.Background(), GroupRoomChange{Type: "signal", Room: room, ParticipantConnectionIDs: connections, ToUserID: memberID, ToDeviceID: "member", Signal: json.RawMessage(`{"type":"offer","sdp":"safe"}`)})
	remote.DeliverGroupRoom(context.Background(), GroupRoomChange{Type: "ended", Room: room, ParticipantConnectionIDs: connections, MembershipProjectionRevision: 3})
	if len(member.events) != 0 {
		t.Fatalf("stale or unverified group events delivered: %#v", member.events)
	}
}

func TestEndedRoomUsesMinimalPayloadForSocketWhoseMembershipWasRevoked(t *testing.T) {
	userID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New()
	client := &recordingClient{identity: sharedauth.Identity{UserID: userID, DeviceID: "member"}, connectionID: "member-socket"}
	room := GroupRoom{ID: roomID, ConversationID: conversationID, MembershipRevision: 1, Generation: 3, Status: GroupRoomEnded, StateRevision: 9, Participants: []GroupParticipant{{UserID: userID, DeviceID: "member", ConnectionID: "member-socket"}}}
	hub := NewHubWithGroupCallAuthorizer(nil, &groupTestPresence{}, inactiveProjectionAuthorizer{revision: 2}, &groupTestRooms{}, nil, nil, nil, nil, nil, nil)
	hub.Add(context.Background(), client)
	client.events = nil

	hub.deliverGroupRoomLockedContext(context.Background(), GroupRoomChange{Type: "ended", Room: room, ParticipantConnectionIDs: groupParticipantConnectionIDs(room)})

	if len(client.events) != 1 || client.events[0].(serverEvent).Type != "group.call.ended" {
		t.Fatalf("terminal events = %#v", client.events)
	}
	payload, err := json.Marshal(client.events[0].(serverEvent).Payload)
	if err != nil {
		t.Fatalf("marshal terminal payload: %v", err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(payload, &fields); err != nil {
		t.Fatalf("decode terminal payload: %v", err)
	}
	if len(fields) != 4 {
		t.Fatalf("revoked socket received %d terminal fields, want exactly 4", len(fields))
	}
	for _, field := range []string{"room_id", "generation", "status", "state_revision"} {
		if _, ok := fields[field]; !ok {
			t.Errorf("minimal terminal payload is missing %q", field)
		}
	}
}

func TestOlderMembershipProjectionFiltersTerminalRosterButStillRoutesRemovedPeer(t *testing.T) {
	userU, userV, conversationID, roomID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	room := GroupRoom{
		ID: roomID, ConversationID: conversationID, MembershipRevision: 1,
		Generation: 4, StateRevision: 8, Status: GroupRoomEnded,
		Participants: []GroupParticipant{
			{UserID: userU, DeviceID: "u-device", ConnectionID: "u-socket"},
			{UserID: userV, DeviceID: "v-device", ConnectionID: "v-socket"},
		},
		Presenter: &GroupParticipant{UserID: userV, DeviceID: "v-device", ConnectionID: "v-socket"},
	}
	hub := NewHubWithGroupCallAuthorizer(nil, &groupTestPresence{}, currentProjectionAuthorizer{
		revision: 2, activeUserIDs: map[uuid.UUID]bool{userU: true},
	}, &groupTestRooms{}, nil, nil, nil, nil, nil, nil)
	user := &recordingClient{identity: sharedauth.Identity{UserID: userU, DeviceID: "u-device"}, connectionID: "u-socket"}
	removed := &recordingClient{identity: sharedauth.Identity{UserID: userV, DeviceID: "v-device"}, connectionID: "v-socket"}
	for _, client := range []*recordingClient{user, removed} {
		hub.Add(context.Background(), client)
		client.events = nil
	}

	hub.DeliverGroupRoom(context.Background(), GroupRoomChange{
		Type: "ended", Room: room, ParticipantConnectionIDs: groupParticipantConnectionIDs(room),
		MembershipProjectionRevision: 2,
	})

	if len(user.events) != 1 || len(removed.events) != 1 {
		t.Fatalf("terminal events: U=%#v V=%#v; expected routing to both historical sockets", user.events, removed.events)
	}
	fullPayload, err := json.Marshal(user.events[0].(serverEvent).Payload)
	if err != nil {
		t.Fatalf("marshal U terminal payload: %v", err)
	}
	var full struct {
		Participants []GroupParticipant `json:"participants"`
		Presenter    *GroupParticipant  `json:"presenter"`
	}
	if err := json.Unmarshal(fullPayload, &full); err != nil {
		t.Fatalf("decode U terminal payload: %v", err)
	}
	if len(full.Participants) != 1 || full.Participants[0].UserID != userU {
		t.Fatalf("U terminal roster = %#v, want only active user U", full.Participants)
	}
	if full.Presenter != nil {
		t.Fatalf("removed presenter leaked in U terminal payload: %#v", full.Presenter)
	}
	minimalPayload, err := json.Marshal(removed.events[0].(serverEvent).Payload)
	if err != nil {
		t.Fatalf("marshal V terminal payload: %v", err)
	}
	var minimalFields map[string]json.RawMessage
	if err := json.Unmarshal(minimalPayload, &minimalFields); err != nil {
		t.Fatalf("decode V terminal payload: %v", err)
	}
	if len(minimalFields) != 4 {
		t.Fatalf("removed V received non-minimal terminal payload: %s", minimalPayload)
	}
}

type inactiveProjectionAuthorizer struct{ revision int64 }

func (inactiveProjectionAuthorizer) BeginGroupCall(context.Context, uuid.UUID, uuid.UUID) (GroupCallLease, error) {
	return nil, ErrCallNotAllowed
}

func (a inactiveProjectionAuthorizer) GroupMembershipRevision(context.Context, uuid.UUID) (int64, error) {
	return a.revision, nil
}

func TestHubRetriesGroupProjectionWhenRoomTerminationFails(t *testing.T) {
	conversationID := uuid.New()
	cleanupErr := errors.New("redis temporarily unavailable")
	rooms := &failingGroupTerminationCoordinator{
		groupTestRooms: groupTestRooms{room: GroupRoom{ID: uuid.New(), ConversationID: conversationID, Status: GroupRoomActive}},
		endErr:         cleanupErr,
	}
	hub := NewHub(nil, &groupTestPresence{}, rooms, nil, nil, nil, nil)

	err := hub.NotifyGroupProjection(context.Background(), conversationID, 3, false, nil)

	if !errors.Is(err, cleanupErr) {
		t.Fatalf("membership projection error = %v, want cleanup error", err)
	}
	if rooms.projections != 0 {
		t.Fatalf("published %d projections before room cleanup succeeded", rooms.projections)
	}
}

func TestHubAllowsGroupProjectionWhenNoActiveRoomExists(t *testing.T) {
	conversationID := uuid.New()
	rooms := &failingGroupTerminationCoordinator{getErr: ErrCallNotFound}
	hub := NewHub(nil, &groupTestPresence{}, rooms, nil, nil, nil, nil)

	if err := hub.NotifyGroupProjection(context.Background(), conversationID, 3, false, nil); err != nil {
		t.Fatalf("notify projection without a live room: %v", err)
	}
	if rooms.projections != 1 {
		t.Fatalf("published projections = %d, want 1", rooms.projections)
	}
}

func TestHubCanceledGroupProjectionReleasesConversationStripe(t *testing.T) {
	conversationID := uuid.New()
	rooms := &cancelingProjectionRooms{groupTestRooms: &groupTestRooms{}, entered: make(chan struct{})}
	hub := NewHub(nil, &groupTestPresence{}, rooms, nil, nil, nil, nil)
	ctx, cancel := context.WithCancel(context.Background())
	firstDone := make(chan error, 1)
	go func() {
		firstDone <- hub.NotifyGroupProjection(ctx, conversationID, 3, false, nil)
	}()
	<-rooms.entered
	cancel()
	if err := <-firstDone; !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled projection error = %v, want context.Canceled", err)
	}

	secondDone := make(chan error, 1)
	go func() {
		secondDone <- hub.NotifyGroupProjection(context.Background(), conversationID, 3, false, nil)
	}()
	select {
	case err := <-secondDone:
		if err != nil {
			t.Fatalf("projection after cancellation: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("conversation stripe remained locked after canceled projection")
	}
}

type cancelingProjectionRooms struct {
	*groupTestRooms
	entered chan struct{}
	first   bool
}

func (r *cancelingProjectionRooms) GetGroupRoomForConversation(ctx context.Context, _ uuid.UUID) (GroupRoom, error) {
	if !r.first {
		r.first = true
		close(r.entered)
		<-ctx.Done()
		return GroupRoom{}, ctx.Err()
	}
	return GroupRoom{}, ErrCallNotFound
}

func TestHubNotifiesExpiredGroupRoomParticipants(t *testing.T) {
	memberID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New()
	logger := &groupRoomLogCapture{}
	hub := NewHubWithLogger(nil, &groupTestPresence{}, &groupTestRooms{}, nil, nil, nil, nil, logger)
	member := &recordingClient{identity: sharedauth.Identity{UserID: memberID, DeviceID: "member"}, connectionID: "member-socket"}
	hub.Add(context.Background(), member)
	member.events = nil

	hub.NotifyExpiredGroupRooms(context.Background(), []GroupRoom{{ID: roomID, ConversationID: conversationID, Status: GroupRoomActive, Participants: []GroupParticipant{{UserID: memberID, DeviceID: "member", ConnectionID: "member-socket"}}}})
	if len(member.events) != 1 {
		t.Fatalf("member events = %#v", member.events)
	}
	event, ok := member.events[0].(serverEvent)
	if !ok || event.Type != "group.call.ended" {
		t.Fatalf("expired terminal event = %#v", member.events[0])
	}
	if logger.message != "group call expiry terminal event fan-out attempted" || logger.attributes["event"] != "group.call.ended" || logger.attributes["source"] != "expiry_sweep" || logger.attributes["outcome"] != "attempted" || logger.attributes["call_id"] != roomID || logger.attributes["conversation_id"] != conversationID {
		t.Fatalf("expiry diagnostics = (%q, %#v), want attempted terminal event source and identifiers", logger.message, logger.attributes)
	}
}

func TestHubExpiredGroupRoomLockFailureIsObservable(t *testing.T) {
	conversationID, roomID := uuid.New(), uuid.New()
	logger := &groupRoomLogCapture{}
	hub := NewHubWithLogger(nil, &groupTestPresence{}, &groupTestRooms{}, nil, nil, nil, nil, logger)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	hub.NotifyExpiredGroupRooms(ctx, []GroupRoom{{ID: roomID, ConversationID: conversationID, Status: GroupRoomActive}})
	if logger.warningMessage != "group call event delivery failed" || logger.warningAttributes["stage"] != "lock" || logger.warningAttributes["source"] != "expiry_sweep" || logger.warningAttributes["event"] != "ended" || logger.warningAttributes["room_id"] != roomID || logger.warningAttributes["conversation_id"] != conversationID {
		t.Fatalf("lock failure diagnostics = (%q, %#v), want bounded room/conversation identifiers and source", logger.warningMessage, logger.warningAttributes)
	}
}

func TestHubRemoveLogsGroupRoomDisconnectOutcome(t *testing.T) {
	for _, test := range []struct {
		name        string
		status      string
		wantOutcome string
	}{
		{name: "remaining active room", status: GroupRoomActive, wantOutcome: "participant_removed"},
		{name: "terminal room", status: GroupRoomEnded, wantOutcome: "room_ended"},
	} {
		t.Run(test.name, func(t *testing.T) {
			userID, roomID, conversationID, supportRef := uuid.New(), uuid.New(), uuid.New(), uuid.New()
			client := &recordingClient{identity: sharedauth.Identity{UserID: userID, DeviceID: "device"}, connectionID: "socket"}
			rooms := &disconnectGroupRooms{groupTestRooms: groupTestRooms{}, changed: []GroupRoom{{
				ID: roomID, SupportRef: supportRef, ConversationID: conversationID, Status: test.status,
				Participants: []GroupParticipant{{UserID: userID, DeviceID: "device", ConnectionID: "socket"}},
			}}}
			logger := &groupRoomLogCapture{}
			hub := NewHubWithLogger(nil, nil, rooms, nil, nil, nil, nil, logger)
			hub.Add(context.Background(), client)

			hub.Remove(context.Background(), client)

			if _, claimsEvent := logger.attributes["event"]; claimsEvent || logger.attributes["outcome"] != test.wantOutcome || logger.message != "group call room cleanup after websocket disconnect" {
				t.Fatalf("disconnect diagnostics = (%q, %#v), want cleanup outcome=%q without event claim", logger.message, logger.attributes, test.wantOutcome)
			}
			if logger.attributes["support_ref"] != supportRef || logger.attributes["room_status"] != test.status {
				t.Fatalf("disconnect correlation/status = %#v, want support_ref=%s status=%s", logger.attributes, supportRef, test.status)
			}
			if logger.attributes["call_id"] != roomID || logger.attributes["conversation_id"] != conversationID {
				t.Fatalf("disconnect identifiers = %#v", logger.attributes)
			}
		})
	}
}

type disconnectGroupRooms struct {
	groupTestRooms
	changed []GroupRoom
}

func (r *disconnectGroupRooms) RemoveGroupConnection(context.Context, uuid.UUID, string, string) ([]GroupRoom, error) {
	return r.changed, nil
}

type groupRoomLogCapture struct {
	message           string
	attributes        map[string]any
	warningMessage    string
	warningAttributes map[string]any
}

func (l *groupRoomLogCapture) InfoContext(_ context.Context, message string, args ...any) {
	l.message = message
	l.attributes = make(map[string]any, len(args)/2)
	for index := 0; index+1 < len(args); index += 2 {
		key, ok := args[index].(string)
		if ok {
			l.attributes[key] = args[index+1]
		}
	}
}

func (l *groupRoomLogCapture) WarnContext(_ context.Context, message string, args ...any) {
	l.warningMessage = message
	l.warningAttributes = make(map[string]any, len(args)/2)
	for index := 0; index+1 < len(args); index += 2 {
		key, ok := args[index].(string)
		if ok {
			l.warningAttributes[key] = args[index+1]
		}
	}
}

func TestHubGroupSignalUsesSignalRateBudget(t *testing.T) {
	userID, targetID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	rooms := &groupSignalRateRooms{}
	hub := NewHub(nil, &groupTestPresence{revision: 2}, rooms, nil, nil, nil, nil)
	err := hub.HandleVersion(context.Background(), &recordingClient{identity: sharedauth.Identity{UserID: userID, DeviceID: "device"}, connectionID: "socket"}, 3, []byte(`{"version":3,"type":"group.call.signal","request_id":"signal-1","payload":{"conversation_id":"`+conversationID.String()+`","room_id":"`+roomID.String()+`","generation":1,"target_user_id":"`+targetID.String()+`","target_device_id":"target","signal":{"type":"offer","sdp":"safe","negotiation_id":"8c72dd14-fafe-4e2d-9735-e09c37358bf1"}}}`))
	if err == nil || err.Error() != "call rate limit exceeded" {
		t.Fatalf("signal error = %v", err)
	}
	if rooms.callChecks != 0 || rooms.signalChecks != 1 {
		t.Fatalf("rate checks call=%d signal=%d", rooms.callChecks, rooms.signalChecks)
	}
}

func TestGroupCallOperationDeadlineCoversRateAuthorizationRoomMutationAndFanout(t *testing.T) {
	userID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New()
	rooms := &boundedGroupCallRooms{groupTestRooms: groupTestRooms{room: GroupRoom{
		ID: roomID, ConversationID: conversationID, MembershipRevision: 2, Generation: 1, Status: GroupRoomActive,
		Participants: []GroupParticipant{{UserID: userID, DeviceID: "device", ConnectionID: "socket"}},
	}}}
	presence := &boundedGroupCallPresence{groupTestPresence: groupTestPresence{revision: 2}}
	limiter := &boundedGroupCallLimiter{}
	hub := NewHub(nil, presence, limiterWithRooms{boundedGroupCallLimiter: limiter, GroupRoomCoordinator: rooms, PresenceCoordinator: rooms}, nil, nil, nil, nil)
	client := &recordingClient{identity: sharedauth.Identity{UserID: userID, DeviceID: "device"}, connectionID: "socket"}

	err := hub.HandleVersion(context.Background(), client, 3, []byte(`{"version":3,"type":"group.call.join","request_id":"bounded","payload":{"conversation_id":"`+conversationID.String()+`","room_id":"`+roomID.String()+`","generation":1}}`))
	if err != nil {
		t.Fatalf("join group room: %v", err)
	}
	if !limiter.deadlineSeen || !presence.deadlineSeen || !rooms.allDeadlinesSeen() {
		t.Fatalf("operation deadline was not propagated: limiter=%v membership=%v room calls=%v", limiter.deadlineSeen, presence.deadlineSeen, rooms.deadlineCalls)
	}
}

func TestGroupCallCancellationDuringMembershipDoesNotReadOrMutateRoom(t *testing.T) {
	userID, conversationID, roomID := uuid.New(), uuid.New(), uuid.New()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rooms := &boundedGroupCallRooms{groupTestRooms: groupTestRooms{room: GroupRoom{
		ID: roomID, ConversationID: conversationID, MembershipRevision: 2, Generation: 1, Status: GroupRoomActive,
		Participants: []GroupParticipant{{UserID: userID, DeviceID: "device", ConnectionID: "socket"}},
	}}}
	presence := &boundedGroupCallPresence{groupTestPresence: groupTestPresence{revision: 2}, cancel: cancel}
	limiter := &boundedGroupCallLimiter{}
	hub := NewHub(nil, presence, limiterWithRooms{boundedGroupCallLimiter: limiter, GroupRoomCoordinator: rooms, PresenceCoordinator: rooms}, nil, nil, nil, nil)
	client := &recordingClient{identity: sharedauth.Identity{UserID: userID, DeviceID: "device"}, connectionID: "socket"}

	err := hub.HandleVersion(ctx, client, 3, []byte(`{"version":3,"type":"group.call.join","request_id":"cancel-membership","payload":{"conversation_id":"`+conversationID.String()+`","room_id":"`+roomID.String()+`","generation":1}}`))
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("join error = %v, want canceled context", err)
	}
	if len(rooms.deadlineCalls) != 0 || rooms.mutationCalls != 0 {
		t.Fatalf("room operations after cancellation: calls=%v mutations=%d", rooms.deadlineCalls, rooms.mutationCalls)
	}
}

type boundedGroupCallLimiter struct{ deadlineSeen bool }

func (l *boundedGroupCallLimiter) AllowCall(ctx context.Context, _ uuid.UUID) (bool, error) {
	_, l.deadlineSeen = ctx.Deadline()
	return true, ctx.Err()
}
func (l *boundedGroupCallLimiter) AllowSignal(context.Context, uuid.UUID) (bool, error) {
	return true, nil
}
func (l *boundedGroupCallLimiter) AllowPresenceRefresh(context.Context, uuid.UUID) (bool, error) {
	return true, nil
}
func (l *boundedGroupCallLimiter) AllowRead(context.Context, uuid.UUID) (bool, error) {
	return true, nil
}

type limiterWithRooms struct {
	*boundedGroupCallLimiter
	GroupRoomCoordinator
	PresenceCoordinator
}

func (limiterWithRooms) AcquireCallAdmission(ctx context.Context, users []uuid.UUID) (string, error) {
	return "admission", nil
}
func (limiterWithRooms) ReleaseCallAdmission(context.Context, []uuid.UUID, string) {}

type boundedGroupCallPresence struct {
	groupTestPresence
	deadlineSeen bool
	cancel       context.CancelFunc
}

func (p *boundedGroupCallPresence) BeginGroupCall(ctx context.Context, _, _ uuid.UUID) (GroupCallLease, error) {
	_, p.deadlineSeen = ctx.Deadline()
	if p.cancel != nil {
		p.cancel()
	}
	return groupTestStartLease{revision: p.revision, memberIDs: p.memberIDs}, ctx.Err()
}

type boundedGroupCallRooms struct {
	groupTestRooms
	deadlineCalls []string
}

func (r *boundedGroupCallRooms) recordDeadline(name string, ctx context.Context) {
	if _, ok := ctx.Deadline(); ok {
		r.deadlineCalls = append(r.deadlineCalls, name)
	}
}
func (r *boundedGroupCallRooms) allDeadlinesSeen() bool {
	return equalStrings(r.deadlineCalls, []string{"get", "join", "publish"})
}
func (r *boundedGroupCallRooms) GetGroupRoom(ctx context.Context, id uuid.UUID) (GroupRoom, error) {
	r.recordDeadline("get", ctx)
	return r.groupTestRooms.GetGroupRoom(ctx, id)
}
func (r *boundedGroupCallRooms) JoinGroupRoom(ctx context.Context, id uuid.UUID, participant GroupParticipant, revision int64, token string) (GroupRoom, error) {
	r.recordDeadline("join", ctx)
	return r.groupTestRooms.JoinGroupRoom(ctx, id, participant, revision, token)
}
func (r *boundedGroupCallRooms) PublishGroupRoom(ctx context.Context, change GroupRoomChange) error {
	r.recordDeadline("publish", ctx)
	return nil
}

type groupTestPresence struct {
	revision  int64
	memberIDs []uuid.UUID
}

func (*groupTestPresence) PeerIDs(context.Context, uuid.UUID) ([]uuid.UUID, error) { return nil, nil }
func (*groupTestPresence) RecipientID(context.Context, uuid.UUID, uuid.UUID) (uuid.UUID, error) {
	return uuid.Nil, nil
}
func (p *groupTestPresence) BeginGroupCall(context.Context, uuid.UUID, uuid.UUID) (GroupCallLease, error) {
	return groupTestStartLease{revision: p.revision, memberIDs: p.memberIDs}, nil
}

type groupTestStartLease struct {
	revision  int64
	memberIDs []uuid.UUID
}

func (l groupTestStartLease) MembershipRevision() int64    { return l.revision }
func (l groupTestStartLease) ActiveMemberIDs() []uuid.UUID { return l.memberIDs }
func (groupTestStartLease) Commit(context.Context) error   { return nil }
func (groupTestStartLease) Rollback(context.Context) error { return nil }

type groupTestRooms struct {
	room          GroupRoom
	published     []GroupRoomChange
	mutationCalls int
	newerRoom     GroupRoom
	abortedRoom   uuid.UUID
	abortCalls    int
}

type groupCoordinatorWithoutRateLimit struct {
	GroupRoomCoordinator
	PresenceCoordinator
}

type discoveryAuthorizer struct {
	*groupTestPresence
	revision   int64
	memberIDs  []uuid.UUID
	err        error
	rolledBack bool
}

func (a *discoveryAuthorizer) BeginGroupCall(context.Context, uuid.UUID, uuid.UUID) (GroupCallLease, error) {
	if a.err != nil {
		return nil, a.err
	}
	return &discoveryLease{authorizer: a, revision: a.revision, memberIDs: a.memberIDs}, nil
}

type discoveryLease struct {
	authorizer *discoveryAuthorizer
	revision   int64
	memberIDs  []uuid.UUID
}

func (l *discoveryLease) MembershipRevision() int64 { return l.revision }
func (l *discoveryLease) ActiveMemberIDs() []uuid.UUID {
	return append([]uuid.UUID(nil), l.memberIDs...)
}
func (*discoveryLease) Commit(context.Context) error { return nil }
func (l *discoveryLease) Rollback(context.Context) error {
	l.authorizer.rolledBack = true
	return nil
}

type discoveryGroupRooms struct {
	groupTestRooms
	getErr              error
	getCalls            int
	endCalls            int
	waitForCancellation bool
	entered             chan struct{}
	rateLimited         bool
}

func (*discoveryGroupRooms) AllowPresenceRefresh(context.Context, uuid.UUID) (bool, error) {
	return true, nil
}
func (*discoveryGroupRooms) AllowRead(context.Context, uuid.UUID) (bool, error) { return true, nil }
func (r *discoveryGroupRooms) AllowCall(context.Context, uuid.UUID) (bool, error) {
	return !r.rateLimited, nil
}
func (*discoveryGroupRooms) AllowSignal(context.Context, uuid.UUID) (bool, error) { return true, nil }

func (r *discoveryGroupRooms) GetGroupRoomForConversation(ctx context.Context, _ uuid.UUID) (GroupRoom, error) {
	r.getCalls++
	if r.waitForCancellation {
		if r.entered != nil {
			close(r.entered)
		}
		<-ctx.Done()
		return GroupRoom{}, ctx.Err()
	}
	return r.room, r.getErr
}

func (r *discoveryGroupRooms) EndGroupRoomForMembershipChange(_ context.Context, _, roomID uuid.UUID, generation, stateRevision, _ int64) (GroupRoom, error) {
	r.endCalls++
	if r.room.ID != roomID || r.room.Generation != generation || r.room.StateRevision != stateRevision {
		return GroupRoom{}, ErrCallNotAllowed
	}
	r.room.Status = GroupRoomEnded
	return r.room, nil
}

type failingGroupTerminationCoordinator struct {
	groupTestRooms
	getErr      error
	endErr      error
	projections int
}

func (r *failingGroupTerminationCoordinator) GetGroupRoomForConversation(context.Context, uuid.UUID) (GroupRoom, error) {
	return r.room, r.getErr
}

func (r *failingGroupTerminationCoordinator) EndGroupRoomForMembershipChange(context.Context, uuid.UUID, uuid.UUID, int64, int64, int64) (GroupRoom, error) {
	return GroupRoom{}, r.endErr
}

func (r *failingGroupTerminationCoordinator) PublishGroupProjection(context.Context, uuid.UUID, int64, bool, []uuid.UUID) error {
	r.projections++
	return nil
}

func (r *groupTestRooms) AcquireCallAdmission(context.Context, []uuid.UUID) (string, error) {
	return uuid.NewString(), nil
}
func (r *groupTestRooms) ReleaseCallAdmission(context.Context, []uuid.UUID, string) {}

func (r *groupTestRooms) Connect(context.Context, uuid.UUID, string) (bool, error) { return false, nil }
func (r *groupTestRooms) Disconnect(context.Context, uuid.UUID, string) (bool, error) {
	return false, nil
}
func (*groupTestRooms) Online(context.Context, []uuid.UUID) (map[uuid.UUID]bool, error) {
	return nil, nil
}
func (*groupTestRooms) Publish(context.Context, uuid.UUID, bool) error { return nil }
func (*groupTestRooms) AllowPresenceRefresh(context.Context, uuid.UUID) (bool, error) {
	return true, nil
}
func (*groupTestRooms) AllowRead(context.Context, uuid.UUID) (bool, error)   { return true, nil }
func (*groupTestRooms) AllowCall(context.Context, uuid.UUID) (bool, error)   { return true, nil }
func (*groupTestRooms) AllowSignal(context.Context, uuid.UUID) (bool, error) { return true, nil }
func (r *groupTestRooms) StartGroupRoom(_ context.Context, room GroupRoom, _ string) (GroupRoom, error) {
	room.Status = GroupRoomRinging
	room.RingExpiresAt = time.Now().Add(30 * time.Second)
	room.ExpiresAt = room.RingExpiresAt.Add(2 * time.Hour)
	r.room = room
	return room, nil
}

func (r *groupTestRooms) PrepareGroupRoomStart(context.Context, uuid.UUID, GroupParticipant) (uuid.UUID, time.Time, error) {
	return uuid.New(), time.Now().Add(time.Minute), nil
}

func (r *groupTestRooms) StartPreparedGroupRoom(ctx context.Context, room GroupRoom, token string, _ uuid.UUID) (GroupRoom, error) {
	return r.StartGroupRoom(ctx, room, token)
}

func (r *groupTestRooms) CancelGroupRoomStart(context.Context, uuid.UUID, GroupParticipant, uuid.UUID) (GroupRoom, string, error) {
	return GroupRoom{}, "confirmed", nil
}
func (r *groupTestRooms) JoinGroupRoom(context.Context, uuid.UUID, GroupParticipant, int64, string) (GroupRoom, error) {
	r.mutationCalls++
	return r.room, nil
}
func (r *groupTestRooms) LeaveGroupRoom(context.Context, uuid.UUID, GroupParticipant) (GroupRoom, error) {
	r.mutationCalls++
	return r.room, nil
}
func (r *groupTestRooms) EndGroupRoom(context.Context, uuid.UUID, GroupParticipant) (GroupRoom, error) {
	r.mutationCalls++
	room := r.room
	room.Status = GroupRoomEnded
	room.StateRevision++
	room.Participants = nil
	return room, nil
}
func (r *groupTestRooms) AbortGroupRoomStart(_ context.Context, roomID uuid.UUID, generation int64, owner GroupParticipant) error {
	r.abortCalls++
	r.abortedRoom = roomID
	if r.room.ID != roomID || r.room.Generation != generation || len(r.room.Participants) == 0 || r.room.Participants[0] != owner {
		return nil // stale compensation is a safe no-op
	}
	r.room.Status = GroupRoomEnded
	r.room.Participants = nil
	return nil
}
func (r *groupTestRooms) GetGroupRoom(context.Context, uuid.UUID) (GroupRoom, error) {
	return r.room, nil
}
func (r *groupTestRooms) GetGroupRoomForConversation(context.Context, uuid.UUID) (GroupRoom, error) {
	return r.room, nil
}
func (r *groupTestRooms) SetGroupPresenter(context.Context, uuid.UUID, GroupParticipant, bool) (GroupRoom, error) {
	r.mutationCalls++
	return r.room, nil
}
func (r *groupTestRooms) RemoveGroupConnection(context.Context, uuid.UUID, string, string) ([]GroupRoom, error) {
	return nil, nil
}
func (r *groupTestRooms) EndGroupRoomForMembershipChange(_ context.Context, conversationID, roomID uuid.UUID, generation, stateRevision, membershipRevision int64) (GroupRoom, error) {
	if r.room.ID != roomID || r.room.Generation != generation || r.room.StateRevision != stateRevision || r.room.MembershipRevision >= membershipRevision {
		return GroupRoom{}, ErrCallNotFound
	}
	room := r.room
	room.Status = GroupRoomEnded
	room.StateRevision++
	room.Participants = nil
	r.room = room
	return room, nil
}
func (*groupTestRooms) ExpireGroupRooms(context.Context, int) ([]GroupRoom, error) { return nil, nil }
func (r *groupTestRooms) PublishGroupRoom(_ context.Context, change GroupRoomChange) error {
	r.published = append(r.published, change)
	return nil
}

type groupSignalRateRooms struct {
	groupTestRooms
	callChecks   int
	signalChecks int
}

func (r *groupSignalRateRooms) AllowCall(context.Context, uuid.UUID) (bool, error) {
	r.callChecks++
	return true, nil
}
func (r *groupSignalRateRooms) AllowSignal(context.Context, uuid.UUID) (bool, error) {
	r.signalChecks++
	return false, nil
}
func (*groupSignalRateRooms) AllowPresenceRefresh(context.Context, uuid.UUID) (bool, error) {
	return true, nil
}
func (*groupSignalRateRooms) AllowRead(context.Context, uuid.UUID) (bool, error) { return true, nil }
