package postgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/KovalMax/zwei/services/auth/internal/application"
	"github.com/KovalMax/zwei/services/auth/internal/domain/user"
	"github.com/KovalMax/zwei/services/shared/pushcrypto"
)

func TestPushFingerprintIdentityIsDurableConcurrentAndRekeyDeletesSubscriptions(t *testing.T) {
	databaseURL := os.Getenv("ZWEI_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set ZWEI_TEST_DATABASE_URL to run PostgreSQL integration tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	var databaseName string
	if err := db.QueryRow(ctx, `SELECT current_database()`).Scan(&databaseName); err != nil {
		t.Fatal(err)
	}
	if databaseName != "messenger_test" {
		t.Skipf("refusing to mutate push identity outside messenger_test (connected to %q)", databaseName)
	}
	lockConn, err := db.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := lockConn.Exec(ctx, `SELECT pg_advisory_lock(1515668809, 21)`); err != nil {
		lockConn.Release()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = lockConn.Exec(context.Background(), `SELECT pg_advisory_unlock(1515668809, 21)`)
		lockConn.Release()
	})
	var existingSubscriptions int
	if err := db.QueryRow(ctx, `SELECT count(*) FROM push_subscriptions`).Scan(&existingSubscriptions); err != nil {
		t.Fatal(err)
	}
	if existingSubscriptions != 0 {
		t.Skipf("refusing destructive re-key integration check with %d pre-existing test subscriptions", existingSubscriptions)
	}
	var previous []byte
	if err := db.QueryRow(ctx, `SELECT key_id FROM push_fingerprint_key_identity WHERE singleton=true`).Scan(&previous); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if len(previous) == 0 {
			_, _ = db.Exec(context.Background(), `DELETE FROM push_fingerprint_key_identity WHERE singleton=true`)
		} else {
			_, _ = db.Exec(context.Background(), `INSERT INTO push_fingerprint_key_identity(singleton,key_id) VALUES(true,$1) ON CONFLICT(singleton) DO UPDATE SET key_id=EXCLUDED.key_id`, previous)
		}
	})
	if _, err := db.Exec(ctx, `DELETE FROM push_fingerprint_key_identity WHERE singleton=true`); err != nil {
		t.Fatal(err)
	}
	codecFor := func(key byte) *pushcrypto.Codec {
		codec, err := pushcrypto.New(bytes.Repeat([]byte{1}, 32), bytes.Repeat([]byte{key}, 32))
		if err != nil {
			t.Fatal(err)
		}
		return codec
	}
	first, second := NewRepository(db, codecFor(2)), NewRepository(db, codecFor(3))
	start := make(chan struct{})
	results := make(chan error, 16)
	for i := 0; i < 16; i++ {
		repository := first
		if i%2 == 1 {
			repository = second
		}
		go func(repository *Repository) {
			<-start
			results <- repository.EnsurePushFingerprintKeyIdentity(ctx)
		}(repository)
	}
	close(start)
	var success, mismatch int
	for i := 0; i < 16; i++ {
		err := <-results
		switch {
		case err == nil:
			success++
		case err.Error() == "push fingerprint key identity mismatch":
			mismatch++
		default:
			t.Fatalf("concurrent ensure failed unexpectedly: %v", err)
		}
	}
	if success == 0 || mismatch == 0 || success+mismatch != 16 {
		t.Fatalf("concurrent first-use outcomes: success=%d mismatch=%d; want one key group to win", success, mismatch)
	}
	var stored []byte
	if err := db.QueryRow(ctx, `SELECT key_id FROM push_fingerprint_key_identity WHERE singleton=true`).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	firstID, secondID := first.codec.FingerprintKeyID(), second.codec.FingerprintKeyID()
	if !bytes.Equal(stored, firstID[:]) && !bytes.Equal(stored, secondID[:]) {
		t.Fatal("stored identity is not one of the concurrently configured keys")
	}
	winner := first
	if !bytes.Equal(stored, firstID[:]) {
		winner = second
	}
	if err := winner.EnsurePushFingerprintKeyIdentity(ctx); err != nil {
		t.Fatalf("same-key ensure failed: %v", err)
	}
	loser := second
	if winner == second {
		loser = first
	}
	if err := loser.EnsurePushFingerprintKeyIdentity(ctx); err == nil {
		t.Fatal("changed key was accepted")
	}
	var afterMismatch []byte
	if err := db.QueryRow(ctx, `SELECT key_id FROM push_fingerprint_key_identity WHERE singleton=true`).Scan(&afterMismatch); err != nil || !bytes.Equal(stored, afterMismatch) {
		t.Fatalf("mismatch mutated identity: err=%v", err)
	}
	// Prove the explicitly invoked operator transaction removes subscriptions
	// and replaces the durable identity together.
	fixtureUser := uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO users(id,email,password_hash,display_name) VALUES($1,$2,'test','Fingerprint identity test')`, fixtureUser, "push-identity-"+fixtureUser.String()+"@example.test"); err != nil {
		t.Fatal(err)
	}
	var fixtureDevice uuid.UUID
	if err := db.QueryRow(ctx, `INSERT INTO devices(user_id,client_device_id,name) VALUES($1,'push-identity-test','test') RETURNING id`, fixtureUser).Scan(&fixtureDevice); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = db.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, fixtureUser) })
	if _, err := db.Exec(ctx, `INSERT INTO push_subscriptions(user_id,device_id,endpoint_fingerprint,encryption_version,encrypted_subscription) VALUES($1,$2,decode(repeat('ab',32),'hex'),'v1',decode('01','hex'))`, fixtureUser, fixtureDevice); err != nil {
		t.Fatal(err)
	}
	if err := winner.RekeyPushFingerprintKey(ctx); err != nil {
		t.Fatalf("explicit re-key failed: %v", err)
	}
	var subscriptions int
	if err := db.QueryRow(ctx, `SELECT count(*) FROM push_subscriptions`).Scan(&subscriptions); err != nil || subscriptions != 0 {
		t.Fatalf("subscriptions after re-key=%d err=%v", subscriptions, err)
	}
	winnerID := winner.codec.FingerprintKeyID()
	if err := db.QueryRow(ctx, `SELECT key_id FROM push_fingerprint_key_identity WHERE singleton=true`).Scan(&afterMismatch); err != nil || !bytes.Equal(afterMismatch, winnerID[:]) {
		t.Fatalf("re-key identity mismatch: err=%v", err)
	}
}

func TestPushSubscriptionOwnershipAndLogoutAreAtomic(t *testing.T) {
	databaseURL := os.Getenv("ZWEI_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set ZWEI_TEST_DATABASE_URL to run PostgreSQL integration tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	db, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Close()
	if _, err := db.Exec(ctx, `SELECT 1`); err != nil {
		t.Fatal(err)
	}
	codec, err := pushcrypto.NewKeyring(map[string][]byte{"v1": make([]byte, 32), "v2": bytes.Repeat([]byte{2}, 32)}, "v2", bytes.Repeat([]byte{3}, 32))
	if err != nil {
		t.Fatal(err)
	}
	repository := NewRepository(db, codec, "current")
	firstUser, firstDevice := createPushTestUser(t, ctx, repository, db)
	secondUser, secondDevice := createPushTestUser(t, ctx, repository, db)
	t.Cleanup(func() {
		_, _ = db.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, firstUser)
		_, _ = db.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, secondUser)
	})
	if _, err := db.Exec(ctx, `INSERT INTO push_subscriptions (user_id, device_id, endpoint_fingerprint, encryption_version, encrypted_subscription) VALUES ($1, $2, $3, 'v1', $4)`, firstUser, secondDevice, make([]byte, 32), []byte{1}); err == nil {
		t.Fatal("database accepted a subscription whose device belongs to a different account")
	} else {
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Code != "23503" {
			t.Fatalf("cross-account device insert error = %v, want foreign-key violation", err)
		}
	}

	key := base64.RawURLEncoding.EncodeToString(append([]byte{4}, make([]byte, 64)...))
	auth := base64.RawURLEncoding.EncodeToString(make([]byte, 16))
	subscription := application.PushSubscription{Endpoint: "https://fcm.googleapis.com/fcm/send/" + uuid.NewString(), P256DH: key, Auth: auth}
	if err := repository.StorePushSubscription(ctx, firstUser, firstDevice, 1, firstUser, firstUser, subscription); err != nil {
		t.Fatalf("store first account subscription: %v", err)
	}
	for _, tc := range []struct {
		name         string
		user, device uuid.UUID
		version      int64
		sub          application.PushSubscription
		want         bool
		revoked      bool
	}{
		{"match", firstUser, firstDevice, 1, subscription, true, false},
		{"other user", secondUser, secondDevice, 1, subscription, false, false},
		{"stale session", firstUser, firstDevice, 2, subscription, false, true},
		{"endpoint", firstUser, firstDevice, 1, application.PushSubscription{Endpoint: subscription.Endpoint + "x", P256DH: key, Auth: auth}, false, false},
		{"key", firstUser, firstDevice, 1, application.PushSubscription{Endpoint: subscription.Endpoint, P256DH: key + "x", Auth: auth}, false, false},
		{"auth", firstUser, firstDevice, 1, application.PushSubscription{Endpoint: subscription.Endpoint, P256DH: key, Auth: auth + "x"}, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := repository.VerifyPushSubscription(ctx, tc.user, tc.device, tc.version, tc.sub)
			if got != tc.want || tc.revoked != errors.Is(err, application.ErrPushSessionRevoked) || (!tc.revoked && err != nil) {
				t.Fatalf("verification = %v, error = %v", got, err)
			}
		})
	}
	oldVAPID := NewRepository(db, codec, "old")
	if got, err := oldVAPID.VerifyPushSubscription(ctx, firstUser, firstDevice, 1, subscription); err != nil || got {
		t.Fatalf("old VAPID verification = %v, error = %v", got, err)
	}
	var writtenVersion string
	if err := db.QueryRow(ctx, `SELECT encryption_version FROM push_subscriptions WHERE user_id=$1 AND device_id=$2`, firstUser, firstDevice).Scan(&writtenVersion); err != nil || writtenVersion != "v2" {
		t.Fatalf("stored encryption version=%q err=%v; want v2", writtenVersion, err)
	}
	if _, err := db.Exec(ctx, `UPDATE users SET alert_mode = 'off' WHERE id = $1`, secondUser); err != nil {
		t.Fatal(err)
	}
	disabledSubscription := subscription
	disabledSubscription.Endpoint += "-disabled"
	if err := repository.StorePushSubscription(ctx, secondUser, secondDevice, 1, secondUser, secondUser, disabledSubscription); !errors.Is(err, application.ErrPushUnavailable) {
		t.Fatalf("disabled account enrollment error = %v, want push disabled", err)
	}
	if _, err := db.Exec(ctx, `UPDATE users SET alert_mode = 'notifications' WHERE id = $1`, secondUser); err != nil {
		t.Fatal(err)
	}
	if err := repository.StorePushSubscription(ctx, secondUser, secondDevice, 1, secondUser, secondUser, subscription); !errors.Is(err, application.ErrPushSubscriptionOwned) {
		t.Fatalf("cross-account endpoint ownership error = %v, want protected ownership error", err)
	}
	var storedPayload []byte
	if err := db.QueryRow(ctx, `SELECT encrypted_subscription FROM push_subscriptions WHERE user_id = $1`, firstUser).Scan(&storedPayload); err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{subscription.Endpoint, subscription.P256DH, subscription.Auth} {
		if bytes.Contains(storedPayload, []byte(secret)) {
			t.Fatalf("stored ciphertext contains plaintext secret %q", secret)
		}
	}
	updatedSubscription := subscription
	updatedSubscription.Endpoint += "-rotated"
	if err := repository.StorePushSubscription(ctx, firstUser, firstDevice, 1, firstUser, firstUser, updatedSubscription); err != nil {
		t.Fatalf("update browser subscription: %v", err)
	}
	var storedVersion string
	if err := db.QueryRow(ctx, `SELECT encryption_version, encrypted_subscription FROM push_subscriptions WHERE user_id = $1`, firstUser).Scan(&storedVersion, &storedPayload); err != nil {
		t.Fatal(err)
	}
	decrypted, err := codec.Open(storedVersion, storedPayload)
	if err != nil || decrypted.Endpoint != updatedSubscription.Endpoint {
		t.Fatalf("stored updated subscription = %#v, %v", decrypted, err)
	}
	versionHash := sha256.Sum256([]byte(uuid.NewString()))
	expiresAt := time.Now().Add(time.Hour)
	if err := repository.CreateSession(ctx, firstUser, firstDevice, versionHash[:], 1, expiresAt); err != nil {
		t.Fatalf("create test session: %v", err)
	}
	if err := repository.RevokeAllSessions(ctx, firstUser); err != nil {
		t.Fatalf("logout: %v", err)
	}
	if err := repository.StorePushSubscription(ctx, firstUser, firstDevice, 1, firstUser, firstUser, subscription); !errors.Is(err, application.ErrPushSessionRevoked) {
		t.Fatalf("stale subscription write error = %v, want session revoked", err)
	}
	var pushCount int
	var sessionVersion int64
	var alertMode string
	var sessionRevoked bool
	if err := db.QueryRow(ctx, `SELECT count(*) FROM push_subscriptions WHERE user_id = $1`, firstUser).Scan(&pushCount); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(ctx, `SELECT session_version, alert_mode FROM users WHERE id = $1`, firstUser).Scan(&sessionVersion, &alertMode); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(ctx, `SELECT revoked_at IS NOT NULL FROM sessions WHERE user_id = $1`, firstUser).Scan(&sessionRevoked); err != nil {
		t.Fatal(err)
	}
	if pushCount != 0 || sessionVersion != 2 || alertMode != "notifications" || !sessionRevoked {
		t.Fatalf("logout results: subscriptions=%d version=%d alert_mode=%q session_revoked=%t", pushCount, sessionVersion, alertMode, sessionRevoked)
	}
}

func TestConcurrentSubscriptionWriteCannotOutliveLogout(t *testing.T) {
	databaseURL := os.Getenv("ZWEI_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set ZWEI_TEST_DATABASE_URL to run PostgreSQL integration tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	db, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Close()
	codec, err := pushcrypto.New(make([]byte, 32), make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	repository := NewRepository(db, codec)
	userID, deviceID := createPushTestUser(t, ctx, repository, db)
	t.Cleanup(func() { _, _ = db.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, userID) })
	tx, err := db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	var version int64
	if err := tx.QueryRow(ctx, `SELECT session_version FROM users WHERE id = $1 FOR UPDATE`, userID).Scan(&version); err != nil {
		t.Fatal(err)
	}
	logoutResult := make(chan error, 1)
	go func() { logoutResult <- repository.RevokeAllSessions(ctx, userID) }()
	waitForLockWait(t, ctx, db, `%SET session_version = session_version + 1%`)
	key := base64.RawURLEncoding.EncodeToString(append([]byte{4}, make([]byte, 64)...))
	auth := base64.RawURLEncoding.EncodeToString(make([]byte, 16))
	writeResult := make(chan error, 1)
	go func() {
		writeResult <- repository.StorePushSubscription(ctx, userID, deviceID, version, userID, userID, application.PushSubscription{
			Endpoint: "https://fcm.googleapis.com/fcm/send/" + uuid.NewString(), P256DH: key, Auth: auth,
		})
	}()
	waitForLockWait(t, ctx, db, `%SELECT session_version, alert_mode FROM users%`)
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-logoutResult; err != nil {
		t.Fatalf("concurrent logout: %v", err)
	}
	if err := <-writeResult; !errors.Is(err, application.ErrPushSessionRevoked) {
		t.Fatalf("concurrent stale write error = %v, want session revoked", err)
	}
	var count int
	if err := db.QueryRow(ctx, `SELECT count(*) FROM push_subscriptions WHERE user_id = $1`, userID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("subscriptions after logout/write race = %d, want 0", count)
	}
}

func TestConcurrentSubscriptionWritesRespectPerAccountQuota(t *testing.T) {
	databaseURL := os.Getenv("ZWEI_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set ZWEI_TEST_DATABASE_URL to run PostgreSQL integration tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	db, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Close()
	codec, err := pushcrypto.New(make([]byte, 32), make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	repository := NewRepository(db, codec)
	userID, _, err := createPushTestUserWithDevice(t, ctx, repository, db)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = db.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, userID) })
	type write struct {
		deviceID uuid.UUID
		err      error
	}
	writes := make(chan write, maxPushSubscriptionsPerAccount+1)
	for i := 0; i < maxPushSubscriptionsPerAccount+1; i++ {
		deviceID, err := repository.EnsureDevice(ctx, userID, "quota-device-"+uuid.NewString(), "quota test")
		if err != nil {
			t.Fatalf("create quota device: %v", err)
		}
		go func(deviceID uuid.UUID) {
			key := base64.RawURLEncoding.EncodeToString(append([]byte{4}, make([]byte, 64)...))
			auth := base64.RawURLEncoding.EncodeToString(make([]byte, 16))
			writes <- write{deviceID: deviceID, err: repository.StorePushSubscription(ctx, userID, deviceID, 1, userID, userID, application.PushSubscription{
				Endpoint: "https://fcm.googleapis.com/fcm/send/" + uuid.NewString(), P256DH: key, Auth: auth,
			})}
		}(deviceID)
	}
	accepted, limited := 0, 0
	for i := 0; i < maxPushSubscriptionsPerAccount+1; i++ {
		result := <-writes
		switch {
		case result.err == nil:
			accepted++
		case errors.Is(result.err, application.ErrPushSubscriptionLimit):
			limited++
		default:
			t.Fatalf("store device %s: %v", result.deviceID, result.err)
		}
	}
	if accepted != maxPushSubscriptionsPerAccount || limited != 1 {
		t.Fatalf("concurrent stores accepted=%d limited=%d, want accepted=%d limited=1", accepted, limited, maxPushSubscriptionsPerAccount)
	}
	var count int
	if err := db.QueryRow(ctx, `SELECT count(*) FROM push_subscriptions WHERE user_id = $1`, userID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != maxPushSubscriptionsPerAccount {
		t.Fatalf("stored subscriptions=%d, want %d", count, maxPushSubscriptionsPerAccount)
	}
}

func TestReplaceBrowserSessionRetiresOnlyOldDeviceAndRollsBack(t *testing.T) {
	url := os.Getenv("ZWEI_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set ZWEI_TEST_DATABASE_URL for isolated PostgreSQL")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	db, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	codec, err := pushcrypto.New(make([]byte, 32), make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	repo := NewRepository(db, codec)
	owner, device := createPushTestUser(t, ctx, repo, db)
	target, targetDevice := createPushTestUser(t, ctx, repo, db)
	defer db.Exec(context.Background(), `DELETE FROM users WHERE id=ANY($1)`, []uuid.UUID{owner, target})
	second, err := repo.EnsureDevice(ctx, owner, uuid.NewString(), "second")
	if err != nil {
		t.Fatal(err)
	}
	browser, generation, next := uuid.New(), uuid.New(), uuid.New()
	defer db.Exec(context.Background(), `DELETE FROM browser_auth_heads WHERE browser_id=$1`, browser)
	oldHash, newHash := sha256.Sum256([]byte(uuid.NewString())), sha256.Sum256([]byte(uuid.NewString()))
	issue := func(user.Session) error { return nil }
	if err = repo.CreateBrowserSession(ctx, browser, generation, owner, device, oldHash[:], 1, time.Now().Add(time.Hour), issue); err != nil {
		t.Fatal(err)
	}
	endpoint := "https://fcm.googleapis.com/send/" + uuid.NewString()
	for _, pair := range [][2]uuid.UUID{{owner, device}, {owner, second}, {target, targetDevice}} {
		sub := application.PushSubscription{Endpoint: "https://fcm.googleapis.com/send/" + uuid.NewString(), P256DH: "key", Auth: "auth"}
		if pair[1] == device {
			sub.Endpoint = endpoint
		}
		if err = repo.StorePushSubscription(ctx, pair[0], pair[1], 1, pair[0], pair[0], sub); err != nil {
			t.Fatal(err)
		}
	}
	failure := errors.New("issuance failed")
	replace := func(callback func(user.Session) error) error {
		return repo.ReplaceBrowserSession(ctx, browser, generation, oldHash[:], next, target, targetDevice, newHash[:], 1, time.Now().Add(time.Hour), callback)
	}
	if err = replace(func(user.Session) error { return failure }); !errors.Is(err, failure) {
		t.Fatalf("rollback: %v", err)
	}
	var count int
	if err = db.QueryRow(ctx, `SELECT count(*) FROM push_subscriptions WHERE device_id=$1`, device).Scan(&count); err != nil || count != 1 {
		t.Fatalf("rollback count=%d err=%v", count, err)
	}
	if err = replace(issue); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		id   uuid.UUID
		want int
	}{{device, 0}, {second, 1}, {targetDevice, 1}} {
		if err = db.QueryRow(ctx, `SELECT count(*) FROM push_subscriptions WHERE device_id=$1`, tc.id).Scan(&count); err != nil || count != tc.want {
			t.Fatalf("device=%s count=%d want=%d err=%v", tc.id, count, tc.want, err)
		}
	}
	// Reusing the browser endpoint on the new account must no longer conflict.
	if err = repo.StorePushSubscription(ctx, target, targetDevice, 1, browser, next, application.PushSubscription{Endpoint: endpoint, P256DH: "key", Auth: "auth"}); err != nil {
		t.Fatalf("endpoint reuse: %v", err)
	}
}

func TestDeleteCurrentPushSubscriptionIsIdempotentAndDeviceScoped(t *testing.T) {
	url := os.Getenv("ZWEI_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set ZWEI_TEST_DATABASE_URL for PostgreSQL integration")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	db, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	codec, err := pushcrypto.New(make([]byte, 32), make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	repo := NewRepository(db, codec)
	owner, device := createPushTestUser(t, ctx, repo, db)
	other, otherDevice := createPushTestUser(t, ctx, repo, db)
	defer db.Exec(context.Background(), `DELETE FROM users WHERE id = ANY($1)`, []uuid.UUID{owner, other})
	browser, generation := uuid.New(), uuid.New()
	defer db.Exec(context.Background(), `DELETE FROM browser_auth_heads WHERE browser_id=$1`, browser)
	hash := sha256.Sum256([]byte(uuid.NewString()))
	if err := repo.CreateBrowserSession(ctx, browser, generation, owner, device, hash[:], 1, time.Now().Add(time.Hour), func(user.Session) error { return nil }); err != nil {
		t.Fatal(err)
	}
	second, err := repo.EnsureDevice(ctx, owner, uuid.NewString(), "second")
	if err != nil {
		t.Fatal(err)
	}
	for _, pair := range [][2]uuid.UUID{{owner, device}, {owner, second}, {other, otherDevice}} {
		sub := application.PushSubscription{Endpoint: "https://fcm.googleapis.com/send/" + uuid.NewString(), P256DH: "key", Auth: "auth"}
		if err := repo.StorePushSubscription(ctx, pair[0], pair[1], 1, pair[0], pair[0], sub); err != nil {
			t.Fatal(err)
		}
	}
	for _, tc := range []struct {
		user, device uuid.UUID
		version      int64
	}{{owner, device, 2}, {owner, otherDevice, 1}} {
		if err := repo.DeleteCurrentPushSubscription(ctx, tc.user, tc.device, tc.version, browser, generation); !errors.Is(err, application.ErrPushSessionRevoked) {
			t.Fatalf("invalid identity: %v", err)
		}
	}
	if _, err := db.Exec(ctx, `UPDATE users SET alert_mode='off' WHERE id=$1`, owner); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := repo.DeleteCurrentPushSubscription(ctx, owner, device, 1, browser, generation); err != nil {
			t.Fatal(err)
		}
	}
	for _, tc := range []struct {
		id   uuid.UUID
		want int
	}{{device, 0}, {second, 1}, {otherDevice, 1}} {
		var count int
		if err := db.QueryRow(ctx, `SELECT count(*) FROM push_subscriptions WHERE device_id=$1`, tc.id).Scan(&count); err != nil || count != tc.want {
			t.Fatalf("device %s count=%d err=%v", tc.id, count, err)
		}
	}
}

func TestDeleteCurrentPushSubscriptionSerializesWithBrowserReplacement(t *testing.T) {
	url := os.Getenv("ZWEI_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set ZWEI_TEST_DATABASE_URL for isolated PostgreSQL")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	db, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	codec, err := pushcrypto.New(make([]byte, 32), make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	repo := NewRepository(db, codec)
	owner, device := createPushTestUser(t, ctx, repo, db)
	defer db.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, owner)
	for _, replacementFirst := range []bool{true, false} {
		browser, generation, nextGeneration := uuid.New(), uuid.New(), uuid.New()
		defer db.Exec(context.Background(), `DELETE FROM browser_auth_heads WHERE browser_id=$1`, browser)
		oldHash := sha256.Sum256([]byte(uuid.NewString()))
		nextHash := sha256.Sum256([]byte(uuid.NewString()))
		issue := func(user.Session) error { return nil }
		if err := repo.CreateBrowserSession(ctx, browser, generation, owner, device, oldHash[:], 1, time.Now().Add(time.Hour), issue); err != nil {
			t.Fatal(err)
		}
		sub := application.PushSubscription{Endpoint: "https://fcm.googleapis.com/send/" + uuid.NewString(), P256DH: "key", Auth: "auth"}
		if err := repo.StorePushSubscription(ctx, owner, device, 1, browser, generation, sub); err != nil {
			t.Fatal(err)
		}
		deleteResult, replaceResult := make(chan error, 1), make(chan error, 1)
		replace := func(issue func(user.Session) error) {
			replaceResult <- repo.ReplaceBrowserSession(ctx, browser, generation, oldHash[:], nextGeneration, owner, device, nextHash[:], 1, time.Now().Add(time.Hour), issue)
		}
		deleteCurrent := func() { deleteResult <- repo.DeleteCurrentPushSubscription(ctx, owner, device, 1, browser, generation) }
		if replacementFirst {
			locked, release := make(chan struct{}), make(chan struct{})
			go replace(func(user.Session) error { close(locked); <-release; return nil })
			<-locked
			go deleteCurrent()
			waitForLockWait(t, ctx, db, "%SELECT session_version, alert_mode FROM users%")
			close(release)
			if err := <-replaceResult; err != nil {
				t.Fatal(err)
			}
			if err := <-deleteResult; !errors.Is(err, application.ErrPushSessionRevoked) {
				t.Fatalf("stale delete: %v", err)
			}
		} else {
			// Block the head so deletion owns the user lock before replacement starts.
			tx, err := db.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(context.Background())
			if _, err := tx.Exec(ctx, `SELECT browser_id FROM browser_auth_heads WHERE browser_id=$1 FOR UPDATE`, browser); err != nil {
				t.Fatal(err)
			}
			go deleteCurrent()
			waitForLockWait(t, ctx, db, "%SELECT true FROM browser_auth_heads WHERE browser_id=%")
			go replace(issue)
			waitForLockWait(t, ctx, db, "%SELECT id, session_version FROM users WHERE id=ANY%")
			if err := tx.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			if err := <-deleteResult; err != nil {
				t.Fatal(err)
			}
			if err := <-replaceResult; err != nil {
				t.Fatal(err)
			}
		}
		var count int
		if err := db.QueryRow(ctx, `SELECT count(*) FROM push_subscriptions WHERE device_id=$1`, device).Scan(&count); err != nil {
			t.Fatal(err)
		}
		want := 0
		if count != want {
			t.Fatalf("replacementFirst=%v count=%d want=%d", replacementFirst, count, want)
		}
		if _, err := db.Exec(ctx, `DELETE FROM push_subscriptions WHERE user_id=$1`, owner); err != nil {
			t.Fatal(err)
		}
	}
}

func TestDeletePushSubscriptionSerializesWithBrowserReplacement(t *testing.T) {
	url := os.Getenv("ZWEI_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set ZWEI_TEST_DATABASE_URL for isolated PostgreSQL")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	db, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	codec, err := pushcrypto.New(make([]byte, 32), make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	repo := NewRepository(db, codec)
	owner, device := createPushTestUser(t, ctx, repo, db)
	defer db.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, owner)
	for _, replacementFirst := range []bool{true, false} {
		browser, generation, nextGeneration := uuid.New(), uuid.New(), uuid.New()
		defer db.Exec(context.Background(), `DELETE FROM browser_auth_heads WHERE browser_id=$1`, browser)
		oldHash, nextHash := sha256.Sum256([]byte(uuid.NewString())), sha256.Sum256([]byte(uuid.NewString()))
		issue := func(user.Session) error { return nil }
		if err := repo.CreateBrowserSession(ctx, browser, generation, owner, device, oldHash[:], 1, time.Now().Add(time.Hour), issue); err != nil {
			t.Fatal(err)
		}
		sub := application.PushSubscription{Endpoint: "https://fcm.googleapis.com/send/" + uuid.NewString(), P256DH: "key", Auth: "auth"}
		if err := repo.StorePushSubscription(ctx, owner, device, 1, browser, generation, sub); err != nil {
			t.Fatal(err)
		}
		for _, binding := range [][2]uuid.UUID{{uuid.New(), generation}, {browser, uuid.New()}} {
			if err := repo.DeletePushSubscription(ctx, owner, device, 1, binding[0], binding[1], sub.Endpoint); !errors.Is(err, application.ErrPushSessionRevoked) {
				t.Fatalf("invalid browser binding: %v", err)
			}
		}
		if err := repo.DeletePushSubscription(ctx, owner, device, 1, browser, generation, sub.Endpoint+"-other"); err != nil {
			t.Fatal(err)
		}
		var before int
		if err := db.QueryRow(ctx, `SELECT count(*) FROM push_subscriptions WHERE user_id=$1 AND device_id=$2`, owner, device).Scan(&before); err != nil || before != 1 {
			t.Fatalf("nonmatching endpoint removed subscription: count=%d err=%v", before, err)
		}
		deletes, replacements := make(chan error, 1), make(chan error, 1)
		replace := func(callback func(user.Session) error) {
			replacements <- repo.ReplaceBrowserSession(ctx, browser, generation, oldHash[:], nextGeneration, owner, device, nextHash[:], 1, time.Now().Add(time.Hour), callback)
		}
		deleteEndpoint := func() {
			deletes <- repo.DeletePushSubscription(ctx, owner, device, 1, browser, generation, sub.Endpoint)
		}
		if replacementFirst {
			locked, release := make(chan struct{}), make(chan struct{})
			go replace(func(user.Session) error { close(locked); <-release; return nil })
			<-locked
			go deleteEndpoint()
			waitForLockWait(t, ctx, db, "%SELECT session_version, alert_mode FROM users%")
			close(release)
		} else {
			tx, err := db.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(context.Background())
			if _, err := tx.Exec(ctx, `SELECT browser_id FROM browser_auth_heads WHERE browser_id=$1 FOR UPDATE`, browser); err != nil {
				t.Fatal(err)
			}
			go deleteEndpoint()
			waitForLockWait(t, ctx, db, "%SELECT true FROM browser_auth_heads WHERE browser_id=%")
			go replace(issue)
			waitForLockWait(t, ctx, db, "%SELECT id, session_version FROM users WHERE id=ANY%")
			if err := tx.Commit(ctx); err != nil {
				t.Fatal(err)
			}
		}
		if err := <-replacements; err != nil {
			t.Fatal(err)
		}
		err := <-deletes
		if replacementFirst && !errors.Is(err, application.ErrPushSessionRevoked) {
			t.Fatalf("stale delete: %v", err)
		}
		if !replacementFirst && err != nil {
			t.Fatal(err)
		}
		var count int
		if err := db.QueryRow(ctx, `SELECT count(*) FROM push_subscriptions WHERE user_id=$1 AND device_id=$2`, owner, device).Scan(&count); err != nil {
			t.Fatal(err)
		}
		want := 0
		if count != want {
			t.Fatalf("replacementFirst=%v count=%d want=%d", replacementFirst, count, want)
		}
		if _, err := db.Exec(ctx, `DELETE FROM push_subscriptions WHERE user_id=$1`, owner); err != nil {
			t.Fatal(err)
		}
	}
}

func TestStorePushSubscriptionSerializesWithBrowserChanges(t *testing.T) {
	url := os.Getenv("ZWEI_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set ZWEI_TEST_DATABASE_URL for isolated PostgreSQL")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	codec, err := pushcrypto.New(make([]byte, 32), make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	repo := NewRepository(db, codec)
	owner, device := createPushTestUser(t, ctx, repo, db)
	defer db.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, owner)
	for _, rotate := range []bool{false, true} {
		for _, changeFirst := range []bool{false, true} {
			browser, generation, nextGeneration := uuid.New(), uuid.New(), uuid.New()
			oldHash, nextHash := sha256.Sum256([]byte(uuid.NewString())), sha256.Sum256([]byte(uuid.NewString()))
			issue := func(user.Session) error { return nil }
			if err := repo.CreateBrowserSession(ctx, browser, generation, owner, device, oldHash[:], 1, time.Now().Add(time.Hour), issue); err != nil {
				t.Fatal(err)
			}
			sub := application.PushSubscription{Endpoint: "https://fcm.googleapis.com/send/" + uuid.NewString(), P256DH: "key", Auth: "auth"}
			for _, binding := range [][2]uuid.UUID{{uuid.New(), generation}, {browser, uuid.New()}, {owner, generation}} {
				if err := repo.StorePushSubscription(ctx, owner, device, 1, binding[0], binding[1], sub); !errors.Is(err, application.ErrPushSessionRevoked) {
					t.Fatalf("invalid browser binding accepted: %v", err)
				}
			}
			stores, changes := make(chan error, 1), make(chan error, 1)
			store := func() { stores <- repo.StorePushSubscription(ctx, owner, device, 1, browser, generation, sub) }
			change := func(callback func(user.Session) error) {
				if rotate {
					changes <- repo.RotateBrowserSession(ctx, browser, generation, oldHash[:], nextHash[:], time.Now().Add(time.Hour), callback)
				} else {
					changes <- repo.ReplaceBrowserSession(ctx, browser, generation, oldHash[:], nextGeneration, owner, device, nextHash[:], 1, time.Now().Add(time.Hour), callback)
				}
			}
			if changeFirst {
				locked, release := make(chan struct{}), make(chan struct{})
				go change(func(user.Session) error { close(locked); <-release; return nil })
				<-locked
				go store()
				waitForLockWait(t, ctx, db, "%SELECT session_version, alert_mode FROM users%")
				close(release)
			} else {
				tx, err := db.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer tx.Rollback(context.Background())
				if _, err := tx.Exec(ctx, `SELECT browser_id FROM browser_auth_heads WHERE browser_id=$1 FOR UPDATE`, browser); err != nil {
					t.Fatal(err)
				}
				go store()
				waitForLockWait(t, ctx, db, "%SELECT true FROM browser_auth_heads WHERE browser_id=%")
				go change(issue)
				if rotate {
					waitForLockWait(t, ctx, db, "%SELECT u.id FROM users u JOIN sessions%")
				} else {
					waitForLockWait(t, ctx, db, "%SELECT id, session_version FROM users WHERE id=ANY%")
				}
				if err := tx.Commit(ctx); err != nil {
					t.Fatal(err)
				}
			}
			if err := <-changes; err != nil {
				t.Fatalf("rotate=%v changeFirst=%v: %v", rotate, changeFirst, err)
			}
			err := <-stores
			if changeFirst && !rotate {
				if !errors.Is(err, application.ErrPushSessionRevoked) {
					t.Fatalf("stale store: %v", err)
				}
			} else if err != nil {
				t.Fatalf("store rotate=%v changeFirst=%v: %v", rotate, changeFirst, err)
			}
			var count int
			if err := db.QueryRow(ctx, `SELECT count(*) FROM push_subscriptions WHERE device_id=$1`, device).Scan(&count); err != nil {
				t.Fatal(err)
			}
			want := 1
			if !rotate {
				want = 0
			}
			if count != want {
				t.Fatalf("rotate=%v changeFirst=%v count=%d want=%d", rotate, changeFirst, count, want)
			}
			if _, err := db.Exec(ctx, `DELETE FROM push_subscriptions WHERE user_id=$1`, owner); err != nil {
				t.Fatal(err)
			}
		}
	}
}

func waitForLockWait(t *testing.T, ctx context.Context, db *pgxpool.Pool, queryPattern string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		var waiting bool
		if err := db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE $1)`, queryPattern).Scan(&waiting); err != nil {
			t.Fatalf("inspect PostgreSQL lock wait: %v", err)
		}
		if waiting {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("did not observe PostgreSQL lock wait for %q", queryPattern)
}

func createPushTestUser(t *testing.T, ctx context.Context, repository *Repository, db *pgxpool.Pool) (uuid.UUID, uuid.UUID) {
	t.Helper()
	name := uuid.NewString()
	userID, deviceID, err := repository.CreateUserWithDevice(ctx, application.CreateUserParams{
		Email: "push-" + name + "@example.test", PasswordHash: "not-a-real-password", DisplayName: "Push test", ClientDeviceID: "push-test-" + name, KYCStatus: user.KYCActive, EmailVerified: true,
	})
	if err != nil {
		t.Fatalf("create test account: %v", err)
	}
	if _, err := db.Exec(ctx, `UPDATE users SET alert_mode = 'notifications' WHERE id = $1`, userID); err != nil {
		t.Fatalf("enable test notifications: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO browser_auth_heads(browser_id,generation,user_id,current_refresh_hash) VALUES($1,$1,$1,decode(repeat('01',32),'hex'))`, userID); err != nil {
		t.Fatal(err)
	}
	return userID, deviceID
}

func createPushTestUserWithDevice(t *testing.T, ctx context.Context, repository *Repository, db *pgxpool.Pool) (uuid.UUID, uuid.UUID, error) {
	t.Helper()
	name := uuid.NewString()
	userID, deviceID, err := repository.CreateUserWithDevice(ctx, application.CreateUserParams{
		Email: "push-quota-" + name + "@example.test", PasswordHash: "not-a-real-password", DisplayName: "Push quota test", ClientDeviceID: "push-quota-test-" + name, KYCStatus: user.KYCActive, EmailVerified: true,
	})
	if err != nil {
		return uuid.Nil, uuid.Nil, err
	}
	if _, err := db.Exec(ctx, `UPDATE users SET alert_mode = 'notifications' WHERE id = $1`, userID); err != nil {
		return uuid.Nil, uuid.Nil, err
	}
	if _, err := db.Exec(ctx, `INSERT INTO browser_auth_heads(browser_id,generation,user_id,current_refresh_hash) VALUES($1,$1,$1,decode(repeat('01',32),'hex'))`, userID); err != nil {
		return uuid.Nil, uuid.Nil, err
	}
	return userID, deviceID, nil
}
