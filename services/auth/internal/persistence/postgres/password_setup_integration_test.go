package postgres

import (
	"context"
	"crypto/sha256"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/KovalMax/zwei/services/auth/internal/application"
	"github.com/KovalMax/zwei/services/auth/internal/domain/user"
)

func TestPasswordSetupMigrationAndAtomicConsumption(t *testing.T) {
	databaseURL := os.Getenv("ZWEI_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set ZWEI_TEST_DATABASE_URL for PostgreSQL integration")
	}
	ctx := context.Background()
	admin, err := pgx.Connect(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(ctx)
	schema := "password_setup_" + uuid.NewString()[:8]
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		t.Fatal(err)
	}
	defer admin.Exec(ctx, "DROP SCHEMA "+identifier+" CASCADE")
	if _, err := admin.Exec(ctx, "SET search_path TO "+identifier); err != nil {
		t.Fatal(err)
	}
	_, err = admin.Exec(ctx, `CREATE TABLE schema_migrations(version text PRIMARY KEY);
CREATE TABLE users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text UNIQUE NOT NULL,
 password_hash text NOT NULL, display_name text NOT NULL, kyc_status smallint NOT NULL,
 email_verified_at timestamptz, activation_token_hash bytea, activation_expires_at timestamptz,
 session_version bigint NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE devices (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), client_device_id text NOT NULL, name text, last_seen_at timestamptz, revoked_at timestamptz, UNIQUE(user_id,client_device_id));
CREATE TABLE sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), device_id uuid NOT NULL REFERENCES devices(id), refresh_token_hash bytea UNIQUE NOT NULL, user_session_version bigint NOT NULL, expires_at timestamptz NOT NULL, revoked_at timestamptz, last_used_at timestamptz);
CREATE TABLE browser_auth_heads (browser_id uuid PRIMARY KEY, generation uuid NOT NULL, user_id uuid REFERENCES users(id), current_refresh_hash bytea UNIQUE, updated_at timestamptz NOT NULL DEFAULT now()
)`)
	if err != nil {
		t.Fatal(err)
	}
	migration, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "..", "migrations", "0029_password_setup_tokens.sql"))
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if _, err := admin.Exec(ctx, string(migration)); err != nil {
			t.Fatalf("migration run %d: %v", i, err)
		}
	}
	var indexDefinition string
	if err := admin.QueryRow(ctx, `SELECT indexdef FROM pg_indexes WHERE schemaname=$1 AND indexname='users_activation_token_hash_idx'`, schema).Scan(&indexDefinition); err != nil {
		t.Fatalf("activation-token lookup index: %v", err)
	}
	if !strings.Contains(indexDefinition, "activation_token_hash") || !strings.Contains(indexDefinition, "IS NOT NULL") {
		t.Fatalf("activation-token index definition = %q", indexDefinition)
	}

	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	repository := NewRepository(pool, nil)
	now := time.Now().UTC()
	for _, status := range []user.KYCStatus{user.KYCPending, user.KYCActive} {
		token := uuid.NewString()
		hash := sha256.Sum256([]byte(token))
		deviceClientID := "setup-device-" + uuid.NewString()
		var id uuid.UUID
		_, err := pool.Exec(ctx, `INSERT INTO users(email,password_hash,display_name,kyc_status,activation_token_hash,activation_expires_at,activation_token_purpose) VALUES($1,NULL,'test',$2,$3,$4,'setup')`, uuid.NewString()+"@example.test", status, hash[:], now.Add(time.Hour))
		if err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(ctx, `SELECT id FROM users WHERE activation_token_hash=$1`, hash[:]).Scan(&id); err != nil {
			t.Fatal(err)
		}
		var deviceID uuid.UUID
		if err := pool.QueryRow(ctx, `INSERT INTO devices(user_id,client_device_id) VALUES($1,$2) RETURNING id`, id, deviceClientID).Scan(&deviceID); err != nil {
			t.Fatal(err)
		}
		if err := repository.VerifyActivation(ctx, hash[:], now); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("legacy verification accepted setup token: %v", err)
		}
		var successes, rejected atomic.Int32
		var wg sync.WaitGroup
		for range 2 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				err := repository.CompletePasswordSetup(ctx, hash[:], "bcrypt-hash", deviceClientID, "Registration browser", uuid.New(), uuid.New(), testRefreshHash(), now.Add(time.Hour), now, func(user.Session) error { return nil })
				if err == nil {
					successes.Add(1)
				} else if errors.Is(err, application.ErrPasswordSetupInvalid) {
					rejected.Add(1)
				} else {
					t.Errorf("consume setup token: %v", err)
				}
			}()
		}
		wg.Wait()
		if successes.Load() != 1 || rejected.Load() != 1 {
			t.Fatalf("atomic token consumption successes=%d rejected=%d", successes.Load(), rejected.Load())
		}
		var password string
		var verified bool
		var gotStatus user.KYCStatus
		var tokenCleared bool
		if err := pool.QueryRow(ctx, `SELECT password_hash,email_verified_at IS NOT NULL,kyc_status,activation_token_hash IS NULL FROM users WHERE id=$1`, id).Scan(&password, &verified, &gotStatus, &tokenCleared); err != nil {
			t.Fatal(err)
		}
		if password != "bcrypt-hash" || !verified || gotStatus != user.KYCActive || !tokenCleared {
			t.Fatalf("setup result: password=%q verified=%v status=%v tokenCleared=%v", password, verified, gotStatus, tokenCleared)
		}
		var sessions, heads int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM sessions WHERE user_id=$1`, id).Scan(&sessions); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM browser_auth_heads WHERE user_id=$1`, id).Scan(&heads); err != nil {
			t.Fatal(err)
		}
		if sessions != 1 || heads != 1 {
			t.Fatalf("session issuance sessions=%d heads=%d", sessions, heads)
		}
	}

	// Cached clients use the legacy password-only route while current clients
	// use v2. Both routes must contend on the same one-use setup credential.
	legacyRaceToken := uuid.NewString()
	legacyRaceHash := sha256.Sum256([]byte(legacyRaceToken))
	legacyRaceDevice := "legacy-race-device-" + uuid.NewString()
	if _, err := pool.Exec(ctx, `INSERT INTO users(email,password_hash,display_name,kyc_status,activation_token_hash,activation_expires_at,activation_token_purpose) VALUES($1,NULL,'legacy race',$2,$3,$4,'setup')`, uuid.NewString()+"@example.test", user.KYCPending, legacyRaceHash[:], now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	var legacyRaceUser uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT id FROM users WHERE activation_token_hash=$1`, legacyRaceHash[:]).Scan(&legacyRaceUser); err != nil {
		t.Fatal(err)
	}
	results := make(chan error, 2)
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		results <- repository.SetPasswordFromSetup(ctx, legacyRaceHash[:], "legacy-password", now)
	}()
	go func() {
		defer wg.Done()
		results <- repository.CompletePasswordSetup(ctx, legacyRaceHash[:], "v2-password", legacyRaceDevice, "New browser", uuid.New(), uuid.New(), testRefreshHash(), now.Add(time.Hour), now, func(user.Session) error { return nil })
	}()
	wg.Wait()
	close(results)
	wins := 0
	for err := range results {
		if err == nil {
			wins++
		} else if !errors.Is(err, application.ErrPasswordSetupInvalid) {
			t.Fatalf("cross-version setup consumption: %v", err)
		}
	}
	if wins != 1 {
		t.Fatalf("cross-version setup consumption successes=%d", wins)
	}
	var storedPassword string
	var legacyRaceSessions int
	if err := pool.QueryRow(ctx, `SELECT password_hash FROM users WHERE id=$1`, legacyRaceUser).Scan(&storedPassword); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM sessions WHERE user_id=$1`, legacyRaceUser).Scan(&legacyRaceSessions); err != nil {
		t.Fatal(err)
	}
	if storedPassword != "legacy-password" && storedPassword != "v2-password" {
		t.Fatalf("cross-version password winner = %q", storedPassword)
	}
	if (storedPassword == "legacy-password" && legacyRaceSessions != 0) || (storedPassword == "v2-password" && legacyRaceSessions != 1) {
		t.Fatalf("session ownership did not match consuming route: password=%q sessions=%d", storedPassword, legacyRaceSessions)
	}

	// A setup link may be opened in a different browser. The token remains the
	// authority to finish setup; the new browser's device row is created atomically.
	newDeviceToken := uuid.NewString()
	newDeviceTokenHash := sha256.Sum256([]byte(newDeviceToken))
	newDeviceID := "setup-device-new-browser-" + uuid.NewString()
	deviceName := "Second browser"
	var newDeviceUser, registeredDevice uuid.UUID
	if err := pool.QueryRow(ctx, `INSERT INTO users(email,password_hash,display_name,kyc_status,activation_token_hash,activation_expires_at,activation_token_purpose) VALUES($1,NULL,'new device',$2,$3,$4,'setup') RETURNING id`, uuid.NewString()+"@example.test", user.KYCPending, newDeviceTokenHash[:], now.Add(time.Hour)).Scan(&newDeviceUser); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO devices(user_id,client_device_id,name) VALUES($1,$2,'Registration browser') RETURNING id`, newDeviceUser, "registered-device-"+uuid.NewString()).Scan(&registeredDevice); err != nil {
		t.Fatal(err)
	}
	newBrowser, newGeneration := uuid.New(), uuid.New()
	if err := repository.CompletePasswordSetup(ctx, newDeviceTokenHash[:], "new-device-password", newDeviceID, deviceName, newBrowser, newGeneration, testRefreshHash(), now.Add(time.Hour), now, func(user.Session) error { return nil }); err != nil {
		t.Fatalf("setup from a different browser: %v", err)
	}
	var createdDevice uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT id FROM devices WHERE user_id=$1 AND client_device_id=$2 AND name=$3`, newDeviceUser, newDeviceID, deviceName).Scan(&createdDevice); err != nil {
		t.Fatalf("new device was not created with requested name: %v", err)
	}
	var sessionDevice, headBrowser uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT device_id FROM sessions WHERE user_id=$1`, newDeviceUser).Scan(&sessionDevice); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT browser_id FROM browser_auth_heads WHERE user_id=$1`, newDeviceUser).Scan(&headBrowser); err != nil {
		t.Fatal(err)
	}
	if sessionDevice != createdDevice || headBrowser != newBrowser || registeredDevice == createdDevice {
		t.Fatalf("setup used wrong device/session/head: registered=%s created=%s session=%s browser=%s", registeredDevice, createdDevice, sessionDevice, headBrowser)
	}

	rollbackToken := uuid.NewString()
	rollbackHash := sha256.Sum256([]byte(rollbackToken))
	deviceClientID := "setup-device-" + uuid.NewString()
	var rollbackUser uuid.UUID
	if err := pool.QueryRow(ctx, `INSERT INTO users(email,password_hash,display_name,kyc_status,activation_token_hash,activation_expires_at,activation_token_purpose) VALUES($1,NULL,'rollback',$2,$3,$4,'setup') RETURNING id`, uuid.NewString()+"@example.test", user.KYCPending, rollbackHash[:], now.Add(time.Hour)).Scan(&rollbackUser); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO devices(user_id,client_device_id) VALUES($1,$2)`, rollbackUser, deviceClientID); err != nil {
		t.Fatal(err)
	}
	issueFailure := errors.New("access issuer failure")
	if err := repository.CompletePasswordSetup(ctx, rollbackHash[:], "must-rollback", deviceClientID, "Rollback browser", uuid.New(), uuid.New(), testRefreshHash(), now.Add(time.Hour), now, func(user.Session) error { return issueFailure }); !errors.Is(err, issueFailure) {
		t.Fatalf("issuance failure=%v", err)
	}
	var rollbackPassword *string
	var rollbackVerified bool
	var rollbackStatus user.KYCStatus
	var rollbackSessions, rollbackHeads int
	if err := pool.QueryRow(ctx, `SELECT password_hash,email_verified_at IS NOT NULL,kyc_status FROM users WHERE id=$1`, rollbackUser).Scan(&rollbackPassword, &rollbackVerified, &rollbackStatus); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM sessions WHERE user_id=$1`, rollbackUser).Scan(&rollbackSessions); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM browser_auth_heads WHERE user_id=$1`, rollbackUser).Scan(&rollbackHeads); err != nil {
		t.Fatal(err)
	}
	if rollbackPassword != nil || rollbackVerified || rollbackStatus != user.KYCPending || rollbackSessions != 0 || rollbackHeads != 0 {
		t.Fatalf("issuance failure did not rollback: password=%v verified=%v status=%v sessions=%d heads=%d", rollbackPassword, rollbackVerified, rollbackStatus, rollbackSessions, rollbackHeads)
	}
	legacyToken := uuid.NewString()
	legacyHash := sha256.Sum256([]byte(legacyToken))
	if _, err := pool.Exec(ctx, `INSERT INTO users(email,password_hash,display_name,kyc_status,activation_token_hash,activation_expires_at) VALUES($1,'existing-hash','legacy', $2,$3,$4)`, uuid.NewString()+"@example.test", user.KYCActive, legacyHash[:], now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := repository.VerifyActivation(ctx, legacyHash[:], now); err != nil {
		t.Fatalf("legacy activation token was not accepted: %v", err)
	}
}

func testRefreshHash() []byte {
	first, second := uuid.New(), uuid.New()
	return append(first[:], second[:]...)
}
