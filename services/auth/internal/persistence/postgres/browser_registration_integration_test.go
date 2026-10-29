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

func TestBrowserInvitationRegistrationRollbackAndReplacement(t *testing.T) {
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
	owner, device := createPushTestUser(t, ctx, repo, db)
	defer db.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, owner)
	browser, generation := uuid.New(), uuid.New()
	defer db.Exec(context.Background(), `DELETE FROM browser_auth_heads WHERE browser_id=$1`, browser)
	oldToken := uuid.NewString()
	oldHash := sha256.Sum256([]byte(oldToken))
	if err := repo.CreateBrowserSession(ctx, browser, generation, owner, device, oldHash[:], 1, time.Now().Add(time.Hour), func(user.Session) error { return nil }); err != nil {
		t.Fatal(err)
	}
	email := uuid.NewString() + "@example.test"
	invite := sha256.Sum256([]byte(uuid.NewString()))
	if _, err := db.Exec(ctx, `INSERT INTO invitation_codes(email,code_hash,created_by,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')`, email, invite[:], owner); err != nil {
		t.Fatal(err)
	}
	defer db.Exec(context.Background(), `DELETE FROM invitation_codes WHERE code_hash=$1`, invite[:])
	defer db.Exec(context.Background(), `DELETE FROM users WHERE email=$1`, email)
	p := application.CreateUserParams{Email: email, PasswordHash: "hash", DisplayName: "Invited", ClientDeviceID: "device", InvitationCode: invite[:]}
	current := &application.BrowserCredential{BrowserID: browser, Generation: generation, RefreshToken: oldToken}
	next := sha256.Sum256([]byte(uuid.NewString()))
	newGeneration := uuid.New()
	failure := errors.New("issue failed")
	if err := repo.RegisterBrowserInvitation(ctx, p, current, browser, newGeneration, next[:], time.Now().Add(time.Hour), func(user.Session) error { return failure }); !errors.Is(err, failure) {
		t.Fatalf("issue failure: %v", err)
	}
	var users int
	var redeemed bool
	if err := db.QueryRow(ctx, `SELECT (SELECT count(*) FROM users WHERE email=$1), (SELECT redeemed_at IS NOT NULL FROM invitation_codes WHERE code_hash=$2)`, email, invite[:]).Scan(&users, &redeemed); err != nil || users != 0 || redeemed {
		t.Fatalf("rollback users=%d redeemed=%v err=%v", users, redeemed, err)
	}
	if err := repo.RegisterBrowserInvitation(ctx, p, current, browser, newGeneration, next[:], time.Now().Add(time.Hour), func(user.Session) error { return nil }); err != nil {
		t.Fatal(err)
	}
	var status user.KYCStatus
	var verified bool
	if err := db.QueryRow(ctx, `SELECT kyc_status,email_verified_at IS NOT NULL FROM users WHERE email=$1`, email).Scan(&status, &verified); err != nil || status != user.KYCActive || !verified {
		t.Fatalf("invited account status=%v verified=%v err=%v", status, verified, err)
	}
	if err := repo.RegisterBrowserInvitation(ctx, p, current, browser, uuid.New(), next[:], time.Now().Add(time.Hour), func(user.Session) error { return nil }); !errors.Is(err, application.ErrRefreshToken) {
		t.Fatalf("stale proof: %v", err)
	}
	var actual uuid.UUID
	if err := db.QueryRow(ctx, `SELECT generation FROM browser_auth_heads WHERE browser_id=$1`, browser).Scan(&actual); err != nil || actual != newGeneration {
		t.Fatalf("head=%v err=%v", actual, err)
	}
}
