package postgres

import (
	"context"
	"crypto/sha256"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/KovalMax/zwei/services/auth/internal/application"
	"github.com/KovalMax/zwei/services/auth/internal/domain/user"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestBrowserDiscoveryLiveAndAmbiguous(t *testing.T) {
	url := os.Getenv("ZWEI_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set ZWEI_TEST_DATABASE_URL for PostgreSQL integration")
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
	b1, b2, g1, g2 := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	defer db.Exec(context.Background(), `DELETE FROM browser_auth_heads WHERE browser_id=ANY($1::uuid[])`, []uuid.UUID{b1, b2})
	h1, h2 := sha256.Sum256([]byte("proof-one")), sha256.Sum256([]byte("proof-two"))
	issue := func(user.Session) error { return nil }
	if err := repo.CreateBrowserSession(ctx, b1, g1, id, device, h1[:], 1, time.Now().Add(time.Hour), issue); err != nil {
		t.Fatal(err)
	}
	credential, err := application.DiscoverBrowserCredential(ctx, repo, []string{"wrong", "proof-one", "proof-one"})
	if err != nil || credential.BrowserID != b1 || credential.Generation != g1 {
		t.Fatalf("live discovery: %v", err)
	}
	if err := repo.CreateBrowserSession(ctx, b2, g2, id, device, h2[:], 1, time.Now().Add(time.Hour), issue); err != nil {
		t.Fatal(err)
	}
	candidates, err := application.DiscoverBrowserCandidates(ctx, repo, []string{"proof-one", "proof-two", "wrong"})
	if err != nil || len(candidates) != 2 {
		t.Fatalf("candidate discovery: %v, count %d", err, len(candidates))
	}
	selected, err := application.SelectBrowserCandidate(candidates, b2, g2)
	if err != nil || selected.RefreshToken != "proof-two" {
		t.Fatalf("candidate selection: %v", err)
	}
	if _, err := application.DiscoverBrowserCredential(ctx, repo, []string{"proof-one", "proof-two"}); !errors.Is(err, application.ErrRefreshToken) {
		t.Fatalf("ambiguous discovery: %v", err)
	}
	next := sha256.Sum256([]byte("next-proof"))
	if err := repo.RotateBrowserSession(ctx, b1, g1, h1[:], next[:], time.Now().Add(time.Hour), issue); err != nil {
		t.Fatal(err)
	}
	if _, err := application.DiscoverBrowserCredential(ctx, repo, []string{"proof-one"}); !errors.Is(err, application.ErrNoLiveBrowserHead) {
		t.Fatalf("stale proof: %v", err)
	}
	if _, err := db.Exec(ctx, `UPDATE sessions SET expires_at=now()-interval '1 second' WHERE refresh_token_hash=$1`, h2[:]); err != nil {
		t.Fatal(err)
	}
	if _, err := application.DiscoverBrowserCredential(ctx, repo, []string{"proof-two"}); !errors.Is(err, application.ErrNoLiveBrowserHead) {
		t.Fatalf("expired proof: %v", err)
	}
	if err := repo.LogoutBrowserSession(ctx, b1, g1, id, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := application.DiscoverBrowserCredential(ctx, repo, []string{"next-proof"}); !errors.Is(err, application.ErrNoLiveBrowserHead) {
		t.Fatalf("logged out proof: %v", err)
	}
}
