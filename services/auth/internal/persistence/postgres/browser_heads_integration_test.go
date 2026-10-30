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

func TestBrowserHeadTransactions(t *testing.T) {
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
	browser, generation := uuid.New(), uuid.New()
	defer db.Exec(context.Background(), `DELETE FROM browser_auth_heads WHERE browser_id=$1`, browser)
	hash := func() []byte { a, b := uuid.New(), uuid.New(); return append(a[:], b[:]...) }
	old, next := hash(), hash()
	expiry := time.Now().Add(time.Hour)
	issue := func(user.Session) error { return nil }
	failure := errors.New("issuer failed")
	if err := repo.CreateBrowserSession(ctx, browser, generation, id, device, old, 1, expiry, func(user.Session) error { return failure }); !errors.Is(err, failure) {
		t.Fatalf("login rollback: %v", err)
	}
	var count int
	if err := db.QueryRow(ctx, `SELECT count(*) FROM browser_auth_heads WHERE browser_id=$1`, browser).Scan(&count); err != nil || count != 0 {
		t.Fatalf("rolled back login head count=%d: %v", count, err)
	}
	if err := repo.RotateBrowserSession(ctx, browser, generation, old, next, expiry, issue); !errors.Is(err, application.ErrRefreshToken) {
		t.Fatalf("missing head: %v", err)
	}
	if err := repo.CreateBrowserSession(ctx, browser, generation, id, device, old, 1, expiry, issue); err != nil {
		t.Fatal(err)
	}
	if err := repo.CreateBrowserSession(ctx, browser, uuid.New(), id, device, hash(), 1, expiry, issue); !errors.Is(err, application.ErrRefreshToken) {
		t.Fatalf("existing browser claimed without credential: %v", err)
	}
	if err := repo.RotateBrowserSession(ctx, browser, uuid.New(), old, next, expiry, issue); !errors.Is(err, application.ErrRefreshToken) {
		t.Fatalf("wrong generation: %v", err)
	}
	if err := repo.RotateBrowserSession(ctx, browser, generation, old, next, expiry, func(user.Session) error { return failure }); !errors.Is(err, failure) {
		t.Fatalf("rollback: %v", err)
	}
	start := make(chan struct{})
	results := make(chan error, 8)
	for i := 0; i < 8; i++ {
		go func() {
			<-start
			results <- repo.RotateBrowserSession(ctx, browser, generation, old, hash(), expiry, issue)
		}()
	}
	close(start)
	successes := 0
	for i := 0; i < 8; i++ {
		err := <-results
		if err == nil {
			successes++
		} else if !errors.Is(err, application.ErrRefreshToken) {
			t.Error(err)
		}
	}
	if successes != 1 {
		t.Fatalf("rotations succeeded: %d", successes)
	}
	var current []byte
	if err := db.QueryRow(ctx, `SELECT current_refresh_hash FROM browser_auth_heads WHERE browser_id=$1`, browser).Scan(&current); err != nil {
		t.Fatal(err)
	}
	if err := repo.LogoutBrowserSession(ctx, browser, generation, id, 2); !errors.Is(err, application.ErrRefreshToken) {
		t.Fatalf("wrong version logout: %v", err)
	}
	if err := db.QueryRow(ctx, `SELECT count(*) FROM sessions WHERE user_id=$1 AND revoked_at IS NULL`, id).Scan(&count); err != nil || count != 1 {
		t.Fatalf("stale logout revoked sessions: %d: %v", count, err)
	}
	other, otherDevice := createPushTestUser(t, ctx, repo, db)
	defer db.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, other)
	otherGeneration, otherHash := uuid.New(), hash()
	if err := repo.ReplaceBrowserSession(ctx, browser, generation, old, otherGeneration, other, otherDevice, otherHash, 1, expiry, issue); !errors.Is(err, application.ErrRefreshToken) {
		t.Fatalf("stale replacement: %v", err)
	}
	if err := repo.ReplaceBrowserSession(ctx, browser, uuid.New(), current, otherGeneration, other, otherDevice, otherHash, 1, expiry, issue); !errors.Is(err, application.ErrRefreshToken) {
		t.Fatalf("wrong generation replacement: %v", err)
	}
	if err := repo.ReplaceBrowserSession(ctx, browser, generation, current, otherGeneration, other, otherDevice, otherHash, 1, expiry, func(user.Session) error { return failure }); !errors.Is(err, failure) {
		t.Fatalf("replacement rollback: %v", err)
	}
	if err := repo.ReplaceBrowserSession(ctx, browser, generation, current, otherGeneration, other, otherDevice, otherHash, 1, expiry, issue); err != nil {
		t.Fatal(err)
	}
	if err := repo.LogoutBrowserSession(ctx, browser, generation, id, 1); !errors.Is(err, application.ErrRefreshToken) {
		t.Fatalf("stale other-user logout: %v", err)
	}
	if err := repo.LogoutBrowserSession(ctx, browser, otherGeneration, other, 1); err != nil {
		t.Fatal(err)
	}
	var owner *uuid.UUID
	if err := db.QueryRow(ctx, `SELECT user_id FROM browser_auth_heads WHERE browser_id=$1`, browser).Scan(&owner); err != nil || owner != nil {
		t.Fatalf("logout did not clear head: %v", err)
	}
	newBrowser := uuid.New()
	defer db.Exec(context.Background(), `DELETE FROM browser_auth_heads WHERE browser_id=$1`, newBrowser)
	if err := repo.CreateBrowserSession(ctx, newBrowser, uuid.New(), other, otherDevice, hash(), 2, expiry, issue); err != nil {
		t.Fatalf("fresh selector after logout: %v", err)
	}
}

// Both serialization orders use the same user lock as refresh; the bearer
// version and head binding are rechecked after acquiring it.
func TestBrowserLogoutAndContinueOrderings(t *testing.T) {
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
	for _, refreshFirst := range []bool{true, false} {
		id, device := createPushTestUser(t, ctx, repo, db)
		other, otherDevice := createPushTestUser(t, ctx, repo, db)
		browser, generation, sibling, siblingGen, independent, independentGen := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
		defer db.Exec(context.Background(), `DELETE FROM browser_auth_heads WHERE browser_id=ANY($1::uuid[])`, []uuid.UUID{browser, sibling, independent})
		defer db.Exec(context.Background(), `DELETE FROM users WHERE id=ANY($1::uuid[])`, []uuid.UUID{id, other})
		hash := func() []byte { a, b := uuid.New(), uuid.New(); return append(a[:], b[:]...) }
		old, next, siblingHash, otherHash := hash(), hash(), hash(), hash()
		expiry := time.Now().Add(time.Hour)
		issue := func(user.Session) error { return nil }
		for _, x := range []struct {
			b, g, u, d uuid.UUID
			h          []byte
		}{{browser, generation, id, device, old}, {sibling, siblingGen, id, device, siblingHash}, {independent, independentGen, other, otherDevice, otherHash}} {
			if err := repo.CreateBrowserSession(ctx, x.b, x.g, x.u, x.d, x.h, 1, expiry, issue); err != nil {
				t.Fatal(err)
			}
		}
		if refreshFirst {
			if err := repo.RotateBrowserSession(ctx, browser, generation, old, next, expiry, issue); err != nil {
				t.Fatal(err)
			}
		}
		if err := repo.LogoutBrowserSession(ctx, browser, generation, id, 1); err != nil {
			t.Fatal(err)
		}
		if err := repo.RotateBrowserSession(ctx, browser, generation, old, next, expiry, issue); !errors.Is(err, application.ErrRefreshToken) {
			t.Fatalf("post-logout continue: %v", err)
		}
		if err := repo.RotateBrowserSession(ctx, sibling, siblingGen, siblingHash, hash(), expiry, issue); !errors.Is(err, application.ErrRefreshToken) {
			t.Fatalf("sibling survived account logout: %v", err)
		}
		if err := repo.RotateBrowserSession(ctx, independent, independentGen, otherHash, hash(), expiry, issue); err != nil {
			t.Fatalf("independent account: %v", err)
		}
		if err := repo.LogoutBrowserSession(ctx, browser, generation, id, 1); !errors.Is(err, application.ErrRefreshToken) {
			t.Fatalf("replayed bearer: %v", err)
		}
	}
}

func TestBrowserLogoutWaitsForInFlightContinue(t *testing.T) {
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
	browser, generation := uuid.New(), uuid.New()
	defer db.Exec(context.Background(), `DELETE FROM browser_auth_heads WHERE browser_id=$1`, browser)
	defer db.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, id)
	hash := func() []byte { a, b := uuid.New(), uuid.New(); return append(a[:], b[:]...) }
	old, next := hash(), hash()
	expiry := time.Now().Add(time.Hour)
	if err := repo.CreateBrowserSession(ctx, browser, generation, id, device, old, 1, expiry, func(user.Session) error { return nil }); err != nil {
		t.Fatal(err)
	}
	locked, release := make(chan struct{}), make(chan struct{})
	refresh, logout := make(chan error, 1), make(chan error, 1)
	go func() {
		refresh <- repo.RotateBrowserSession(ctx, browser, generation, old, next, expiry, func(user.Session) error { close(locked); <-release; return nil })
	}()
	<-locked
	go func() { logout <- repo.LogoutBrowserSession(ctx, browser, generation, id, 1) }()
	close(release)
	if err := <-refresh; err != nil {
		t.Fatal(err)
	}
	if err := <-logout; err != nil {
		t.Fatal(err)
	}
	if err := repo.RotateBrowserSession(ctx, browser, generation, next, hash(), expiry, func(user.Session) error { return nil }); !errors.Is(err, application.ErrRefreshToken) {
		t.Fatalf("rotated proof survived logout: %v", err)
	}
}

func TestBrowserHeadCompetingReplacements(t *testing.T) {
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
	other, otherDevice := createPushTestUser(t, ctx, repo, db)
	defer db.Exec(context.Background(), `DELETE FROM users WHERE id=ANY($1::uuid[])`, []uuid.UUID{owner, other})
	browser, generation := uuid.New(), uuid.New()
	defer db.Exec(context.Background(), `DELETE FROM browser_auth_heads WHERE browser_id=$1`, browser)
	hash := func() []byte { a, b := uuid.New(), uuid.New(); return append(a[:], b[:]...) }
	current := hash()
	expiry := time.Now().Add(time.Hour)
	issue := func(user.Session) error { return nil }
	if err := repo.CreateBrowserSession(ctx, browser, generation, owner, device, current, 1, expiry, issue); err != nil {
		t.Fatal(err)
	}
	start, results := make(chan struct{}), make(chan error, 2)
	for i := 0; i < 2; i++ {
		go func() {
			<-start
			results <- repo.ReplaceBrowserSession(ctx, browser, generation, current, uuid.New(), other, otherDevice, hash(), 1, expiry, issue)
		}()
	}
	close(start)
	successes := 0
	for i := 0; i < 2; i++ {
		err := <-results
		if err == nil {
			successes++
		} else if !errors.Is(err, application.ErrRefreshToken) {
			t.Error(err)
		}
	}
	if successes != 1 {
		t.Fatalf("successful replacements: %d", successes)
	}
}
