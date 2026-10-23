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

	"github.com/KovalMax/zwei/services/realtime/internal/application/messagepush"
	"github.com/KovalMax/zwei/services/shared/pushcrypto"
)

func isolatedPushDB(t *testing.T) (*pgxpool.Pool, context.Context) {
	t.Helper()
	dsn := os.Getenv("ZWEI_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set ZWEI_TEST_DATABASE_URL to run PostgreSQL integration tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	admin, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(admin.Close)
	schema := "push_test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		_, _ = admin.Exec(cleanup, "DROP SCHEMA IF EXISTS "+schema+" CASCADE")
	})
	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	db, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	return db, ctx
}

func TestMessagePushClaimIsIsolatedAndStaleClaimsCannotComplete(t *testing.T) {
	db, ctx := isolatedPushDB(t)
	_, err := db.Exec(ctx, `CREATE TABLE message_push_outbox (id uuid PRIMARY KEY,message_id uuid NOT NULL,conversation_id uuid NOT NULL,sender_id uuid NOT NULL,recipient_id uuid NOT NULL,event_type text NOT NULL DEFAULT 'message.push',expires_at timestamptz NOT NULL,attempt_count integer NOT NULL DEFAULT 0,next_attempt_at timestamptz NOT NULL DEFAULT now(),claim_token uuid,claim_expires_at timestamptz,processed_at timestamptz,created_at timestamptz NOT NULL DEFAULT now()); CREATE TABLE outbox_events (id uuid PRIMARY KEY,event_type text NOT NULL,processed_at timestamptz,claim_token uuid,claim_expires_at timestamptz);`)
	if err != nil {
		t.Fatal(err)
	}
	id := uuid.New()
	_, err = db.Exec(ctx, `INSERT INTO message_push_outbox(id,message_id,conversation_id,sender_id,recipient_id,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '1 hour')`, id, uuid.New(), uuid.New(), uuid.New(), uuid.New())
	if err != nil {
		t.Fatal(err)
	}
	expiredID := uuid.New()
	if _, err = db.Exec(ctx, `INSERT INTO message_push_outbox(id,message_id,conversation_id,sender_id,recipient_id,expires_at) VALUES($1,$2,$3,$4,$5,now()-interval '1 second')`, expiredID, uuid.New(), uuid.New(), uuid.New(), uuid.New()); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(ctx, `INSERT INTO outbox_events(id,event_type) VALUES($1,'conversation.created')`, uuid.New()); err != nil {
		t.Fatal(err)
	}
	repo := NewMessagePushOutbox(db, nil)
	claimed, err := repo.Claim(ctx, 1)
	if err != nil || len(claimed) != 1 {
		t.Fatalf("claim=%v err=%v", claimed, err)
	}
	var expiredProcessed bool
	if err := db.QueryRow(ctx, `SELECT processed_at IS NOT NULL FROM message_push_outbox WHERE id=$1`, expiredID).Scan(&expiredProcessed); err != nil || !expiredProcessed {
		t.Fatalf("expired row processed=%t err=%v", expiredProcessed, err)
	}
	if other, err := repo.Claim(ctx, 1); err != nil || len(other) != 0 {
		t.Fatalf("duplicate claim=%v err=%v", other, err)
	}
	stale := claimed[0]
	stale.ClaimToken = uuid.New()
	if err := repo.Complete(ctx, stale); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `UPDATE message_push_outbox SET claim_expires_at=now()-interval '1 second' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	reclaimed, err := repo.Claim(ctx, 1)
	if err != nil || len(reclaimed) != 1 || reclaimed[0].ClaimToken == claimed[0].ClaimToken {
		t.Fatalf("reclaim=%v err=%v", reclaimed, err)
	}
	if err := repo.Retry(ctx, claimed[0]); err != nil {
		t.Fatal(err)
	}
	var attempts int
	var token uuid.UUID
	if err := db.QueryRow(ctx, `SELECT attempt_count,claim_token FROM message_push_outbox WHERE id=$1`, id).Scan(&attempts, &token); err != nil {
		t.Fatal(err)
	}
	if attempts != 0 || token != reclaimed[0].ClaimToken {
		t.Fatalf("stale claim changed row attempts=%d token=%s", attempts, token)
	}
	if err := repo.Retry(ctx, reclaimed[0]); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(ctx, `SELECT attempt_count FROM message_push_outbox WHERE id=$1`, id).Scan(&attempts); err != nil {
		t.Fatal(err)
	}
	if attempts != 1 {
		t.Fatalf("attempts=%d, want 1", attempts)
	}
	if ready, err := repo.Claim(ctx, 1); err != nil || len(ready) != 0 {
		t.Fatalf("intent was claimed before backoff: events=%v err=%v", ready, err)
	}
	if _, err := db.Exec(ctx, `UPDATE message_push_outbox SET attempt_count=11,next_attempt_at=now() WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	finalAttempt, err := repo.Claim(ctx, 1)
	if err != nil || len(finalAttempt) != 1 {
		t.Fatalf("final attempt claim=%v err=%v", finalAttempt, err)
	}
	if err := repo.Retry(ctx, finalAttempt[0]); err != nil {
		t.Fatal(err)
	}
	var terminal bool
	if err := db.QueryRow(ctx, `SELECT processed_at IS NOT NULL FROM message_push_outbox WHERE id=$1`, id).Scan(&terminal); err != nil || !terminal {
		t.Fatalf("attempt limit terminal=%t err=%v", terminal, err)
	}
	var otherClaim uuid.NullUUID
	if err := db.QueryRow(ctx, `SELECT claim_token FROM outbox_events`).Scan(&otherClaim); err != nil {
		t.Fatal(err)
	}
	if otherClaim.Valid {
		t.Fatal("message push claimed a conversation event")
	}
}

func TestResolveDecryptsOnlyEligibleRecipientSubscriptions(t *testing.T) {
	db, ctx := isolatedPushDB(t)
	_, err := db.Exec(ctx, `CREATE TABLE users(id uuid PRIMARY KEY,display_name text NOT NULL,alert_mode text NOT NULL); CREATE TABLE messages(id uuid PRIMARY KEY,conversation_id uuid NOT NULL,sender_id uuid NOT NULL,sequence bigint NOT NULL,expires_at timestamptz); CREATE TABLE conversation_members(conversation_id uuid,user_id uuid,active boolean NOT NULL,visible_from_sequence bigint NOT NULL); CREATE TABLE devices(id uuid PRIMARY KEY,user_id uuid NOT NULL,revoked_at timestamptz); CREATE TABLE push_subscriptions(id uuid PRIMARY KEY,user_id uuid NOT NULL,device_id uuid NOT NULL,encryption_version text NOT NULL,encrypted_subscription bytea NOT NULL,endpoint_fingerprint bytea NOT NULL,vapid_key_id text,created_at timestamptz NOT NULL DEFAULT now());`)
	if err != nil {
		t.Fatal(err)
	}
	senderID, recipientID, conversationID, messageID, deviceID, secondDeviceID, subscriptionID, secondSubscriptionID := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	endpoint := "https://fcm.googleapis.com/fcm/send/" + uuid.NewString()
	secondEndpoint := "https://fcm.googleapis.com/fcm/send/" + uuid.NewString()
	indexKey := bytes.Repeat([]byte{3}, 32)
	codec, err := pushcrypto.NewKeyring(map[string][]byte{"v1": make([]byte, 32), "v2": bytes.Repeat([]byte{2}, 32)}, "v2", indexKey)
	if err != nil {
		t.Fatal(err)
	}
	oldCodec, err := pushcrypto.NewKeyring(map[string][]byte{"v1": make([]byte, 32)}, "v1", indexKey)
	if err != nil {
		t.Fatal(err)
	}
	version, ciphertext, fingerprint, err := oldCodec.Seal(pushcrypto.Subscription{Endpoint: endpoint, P256DH: "p256", Auth: "auth"})
	if err != nil {
		t.Fatal(err)
	}
	secondVersion, secondCiphertext, secondFingerprint, err := codec.Seal(pushcrypto.Subscription{Endpoint: secondEndpoint, P256DH: "p256", Auth: "auth"})
	if err != nil {
		t.Fatal(err)
	}
	for _, query := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users VALUES($1,'Sender','off')`, []any{senderID}},
		{`INSERT INTO users VALUES($1,'Recipient','notifications')`, []any{recipientID}},
		{`INSERT INTO messages VALUES($1,$2,$3,5,now()+interval '1 hour')`, []any{messageID, conversationID, senderID}},
		{`INSERT INTO conversation_members VALUES($1,$2,true,5)`, []any{conversationID, recipientID}},
		{`INSERT INTO devices VALUES($1,$2,NULL)`, []any{deviceID, recipientID}},
		{`INSERT INTO devices VALUES($1,$2,NULL)`, []any{secondDeviceID, recipientID}},
		{`INSERT INTO push_subscriptions(id,user_id,device_id,encryption_version,encrypted_subscription,endpoint_fingerprint,vapid_key_id) VALUES($1,$2,$3,$4,$5,$6,'current')`, []any{subscriptionID, recipientID, deviceID, version, ciphertext, fingerprint}},
		{`INSERT INTO push_subscriptions(id,user_id,device_id,encryption_version,encrypted_subscription,endpoint_fingerprint,vapid_key_id) VALUES($1,$2,$3,$4,$5,$6,'current')`, []any{secondSubscriptionID, recipientID, secondDeviceID, secondVersion, secondCiphertext, secondFingerprint}},
	} {
		if _, err := db.Exec(ctx, query.sql, query.args...); err != nil {
			t.Fatal(err)
		}
	}
	thirdDevice, thirdSubscription := uuid.New(), uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO devices VALUES($1,$2,NULL)`, thirdDevice, recipientID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO push_subscriptions(id,user_id,device_id,encryption_version,encrypted_subscription,endpoint_fingerprint,vapid_key_id) VALUES($1,$2,$3,$4,$5,$6,'old')`, thirdSubscription, recipientID, thirdDevice, secondVersion, secondCiphertext, secondFingerprint); err != nil {
		t.Fatal(err)
	}
	repo := NewMessagePushOutbox(db, codec, "current")
	intent := messagepush.Intent{MessageID: messageID, ConversationID: conversationID, SenderID: senderID, RecipientID: recipientID, ExpiresAt: time.Now().Add(time.Hour)}
	name, subs, eligible, err := repo.Resolve(ctx, intent)
	if err != nil || !eligible || name != "Sender" || len(subs) != 2 {
		t.Fatalf("resolved name=%q subs=%v eligible=%t err=%v", name, subs, eligible, err)
	}
	endpoints := map[uuid.UUID]string{}
	for _, sub := range subs {
		endpoints[sub.ID] = sub.Endpoint
	}
	if endpoints[subscriptionID] != endpoint || endpoints[secondSubscriptionID] != secondEndpoint {
		t.Fatalf("decrypted subscriptions=%v", endpoints)
	}
	var staleFingerprint []byte
	for _, sub := range subs {
		if sub.ID == subscriptionID {
			staleFingerprint = append([]byte(nil), sub.Fingerprint...)
		}
	}
	if len(staleFingerprint) == 0 {
		t.Fatal("resolved subscription fingerprint missing")
	}
	replacementEndpoint := "https://fcm.googleapis.com/fcm/send/" + uuid.NewString()
	replacementVersion, replacementCiphertext, replacementFingerprint, err := codec.Seal(pushcrypto.Subscription{Endpoint: replacementEndpoint, P256DH: "new-p256", Auth: "new-auth"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `UPDATE push_subscriptions SET encryption_version=$2,encrypted_subscription=$3,endpoint_fingerprint=$4 WHERE id=$1`, subscriptionID, replacementVersion, replacementCiphertext, replacementFingerprint); err != nil {
		t.Fatal(err)
	}
	if err := repo.DeleteSubscription(ctx, subscriptionID, staleFingerprint); err != nil {
		t.Fatal(err)
	}
	_, subs, eligible, err = repo.Resolve(ctx, intent)
	if err != nil || !eligible || len(subs) != 2 {
		t.Fatalf("stale provider response removed replacement subscriptions=%v eligible=%t err=%v", subs, eligible, err)
	}
	var replacementSurvived bool
	for _, sub := range subs {
		if sub.ID == subscriptionID && sub.Endpoint == replacementEndpoint && bytes.Equal(sub.Fingerprint, replacementFingerprint) {
			replacementSurvived = true
		}
	}
	if !replacementSurvived {
		t.Fatalf("replacement subscription did not survive stale delete: %v", subs)
	}
	if err := repo.DeleteSubscription(ctx, subscriptionID, replacementFingerprint); err != nil {
		t.Fatal(err)
	}
	_, subs, eligible, err = repo.Resolve(ctx, intent)
	if err != nil || !eligible || len(subs) != 1 || subs[0].ID != secondSubscriptionID {
		t.Fatalf("exact delete left subscriptions=%v eligible=%t err=%v", subs, eligible, err)
	}
	if _, err := db.Exec(ctx, `UPDATE conversation_members SET visible_from_sequence=6 WHERE user_id=$1`, recipientID); err != nil {
		t.Fatal(err)
	}
	_, _, eligible, err = repo.Resolve(ctx, intent)
	if err != nil || eligible {
		t.Fatalf("invisible message eligible=%t err=%v", eligible, err)
	}
	if _, err := db.Exec(ctx, `UPDATE conversation_members SET visible_from_sequence=5 WHERE user_id=$1`, recipientID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `UPDATE users SET alert_mode='sounds' WHERE id=$1`, recipientID); err != nil {
		t.Fatal(err)
	}
	_, _, eligible, err = repo.Resolve(ctx, intent)
	if err != nil || eligible {
		t.Fatalf("sounds mode eligible=%t err=%v", eligible, err)
	}
	if _, err := db.Exec(ctx, `UPDATE users SET alert_mode='notifications' WHERE id=$1`, recipientID); err != nil {
		t.Fatal(err)
	}
	intent.ExpiresAt = time.Now().Add(-time.Second)
	_, _, eligible, err = repo.Resolve(ctx, intent)
	if err != nil || eligible {
		t.Fatalf("expired intent eligible=%t err=%v", eligible, err)
	}
}
