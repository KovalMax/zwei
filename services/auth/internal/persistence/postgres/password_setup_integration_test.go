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
		var id uuid.UUID
		_, err := pool.Exec(ctx, `INSERT INTO users(email,password_hash,display_name,kyc_status,activation_token_hash,activation_expires_at,activation_token_purpose) VALUES($1,NULL,'test',$2,$3,$4,'setup')`, uuid.NewString()+"@example.test", status, hash[:], now.Add(time.Hour))
		if err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(ctx, `SELECT id FROM users WHERE activation_token_hash=$1`, hash[:]).Scan(&id); err != nil {
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
				err := repository.SetPasswordFromSetup(ctx, hash[:], "bcrypt-hash", now)
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
		if password != "bcrypt-hash" || !verified || gotStatus != status || !tokenCleared {
			t.Fatalf("setup result: password=%q verified=%v status=%v tokenCleared=%v", password, verified, gotStatus, tokenCleared)
		}
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
