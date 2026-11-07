package postgres

import (
	"bytes"
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/KovalMax/zwei/services/realtime/internal/application"
	"github.com/KovalMax/zwei/services/realtime/internal/application/callpush"
	"github.com/KovalMax/zwei/services/shared/pushcrypto"
)

func TestCallPushResolveRechecksLiveStatePolicyAndAllCurrentSubscriptions(t *testing.T) {
	db, ctx := isolatedPushDB(t)
	if _, err := db.Exec(ctx, `CREATE TABLE users(id uuid PRIMARY KEY,display_name text NOT NULL,alert_mode text NOT NULL); CREATE TABLE devices(id uuid PRIMARY KEY,user_id uuid NOT NULL,revoked_at timestamptz); CREATE TABLE push_subscriptions(id uuid PRIMARY KEY,user_id uuid NOT NULL,device_id uuid NOT NULL,encryption_version text NOT NULL,encrypted_subscription bytea NOT NULL,endpoint_fingerprint bytea NOT NULL,vapid_key_id text,created_at timestamptz NOT NULL DEFAULT now());`); err != nil {
		t.Fatal(err)
	}
	callerID, recipientID, conversationID, callID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	expiresAt := time.Now().Add(20 * time.Second).UTC()
	call := application.Call{ID: callID, ConversationID: conversationID, CallerID: callerID, RecipientID: recipientID, Status: application.CallRinging, ExpiresAt: expiresAt}
	key := make([]byte, 32)
	fingerprint := make([]byte, 32)
	codec, err := pushcrypto.NewKeyring(map[string][]byte{"v1": key}, "v1", fingerprint)
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range []struct {
		id, device uuid.UUID
		endpoint   string
		keyID      string
	}{{uuid.New(), uuid.New(), "https://fcm.googleapis.com/a", "current"}, {uuid.New(), uuid.New(), "https://fcm.googleapis.com/b", "current"}, {uuid.New(), uuid.New(), "https://fcm.googleapis.com/c", "old"}} {
		version, encrypted, fingerprint, err := codec.Seal(pushcrypto.Subscription{Endpoint: row.endpoint, P256DH: "p256", Auth: "auth"})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(ctx, `INSERT INTO users(id,display_name,alert_mode) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING`, recipientID, "Recipient", "notifications"); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(ctx, `INSERT INTO users(id,display_name,alert_mode) VALUES($1,'Caller','off') ON CONFLICT(id) DO NOTHING`, callerID); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(ctx, `INSERT INTO devices(id,user_id) VALUES($1,$2)`, row.device, recipientID); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(ctx, `INSERT INTO push_subscriptions(id,user_id,device_id,encryption_version,encrypted_subscription,endpoint_fingerprint,vapid_key_id) VALUES($1,$2,$3,$4,$5,$6,$7)`, row.id, recipientID, row.device, version, encrypted, fingerprint, row.keyID); err != nil {
			t.Fatal(err)
		}
	}
	calls := &callPushCallFake{call: call}
	repo := NewCallPushRepository(db, codec, "current", calls, nil, nil)
	job := callpush.Job{CallID: callID, ConversationID: conversationID, StarterID: callerID, Recipients: []uuid.UUID{recipientID}, ExpiresAt: expiresAt}
	name, subscriptions, eligible, err := repo.Resolve(ctx, job, recipientID)
	if err != nil || !eligible || name != "Caller" || len(subscriptions) != 2 {
		t.Fatalf("eligible resolution name=%q subscriptions=%d eligible=%t err=%v", name, len(subscriptions), eligible, err)
	}
	stale := subscriptions[0]
	replacementEndpoint := "https://fcm.googleapis.com/replacement"
	replacementVersion, replacementCiphertext, replacementFingerprint, err := codec.Seal(pushcrypto.Subscription{Endpoint: replacementEndpoint, P256DH: "new-p256", Auth: "new-auth"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `UPDATE push_subscriptions SET encryption_version=$2,encrypted_subscription=$3,endpoint_fingerprint=$4 WHERE id=$1`, stale.ID, replacementVersion, replacementCiphertext, replacementFingerprint); err != nil {
		t.Fatal(err)
	}
	if err := repo.DeleteSubscription(ctx, stale.ID, stale.Fingerprint); err != nil {
		t.Fatal(err)
	}
	_, subscriptions, eligible, err = repo.Resolve(ctx, job, recipientID)
	if err != nil || !eligible || len(subscriptions) != 2 {
		t.Fatalf("stale provider response removed replacement subscription count=%d eligible=%t err=%v", len(subscriptions), eligible, err)
	}
	var replacementSurvived bool
	for _, sub := range subscriptions {
		if sub.ID == stale.ID && sub.Endpoint == replacementEndpoint && bytes.Equal(sub.Fingerprint, replacementFingerprint) {
			replacementSurvived = true
		}
	}
	if !replacementSurvived {
		t.Fatalf("call replacement subscription did not survive stale delete: %v", subscriptions)
	}
	if _, err := db.Exec(ctx, `UPDATE users SET alert_mode='sounds' WHERE id=$1`, recipientID); err != nil {
		t.Fatal(err)
	}
	if _, subscriptions, eligible, err = repo.Resolve(ctx, job, recipientID); err != nil || eligible || len(subscriptions) != 0 {
		t.Fatalf("suppressed resolution subscriptions=%d eligible=%t err=%v", len(subscriptions), eligible, err)
	}
	if _, err := db.Exec(ctx, `UPDATE users SET alert_mode='notifications' WHERE id=$1`, recipientID); err != nil {
		t.Fatal(err)
	}
	calls.call.Status = application.CallActive
	if _, _, eligible, err = repo.Resolve(ctx, job, recipientID); err != nil || eligible {
		t.Fatalf("accepted call eligible=%t err=%v", eligible, err)
	}
}

func TestCallPushGroupResolveUsesSingleConnectionAndFencesFetchedData(t *testing.T) {
	dsn := os.Getenv("ZWEI_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set ZWEI_TEST_DATABASE_URL to run PostgreSQL integration tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	admin, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	schema := "call_push_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	defer func() {
		cleanup, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		_, _ = admin.Exec(cleanup, "DROP SCHEMA IF EXISTS "+schema+" CASCADE")
	}()
	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	config.MaxConns = 1
	db, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(ctx, `CREATE TABLE users(id uuid PRIMARY KEY,display_name text NOT NULL,alert_mode text NOT NULL);
		CREATE TABLE devices(id uuid PRIMARY KEY,user_id uuid NOT NULL,revoked_at timestamptz);
		CREATE TABLE push_subscriptions(id uuid PRIMARY KEY,user_id uuid NOT NULL,device_id uuid NOT NULL,encryption_version text NOT NULL,encrypted_subscription bytea NOT NULL,endpoint_fingerprint bytea NOT NULL,vapid_key_id text,created_at timestamptz NOT NULL DEFAULT now());
		CREATE TABLE conversations(id uuid PRIMARY KEY,kind text NOT NULL,membership_revision bigint NOT NULL);
		CREATE TABLE conversation_members(conversation_id uuid NOT NULL,user_id uuid NOT NULL,active boolean NOT NULL);`); err != nil {
		t.Fatal(err)
	}
	callerID, recipientID, outsiderID, conversationID, callID := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	expiresAt := time.Now().Add(time.Minute).UTC()
	codec, err := pushcrypto.NewKeyring(map[string][]byte{"v1": make([]byte, 32)}, "v1", make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO users VALUES($1,'Caller','off'),($2,'Recipient','notifications'),($3,'Outsider','notifications')`, callerID, recipientID, outsiderID); err != nil {
		t.Fatal(err)
	}
	version, encrypted, fingerprint, err := codec.Seal(pushcrypto.Subscription{Endpoint: "https://push.example/subscription", P256DH: "p256", Auth: "auth"})
	if err != nil {
		t.Fatal(err)
	}
	deviceID, subscriptionID := uuid.New(), uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO devices(id,user_id) VALUES($1,$2)`, deviceID, recipientID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO push_subscriptions(id,user_id,device_id,encryption_version,encrypted_subscription,endpoint_fingerprint,vapid_key_id) VALUES($1,$2,$3,$4,$5,$6,'current')`, subscriptionID, recipientID, deviceID, version, encrypted, fingerprint); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO conversations VALUES($1,'group',4)`, conversationID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO conversation_members VALUES($1,$2,true),($1,$3,true)`, conversationID, callerID, recipientID); err != nil {
		t.Fatal(err)
	}
	rooms := &testCallPushRooms{room: application.GroupRoom{ID: callID, ConversationID: conversationID, MembershipRevision: 4, Status: application.GroupRoomRinging, RingExpiresAt: expiresAt}}
	repo := NewCallPushRepository(db, codec, "current", nil, rooms, NewGroupCallRepository(db), func() time.Time { return time.Now() })
	job := callpush.Job{Group: true, CallID: callID, ConversationID: conversationID, StarterID: callerID, ExpiresAt: expiresAt}
	name, subscriptions, eligible, err := repo.Resolve(ctx, job, recipientID)
	if err != nil || !eligible || name != "Caller" || len(subscriptions) != 1 || subscriptions[0].Endpoint != "https://push.example/subscription" {
		t.Fatalf("single-connection group resolve name=%q subscriptions=%d eligible=%t err=%v", name, len(subscriptions), eligible, err)
	}
	rooms.room.MembershipRevision++
	if name, subscriptions, eligible, err = repo.Resolve(ctx, job, recipientID); err != nil || eligible || name != "" || len(subscriptions) != 0 {
		t.Fatalf("stale revision leaked fetched values name=%q subscriptions=%d eligible=%t err=%v", name, len(subscriptions), eligible, err)
	}
	rooms.room.MembershipRevision--
	if name, subscriptions, eligible, err = repo.Resolve(ctx, job, outsiderID); err != nil || eligible || name != "" || len(subscriptions) != 0 {
		t.Fatalf("non-member leaked fetched values name=%q subscriptions=%d eligible=%t err=%v", name, len(subscriptions), eligible, err)
	}
	endedRoom := rooms.room
	endedRoom.Status = application.GroupRoomEnded
	rooms.lookups = 0
	rooms.afterFirst = &endedRoom
	if name, subscriptions, eligible, err = repo.Resolve(ctx, job, recipientID); err != nil || eligible || name != "" || len(subscriptions) != 0 {
		t.Fatalf("ended room leaked fetched values name=%q subscriptions=%d eligible=%t err=%v", name, len(subscriptions), eligible, err)
	}
}

type testCallPushRooms struct {
	application.GroupRoomCoordinator
	room       application.GroupRoom
	afterFirst *application.GroupRoom
	lookups    int
}

func (r *testCallPushRooms) GetGroupRoomForConversation(context.Context, uuid.UUID) (application.GroupRoom, error) {
	r.lookups++
	if r.lookups%2 == 0 && r.afterFirst != nil {
		return *r.afterFirst, nil
	}
	return r.room, nil
}

type callPushCallFake struct{ call application.Call }

func (f *callPushCallFake) Start(context.Context, application.Call, string) (application.Call, error) {
	return f.call, nil
}
func (f *callPushCallFake) Accept(context.Context, uuid.UUID, uuid.UUID, string, string) (application.Call, error) {
	return f.call, nil
}
func (f *callPushCallFake) Decline(context.Context, uuid.UUID, uuid.UUID, string, string) (application.Call, error) {
	return f.call, nil
}
func (f *callPushCallFake) Cancel(context.Context, uuid.UUID, uuid.UUID, string, string) (application.Call, error) {
	return f.call, nil
}
func (f *callPushCallFake) End(context.Context, uuid.UUID, uuid.UUID, string, string) (application.Call, error) {
	return f.call, nil
}
func (f *callPushCallFake) EndByDevice(context.Context, uuid.UUID, string, string) ([]application.Call, error) {
	return nil, nil
}
func (f *callPushCallFake) Get(context.Context, uuid.UUID) (application.Call, error) {
	return f.call, nil
}
func (*callPushCallFake) PublishCall(context.Context, application.CallChange) error { return nil }
