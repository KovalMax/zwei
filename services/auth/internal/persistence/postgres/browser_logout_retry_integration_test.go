package postgres

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/KovalMax/zwei/services/auth/internal/application"
	"github.com/KovalMax/zwei/services/auth/internal/domain/user"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestBrowserLogoutRetryProof(t *testing.T) {
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
	repo := NewRepository(db, nil)
	id, device := createPushTestUser(t, ctx, repo, db)
	defer db.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, id)
	browser, generation := uuid.New(), uuid.New()
	defer db.Exec(context.Background(), `DELETE FROM browser_auth_heads WHERE browser_id=$1`, browser)
	hash := make([]byte, 32)
	hash[0] = 1
	if err = repo.CreateBrowserSession(ctx, browser, generation, id, device, hash, 1, time.Now().Add(time.Hour), func(user.Session) error { return nil }); err != nil {
		t.Fatal(err)
	}
	bad := make([]byte, 32)
	bad[0] = 2
	for _, args := range []struct {
		b, g, u uuid.UUID
		h       []byte
	}{{browser, generation, id, bad}, {browser, uuid.New(), id, hash}, {browser, generation, uuid.New(), hash}} {
		if err = repo.LogoutBrowserSessionWithProof(ctx, args.b, args.g, args.u, args.h); !errors.Is(err, application.ErrRefreshToken) {
			t.Fatalf("invalid proof: %v", err)
		}
	}
	receipt := make([]byte, 32)
	receipt[0] = 9
	if err = repo.LogoutBrowserSessionWithProofAndReceipt(ctx, browser, generation, id, hash, receipt, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	var version int64
	var live int
	if err = db.QueryRow(ctx, `SELECT session_version FROM users WHERE id=$1`, id).Scan(&version); err != nil || version != 2 {
		t.Fatalf("version %d: %v", version, err)
	}
	if err = db.QueryRow(ctx, `SELECT count(*) FROM sessions WHERE user_id=$1 AND revoked_at IS NULL`, id).Scan(&live); err != nil || live != 0 {
		t.Fatalf("live %d: %v", live, err)
	}
	if err = repo.LogoutBrowserSessionWithProof(ctx, browser, generation, id, hash); !errors.Is(err, application.ErrRefreshToken) {
		t.Fatalf("replay %v", err)
	}
	newBrowser, newGeneration := uuid.New(), uuid.New()
	defer db.Exec(context.Background(), `DELETE FROM browser_auth_heads WHERE browser_id=$1`, newBrowser)
	if err = repo.CreateBrowserSession(ctx, newBrowser, newGeneration, id, device, bad, 2, time.Now().Add(time.Hour), func(user.Session) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if err = repo.VerifyBrowserLogoutReceipt(ctx, browser, generation, id, receipt); err != nil {
		t.Fatalf("lost response confirmation: %v", err)
	}
	if err = repo.VerifyBrowserLogoutReceipt(ctx, browser, generation, id, bad); !errors.Is(err, application.ErrRefreshToken) {
		t.Fatalf("wrong receipt: %v", err)
	}
	if err = db.QueryRow(ctx, `SELECT count(*) FROM sessions WHERE user_id=$1 AND revoked_at IS NULL`, id).Scan(&live); err != nil || live != 1 {
		t.Fatalf("confirmation revoked new session: %d %v", live, err)
	}
}
