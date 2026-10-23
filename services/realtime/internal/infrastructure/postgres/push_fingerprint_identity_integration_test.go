package postgres

import (
	"bytes"
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/KovalMax/zwei/services/shared/pushcrypto"
)

func TestRealtimePushFingerprintIdentityRejectsChangedKeyWithoutMutation(t *testing.T) {
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
	configured := codecFor(4)
	changed := codecFor(5)
	if err := EnsurePushFingerprintKeyIdentity(ctx, db, configured); err != nil {
		t.Fatalf("initial identity claim: %v", err)
	}
	if err := EnsurePushFingerprintKeyIdentity(ctx, db, codecFor(4)); err != nil {
		t.Fatalf("same-key startup: %v", err)
	}
	if err := EnsurePushFingerprintKeyIdentity(ctx, db, changed); err == nil {
		t.Fatal("changed key was accepted")
	} else if err.Error() != "push fingerprint key identity mismatch" {
		t.Fatalf("changed-key error = %v", err)
	}
	want := configured.FingerprintKeyID()
	var stored []byte
	if err := db.QueryRow(ctx, `SELECT key_id FROM push_fingerprint_key_identity WHERE singleton=true`).Scan(&stored); err != nil || !bytes.Equal(stored, want[:]) {
		t.Fatalf("changed-key check mutated identity: err=%v", err)
	}
}
