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

func TestBrowserLogoutReceipt(t *testing.T) {
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
	refresh, receipt, wrong := make([]byte, 32), make([]byte, 32), make([]byte, 32)
	refresh[0], receipt[0], wrong[0] = 1, 2, 3
	if err := repo.CreateBrowserSession(ctx, browser, generation, id, device, refresh, 1, time.Now().Add(time.Hour), func(user.Session) error { return nil }); err != nil {
		t.Fatal(err)
	}
	// A duplicate receipt forces the final insert to fail; all revocation must roll back.
	if _, err := db.Exec(ctx, `INSERT INTO browser_logout_receipts (receipt_hash,browser_id,generation,user_id,expires_at) VALUES ($1,$2,$3,$4,$5)`, receipt, browser, generation, id, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := repo.LogoutBrowserSessionWithReceipt(ctx, browser, generation, id, 1, receipt, time.Now().Add(time.Hour)); err == nil {
		t.Fatal("duplicate receipt accepted")
	}
	var version int64
	var live int
	if err := db.QueryRow(ctx, `SELECT session_version FROM users WHERE id=$1`, id).Scan(&version); err != nil || version != 1 {
		t.Fatalf("rollback version %d: %v", version, err)
	}
	if err := db.QueryRow(ctx, `SELECT count(*) FROM sessions WHERE user_id=$1 AND revoked_at IS NULL`, id).Scan(&live); err != nil || live != 1 {
		t.Fatalf("rollback live %d: %v", live, err)
	}
	if _, err := db.Exec(ctx, `DELETE FROM browser_logout_receipts WHERE receipt_hash=$1`, receipt); err != nil {
		t.Fatal(err)
	}
	if err := repo.LogoutBrowserSessionWithReceipt(ctx, browser, generation, id, 1, receipt, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		b, g, u  uuid.UUID
		r, token []byte
		want     bool
	}{
		{browser, generation, id, receipt, refresh, true},
		{browser, generation, id, receipt, wrong, false},
		{browser, generation, uuid.New(), receipt, refresh, false},
		{browser, uuid.New(), id, receipt, refresh, false},
	} {
		got, err := repo.ReceiptMatchesRefresh(ctx, tc.b, tc.g, tc.u, tc.r, tc.token)
		if err != nil || got != tc.want {
			t.Fatalf("match=%v want=%v err=%v", got, tc.want, err)
		}
	}
	for _, args := range []struct {
		b, g, u uuid.UUID
		h       []byte
	}{{browser, generation, id, wrong}, {uuid.New(), generation, id, receipt}, {browser, uuid.New(), id, receipt}, {browser, generation, uuid.New(), receipt}} {
		if err := repo.VerifyBrowserLogoutReceipt(ctx, args.b, args.g, args.u, args.h); !errors.Is(err, application.ErrRefreshToken) {
			t.Fatalf("incorrect binding: %v", err)
		}
	}
	for i := 0; i < 2; i++ {
		if err := repo.VerifyBrowserLogoutReceipt(ctx, browser, generation, id, receipt); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.QueryRow(ctx, `SELECT session_version FROM users WHERE id=$1`, id).Scan(&version); err != nil || version != 2 {
		t.Fatalf("lookup changed version %d: %v", version, err)
	}
	if _, err := db.Exec(ctx, `UPDATE browser_logout_receipts SET expires_at=now()-interval '1 second' WHERE receipt_hash=$1`, receipt); err != nil {
		t.Fatal(err)
	}
	if err := repo.VerifyBrowserLogoutReceipt(ctx, browser, generation, id, receipt); !errors.Is(err, application.ErrRefreshToken) {
		t.Fatalf("expired receipt: %v", err)
	}
}

func TestLogoutReceiptPrunesBoundedExpiredBatch(t *testing.T) {
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
	refresh, receipt := make([]byte, 32), make([]byte, 32)
	refresh[0], receipt[0] = 1, 2
	if err := repo.CreateBrowserSession(ctx, browser, generation, id, device, refresh, 1, time.Now().Add(time.Hour), func(user.Session) error { return nil }); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 105; i++ {
		hash := make([]byte, 32)
		hash[0], hash[1] = 3, byte(i)
		if _, err := db.Exec(ctx, `INSERT INTO browser_logout_receipts (receipt_hash,browser_id,generation,user_id,expires_at) VALUES ($1,$2,$3,$4,now()-interval '1 hour')`, hash, browser, generation, id); err != nil {
			t.Fatal(err)
		}
	}
	if err := repo.LogoutBrowserSessionWithReceipt(ctx, browser, generation, id, 1, receipt, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	var remaining int
	if err := db.QueryRow(ctx, `SELECT count(*) FROM browser_logout_receipts WHERE user_id=$1 AND expires_at<=now()`, id).Scan(&remaining); err != nil || remaining != 5 {
		t.Fatalf("remaining=%d err=%v", remaining, err)
	}
}
