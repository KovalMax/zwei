package postgres

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/KovalMax/zwei/services/realtime/internal/application"
)

func TestGroupCallLeaseSerializesWithMembershipRevocation(t *testing.T) {
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
	defer db.Close()
	if err := db.Ping(ctx); err != nil {
		t.Fatalf("ping database: %v", err)
	}

	ownerID, removedID, conversationID := uuid.New(), uuid.New(), uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, 'integration', 'Group owner'), ($3, $4, 'integration', 'Removed member')`, ownerID, ownerID.String()+"@integration.test", removedID, removedID.String()+"@integration.test"); err != nil {
		t.Fatalf("insert users: %v", err)
	}
	defer func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = db.Exec(cleanupCtx, `DELETE FROM conversations WHERE id = $1`, conversationID)
		_, _ = db.Exec(cleanupCtx, `DELETE FROM users WHERE id = ANY($1)`, []uuid.UUID{ownerID, removedID})
	}()
	if _, err := db.Exec(ctx, `INSERT INTO conversations (id, kind, group_name, owner_id, next_sequence) VALUES ($1, 'group', 'lease integration', $2, 1)`, conversationID, ownerID); err != nil {
		t.Fatalf("insert group conversation: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member')`, conversationID, ownerID, removedID); err != nil {
		t.Fatalf("insert group members: %v", err)
	}

	repository := NewGroupCallRepository(db)
	// Revocation-first: the lease's post-lock authorization must see the committed
	// inactive membership, rather than an earlier Redis projection snapshot.
	revokeTx, err := db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		t.Fatalf("begin first revocation: %v", err)
	}
	if _, err := revokeTx.Exec(ctx, `SELECT id FROM conversations WHERE id = $1 FOR UPDATE`, conversationID); err != nil {
		t.Fatalf("lock conversation for first revocation: %v", err)
	}
	if _, err := revokeTx.Exec(ctx, `UPDATE conversation_members SET active = false, left_at = now() WHERE conversation_id = $1 AND user_id = $2`, conversationID, removedID); err != nil {
		t.Fatalf("remove member: %v", err)
	}
	if _, err := revokeTx.Exec(ctx, `UPDATE conversations SET membership_revision = membership_revision + 1 WHERE id = $1`, conversationID); err != nil {
		t.Fatalf("advance revision: %v", err)
	}
	if err := revokeTx.Commit(ctx); err != nil {
		t.Fatalf("commit first revocation: %v", err)
	}
	if _, err := repository.BeginGroupCall(ctx, conversationID, removedID); !errors.Is(err, application.ErrCallNotAllowed) {
		t.Fatalf("removed member lease error = %v, want not allowed", err)
	}

	// Command-first: while a lease is held, a concurrent revocation must block.
	lease, err := repository.BeginGroupCall(ctx, conversationID, ownerID)
	if err != nil {
		t.Fatalf("begin command lease: %v", err)
	}
	blockerTx, err := db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		t.Fatalf("begin second revocation: %v", err)
	}
	var blockerPID int
	if err := blockerTx.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&blockerPID); err != nil {
		t.Fatalf("read revocation backend pid: %v", err)
	}
	revocationDone := make(chan error, 1)
	go func() {
		if _, execErr := blockerTx.Exec(ctx, `SELECT id FROM conversations WHERE id = $1 FOR UPDATE`, conversationID); execErr != nil {
			revocationDone <- execErr
			return
		}
		if _, execErr := blockerTx.Exec(ctx, `UPDATE conversation_members SET active = false, left_at = now() WHERE conversation_id = $1 AND user_id = $2`, conversationID, ownerID); execErr != nil {
			revocationDone <- execErr
			return
		}
		if _, execErr := blockerTx.Exec(ctx, `UPDATE conversations SET membership_revision = membership_revision + 1 WHERE id = $1`, conversationID); execErr != nil {
			revocationDone <- execErr
			return
		}
		revocationDone <- blockerTx.Commit(ctx)
	}()

	deadline := time.Now().Add(5 * time.Second)
	for {
		var waitEvent *string
		if err := db.QueryRow(ctx, `SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`, blockerPID).Scan(&waitEvent); err != nil {
			t.Fatalf("inspect revocation lock wait: %v", err)
		}
		if waitEvent != nil && *waitEvent == "Lock" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("revocation transaction never waited on the group-call membership lease")
		}
		time.Sleep(10 * time.Millisecond)
	}
	select {
	case err := <-revocationDone:
		t.Fatalf("revocation committed before group-call command lease: %v", err)
	default:
	}
	if lease.MembershipRevision() != 2 {
		t.Fatalf("command lease revision = %d, want 2", lease.MembershipRevision())
	}
	if err := lease.Commit(ctx); err != nil {
		t.Fatalf("commit command lease: %v", err)
	}
	if err := <-revocationDone; err != nil {
		t.Fatalf("revocation after command lease: %v", err)
	}
}
