package postgres

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/KovalMax/zwei/services/auth/internal/application"
	"github.com/KovalMax/zwei/services/auth/internal/domain/user"
)

func TestRefreshRotationAtomicity(t *testing.T) {
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
	// Only unique fixture rows are created and removed; unlike the push re-key
	// test, this does not mutate shared database-wide state.
	repo := NewRepository(db, nil)
	userID, deviceID := createPushTestUser(t, ctx, repo, db)
	defer db.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, userID)
	old := []byte(uuid.NewString())
	expires := time.Now().Add(time.Hour)
	if err := repo.CreateSession(ctx, userID, deviceID, old, 1, expires); err != nil {
		t.Fatal(err)
	}
	if err := repo.RotateRefreshToken(ctx, []byte(uuid.NewString()), []byte(uuid.NewString()), expires, func(user.Session) error { return nil }); !errors.Is(err, application.ErrRefreshToken) {
		t.Fatalf("unknown refresh token error = %v", err)
	}
	failure := errors.New("signing failed")
	if err := repo.RotateRefreshToken(ctx, old, []byte(uuid.NewString()), expires, func(user.Session) error { return failure }); !errors.Is(err, failure) {
		t.Fatalf("rollback error: %v", err)
	}
	start := make(chan struct{})
	results := make(chan error, 8)
	for i := 0; i < 8; i++ {
		go func() {
			<-start
			results <- repo.RotateRefreshToken(ctx, old, []byte(uuid.NewString()), expires, func(user.Session) error { return nil })
		}()
	}
	close(start)
	success := 0
	for i := 0; i < 8; i++ {
		err := <-results
		if err == nil {
			success++
		} else if !errors.Is(err, application.ErrRefreshToken) {
			t.Errorf("losing rotation error = %v", err)
		}
	}
	if success != 1 {
		t.Fatalf("successful rotations = %d, want 1", success)
	}
	var current []byte
	if err := db.QueryRow(ctx, `SELECT refresh_token_hash FROM sessions WHERE user_id=$1 AND revoked_at IS NULL`, userID).Scan(&current); err != nil {
		t.Fatal(err)
	}
	locked, release := make(chan struct{}), make(chan struct{})
	rotated := make(chan error, 1)
	go func() {
		rotated <- repo.RotateRefreshToken(ctx, current, []byte(uuid.NewString()), expires, func(user.Session) error {
			close(locked)
			<-release
			return nil
		})
	}()
	<-locked
	loggedOut := make(chan error, 1)
	go func() { loggedOut <- repo.RevokeAllSessions(ctx, userID) }()
	waitForLockWait(t, ctx, db, `%SET session_version = session_version + 1%`)
	close(release)
	if err := <-rotated; err != nil {
		t.Fatal(err)
	}
	if err := <-loggedOut; err != nil {
		t.Fatal(err)
	}
	var live int
	if err := db.QueryRow(ctx, `SELECT count(*) FROM sessions WHERE user_id=$1 AND revoked_at IS NULL`, userID).Scan(&live); err != nil || live != 0 {
		t.Fatalf("live sessions after logout = %d, error %v", live, err)
	}
}

func TestRefreshTokenOwnerIncludesHistoricalSessions(t *testing.T) {
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
	userID, deviceID := createPushTestUser(t, ctx, repo, db)
	defer db.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, userID)
	old, next := []byte(uuid.NewString()), []byte(uuid.NewString())
	if err := repo.CreateSession(ctx, userID, deviceID, old, 1, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := repo.RotateRefreshToken(ctx, old, next, time.Now().Add(time.Hour), func(user.Session) error { return nil }); err != nil {
		t.Fatal(err)
	}
	for _, hash := range [][]byte{old, next} {
		owner, err := repo.RefreshTokenOwner(ctx, hash)
		if err != nil || owner != userID {
			t.Fatalf("owner=%v err=%v", owner, err)
		}
	}
	owner, err := repo.RefreshTokenOwner(ctx, []byte(uuid.NewString()))
	if err != nil || owner != uuid.Nil {
		t.Fatalf("unknown owner=%v err=%v", owner, err)
	}
}

func TestRefreshCandidatesFailClosedAndRollback(t *testing.T) {
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
	userID, deviceID := createPushTestUser(t, ctx, repo, db)
	defer db.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, userID)
	a, b, unknown := []byte(uuid.NewString()), []byte(uuid.NewString()), []byte(uuid.NewString())
	expires := time.Now().Add(time.Hour)
	otherID, otherDevice := createPushTestUser(t, ctx, repo, db)
	defer db.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, otherID)
	if err := repo.CreateSession(ctx, userID, deviceID, a, 1, expires); err != nil {
		t.Fatal(err)
	}
	if err := repo.CreateSession(ctx, otherID, otherDevice, b, 1, expires); err != nil {
		t.Fatal(err)
	}
	issue := func(user.Session, []byte) error { return nil }
	if err := repo.RotateRefreshCandidates(ctx, [][]byte{a, b}, []byte(uuid.NewString()), expires, issue); !errors.Is(err, application.ErrRefreshToken) {
		t.Fatalf("ambiguous: %v", err)
	}
	failure := errors.New("issuer failure")
	if err := repo.RotateRefreshCandidates(ctx, [][]byte{unknown, a}, []byte(uuid.NewString()), expires, func(user.Session, []byte) error { return failure }); !errors.Is(err, failure) {
		t.Fatalf("rollback: %v", err)
	}
	if err := repo.RotateRefreshCandidates(ctx, [][]byte{unknown, a, a}, []byte(uuid.NewString()), expires, issue); err != nil {
		t.Fatalf("single live candidate after rollback: %v", err)
	}
	if err := repo.RotateRefreshCandidates(ctx, [][]byte{unknown, a}, []byte(uuid.NewString()), expires, issue); !errors.Is(err, application.ErrRefreshToken) {
		t.Fatalf("consumed candidate: %v", err)
	}
}

func TestRefreshCandidatesSameAccountSelectsNewest(t *testing.T) {
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
	a, b := []byte(uuid.NewString()), []byte(uuid.NewString())
	expires := time.Now().Add(time.Hour)
	for _, hash := range [][]byte{a, b} {
		if err := repo.CreateSession(ctx, id, device, hash, 1, expires); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec(ctx, `UPDATE sessions SET created_at = now() - interval '1 hour' WHERE refresh_token_hash = $1`, a); err != nil {
		t.Fatal(err)
	}
	called := false
	if err := repo.RotateRefreshCandidates(ctx, [][]byte{a, b}, []byte(uuid.NewString()), expires, func(session user.Session, selected []byte) error {
		called = true
		if session.UserID != id || string(selected) != string(b) {
			t.Error("wrong same-account candidate selected")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if !called {
		t.Fatal("issuer not called")
	}
	var live bool
	if err := db.QueryRow(ctx, `SELECT revoked_at IS NULL FROM sessions WHERE refresh_token_hash=$1`, a).Scan(&live); err != nil || !live {
		t.Fatalf("other session was revoked: %v", err)
	}
}
