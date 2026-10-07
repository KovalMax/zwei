package postgres

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/KovalMax/zwei/services/realtime/internal/application"
	"github.com/KovalMax/zwei/services/shared/messaging"
)

func TestReconciliationRepositoryReturnsAuthorizedForwardBoundedMessages(t *testing.T) {
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

	ownerID, peerID, outsiderID, conversationID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	lowID, highID := orderedIDs(ownerID, peerID)
	if _, err := db.Exec(ctx, `INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, 'integration', 'Owner'), ($3, $4, 'integration', 'Peer'), ($5, $6, 'integration', 'Outsider')`, ownerID, ownerID.String()+"@integration.test", peerID, peerID.String()+"@integration.test", outsiderID, outsiderID.String()+"@integration.test"); err != nil {
		t.Fatalf("insert users: %v", err)
	}
	defer func() {
		_, _ = db.Exec(context.Background(), `DELETE FROM users WHERE id = ANY($1)`, []uuid.UUID{ownerID, peerID, outsiderID})
	}()
	if _, err := db.Exec(ctx, `INSERT INTO conversations (id, user_low_id, user_high_id, next_sequence) VALUES ($1, $2, $3, 1)`, conversationID, lowID, highID); err != nil {
		t.Fatalf("insert conversation: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2), ($1, $3)`, conversationID, ownerID, peerID); err != nil {
		t.Fatalf("insert members: %v", err)
	}

	sender := messaging.NewSender(db, "reconciliation-test-key")
	for index := 1; index <= 3; index++ {
		if _, _, err := sender.Send(ctx, messaging.SendRequest{SenderID: ownerID, ConversationID: conversationID, ClientMessageID: fmt.Sprintf("reconcile-%d", index), Body: fmt.Sprintf("message %d", index)}); err != nil {
			t.Fatalf("send message %d: %v", index, err)
		}
	}
	if _, err := db.Exec(ctx, `INSERT INTO user_read_cursors (user_id, conversation_id, last_read_sequence, unread_count) VALUES ($1, $2, 1, 2), ($3, $2, 2, 0) ON CONFLICT (user_id, conversation_id) DO UPDATE SET last_read_sequence = EXCLUDED.last_read_sequence, unread_count = EXCLUDED.unread_count`, ownerID, conversationID, peerID); err != nil {
		t.Fatalf("insert cursors: %v", err)
	}

	repository := NewReconciliationRepository(db, "reconciliation-test-key")
	result, err := repository.Reconcile(ctx, ownerID, conversationID, 1, 1)
	if err != nil {
		t.Fatalf("Reconcile() error = %v", err)
	}
	if result.HighWatermark != 3 || result.OwnReadSequence != 1 || result.PeerReadSequence != 2 || !result.HasMore || result.NextAfterSequence != 2 {
		t.Fatalf("reconciliation metadata = %+v", result)
	}
	if len(result.Messages) != 1 || result.Messages[0].Sequence != 2 || result.Messages[0].Body != "message 2" {
		t.Fatalf("reconciliation messages = %+v", result.Messages)
	}
	if _, err := repository.Reconcile(ctx, outsiderID, conversationID, 0, 1); err == nil {
		t.Fatal("unauthorized reconciliation succeeded")
	}

	// Hold the messages relation so reconciliation pauses before reading it.
	// Revoke membership while it is paused, then release it. With separate
	// authorization and message queries, this ordering used to expose messages
	// using authorization from before the removal commit.
	blocker, err := db.Begin(ctx)
	if err != nil {
		t.Fatalf("begin messages lock: %v", err)
	}
	defer func() { _ = blocker.Rollback(context.Background()) }()
	if _, err := blocker.Exec(ctx, `LOCK TABLE messages IN ACCESS EXCLUSIVE MODE`); err != nil {
		t.Fatalf("lock messages: %v", err)
	}
	raceResult := make(chan error, 1)
	go func() {
		_, reconcileErr := repository.Reconcile(ctx, ownerID, conversationID, 0, 10)
		raceResult <- reconcileErr
	}()

	deadline := time.Now().Add(5 * time.Second)
	for {
		var waiting bool
		if err := db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%authorized AS (%')`).Scan(&waiting); err != nil {
			t.Fatalf("inspect blocked reconciliation: %v", err)
		}
		if waiting {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("reconciliation did not block on messages relation")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, err := db.Exec(ctx, `UPDATE conversation_members SET active = false, left_at = now() WHERE conversation_id = $1 AND user_id = $2 AND active`, conversationID, ownerID); err != nil {
		t.Fatalf("remove member: %v", err)
	}
	if err := blocker.Commit(ctx); err != nil {
		t.Fatalf("release messages lock: %v", err)
	}
	if err := <-raceResult; err == nil || err.Error() != "conversation not found" {
		t.Fatalf("reconciliation after committed removal error = %v, want conversation not found", err)
	}
	if result, err := repository.Reconcile(ctx, ownerID, conversationID, 0, 10); err == nil || len(result.Messages) != 0 {
		t.Fatalf("inactive member received reconciliation: result=%+v err=%v", result, err)
	}
}

func TestGroupReconciliationCursorsRespectMembershipVisibility(t *testing.T) {
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

	ownerID, prejoinID, postjoinID, inactiveID, noCursorID, conversationID := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	userIDs := []uuid.UUID{ownerID, prejoinID, postjoinID, inactiveID, noCursorID}
	for i, userID := range userIDs {
		if _, err := db.Exec(ctx, `INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, 'integration', 'Group member')`, userID, fmt.Sprintf("%s-%d@integration.test", userID, i)); err != nil {
			t.Fatalf("insert user: %v", err)
		}
	}
	defer func() { _, _ = db.Exec(context.Background(), `DELETE FROM users WHERE id = ANY($1)`, userIDs) }()
	if _, err := db.Exec(ctx, `INSERT INTO conversations (id, kind, group_name, owner_id, next_sequence) VALUES ($1, 'group', 'Cursor test', $2, 1)`, conversationID, ownerID); err != nil {
		t.Fatalf("insert group: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO conversation_members (conversation_id, user_id, active, left_at, visible_from_sequence) VALUES ($1,$2,true,NULL,1),($1,$3,true,NULL,3),($1,$4,true,NULL,2),($1,$5,false,now(),1),($1,$6,true,NULL,2)`, conversationID, ownerID, prejoinID, postjoinID, inactiveID, noCursorID); err != nil {
		t.Fatalf("insert group members: %v", err)
	}
	sender := messaging.NewSender(db, "group-reconciliation-test-key")
	for i := 1; i <= 3; i++ {
		if _, _, err := sender.Send(ctx, messaging.SendRequest{SenderID: ownerID, ConversationID: conversationID, ClientMessageID: fmt.Sprintf("group-reconcile-%d", i), Body: fmt.Sprintf("message %d", i)}); err != nil {
			t.Fatalf("send message: %v", err)
		}
	}
	if _, err := db.Exec(ctx, `UPDATE user_read_cursors SET last_read_sequence = 3 WHERE conversation_id = $1 AND user_id = $2`, conversationID, prejoinID); err != nil {
		t.Fatalf("set prejoin cursor: %v", err)
	}
	if _, err := db.Exec(ctx, `UPDATE user_read_cursors SET last_read_sequence = 3 WHERE conversation_id = $1 AND user_id = $2`, conversationID, postjoinID); err != nil {
		t.Fatalf("set postjoin cursor: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO user_read_cursors (user_id, conversation_id, last_read_sequence, unread_count) VALUES ($1, $2, 3, 0)`, inactiveID, conversationID); err != nil {
		t.Fatalf("insert inactive cursor fixture: %v", err)
	}
	if _, err := db.Exec(ctx, `DELETE FROM user_read_cursors WHERE user_id = $1 AND conversation_id = $2`, noCursorID, conversationID); err != nil {
		t.Fatalf("remove zero cursor fixture: %v", err)
	}

	result, err := NewReconciliationRepository(db, "group-reconciliation-test-key").Reconcile(ctx, ownerID, conversationID, 0, 10)
	if err != nil {
		t.Fatalf("reconcile group: %v", err)
	}
	if result.PeerReadSequence != 0 {
		t.Fatalf("group peer_read_sequence = %d, want 0", result.PeerReadSequence)
	}
	cursors := make(map[uuid.UUID]application.PeerReadCursor, len(result.PeerReadCursors))
	for _, cursor := range result.PeerReadCursors {
		cursors[cursor.UserID] = cursor
	}
	if len(cursors) != 3 {
		t.Fatalf("active other-member cursors = %+v, want prejoin, postjoin, and zero-cursor only", result.PeerReadCursors)
	}
	prejoin := cursors[prejoinID]
	postjoin := cursors[postjoinID]
	zero := cursors[noCursorID]
	if prejoin.Sequence != 3 || prejoin.VisibleFromSequence != 3 || prejoin.VisibleFromSequence <= 2 {
		t.Fatalf("prejoin cursor qualifies for sequence 2: %+v", prejoin)
	}
	if postjoin.Sequence != 3 || postjoin.VisibleFromSequence != 2 || postjoin.VisibleFromSequence > 2 {
		t.Fatalf("postjoin cursor does not qualify for sequence 2: %+v", postjoin)
	}
	if zero.Sequence != 0 || zero.VisibleFromSequence != 2 {
		t.Fatalf("missing cursor should be represented as zero: %+v", zero)
	}
	if _, exists := cursors[inactiveID]; exists {
		t.Fatalf("inactive member cursor leaked: %+v", cursors[inactiveID])
	}
	if _, exists := cursors[ownerID]; exists {
		t.Fatal("sender was included in peer cursors")
	}
}
