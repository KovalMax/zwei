package postgres

import (
	"context"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/KovalMax/zwei/services/realtime/internal/application"
	"github.com/KovalMax/zwei/services/shared/messaging"
)

func TestUnreadCountRemainsExactDuringConcurrentSendAndRead(t *testing.T) {
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

	ownerID := uuid.New()
	recipientID := uuid.New()
	conversationID := uuid.New()
	lowID, highID := orderedIDs(ownerID, recipientID)
	if _, err := db.Exec(ctx, `INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, 'integration', 'Integration owner'), ($3, $4, 'integration', 'Integration recipient')`, ownerID, ownerID.String()+"@integration.test", recipientID, recipientID.String()+"@integration.test"); err != nil {
		t.Fatalf("insert users: %v", err)
	}
	defer func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = db.Exec(cleanupCtx, `DELETE FROM users WHERE id = ANY($1)`, []uuid.UUID{ownerID, recipientID})
	}()
	if _, err := db.Exec(ctx, `INSERT INTO conversations (id, user_low_id, user_high_id, next_sequence) VALUES ($1, $2, $3, 1)`, conversationID, lowID, highID); err != nil {
		t.Fatalf("insert conversation: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2), ($1, $3)`, conversationID, ownerID, recipientID); err != nil {
		t.Fatalf("insert conversation members: %v", err)
	}

	if _, err := db.Exec(ctx, `INSERT INTO user_read_cursors (user_id, conversation_id, last_read_sequence, unread_count) VALUES ($1, $2, 0, 0) ON CONFLICT (user_id, conversation_id) DO UPDATE SET last_read_sequence = 0, unread_count = 0`, recipientID, conversationID); err != nil {
		t.Fatalf("initialize read cursor: %v", err)
	}

	sender := messaging.NewSender(db, "integration-message-encryption-key")
	cursors := NewReadCursorRepository(db)
	for sequence := int64(1); sequence <= 16; sequence++ {
		start := make(chan struct{})
		var group sync.WaitGroup
		var sendErr, readErr error
		group.Add(2)
		go func() {
			defer group.Done()
			<-start
			_, _, sendErr = sender.Send(ctx, messaging.SendRequest{SenderID: ownerID, ConversationID: conversationID, ClientMessageID: fmt.Sprintf("integration-%d", sequence), Body: "concurrent message"})
		}()
		go func() {
			defer group.Done()
			<-start
			_, readErr = cursors.Advance(ctx, recipientID, conversationID, sequence)
		}()
		close(start)
		group.Wait()
		if sendErr != nil || readErr != nil {
			t.Fatalf("concurrent sequence %d: send=%v read=%v", sequence, sendErr, readErr)
		}
	}

	var cursor, unread int64
	if err := db.QueryRow(ctx, `SELECT last_read_sequence, unread_count FROM user_read_cursors WHERE user_id = $1 AND conversation_id = $2`, recipientID, conversationID).Scan(&cursor, &unread); err != nil {
		t.Fatalf("read final cursor: %v", err)
	}
	var expected int64
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM messages WHERE conversation_id = $1 AND sender_id <> $2 AND sequence > $3`, conversationID, recipientID, cursor).Scan(&expected); err != nil {
		t.Fatalf("count final unread messages: %v", err)
	}
	if unread != expected {
		t.Fatalf("unread_count = %d, expected exact count %d at cursor %d", unread, expected, cursor)
	}
}

func TestAdvanceWaitsForSendAndCountsCommittedPostCursorMessage(t *testing.T) {
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

	senderID, readerID, conversationID := uuid.New(), uuid.New(), uuid.New()
	lowID, highID := orderedIDs(senderID, readerID)
	if _, err := db.Exec(ctx, `INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, 'integration', 'Integration sender'), ($3, $4, 'integration', 'Integration reader')`, senderID, senderID.String()+"@integration.test", readerID, readerID.String()+"@integration.test"); err != nil {
		t.Fatalf("insert users: %v", err)
	}
	defer func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = db.Exec(cleanupCtx, `DELETE FROM users WHERE id = ANY($1)`, []uuid.UUID{senderID, readerID})
	}()
	if _, err := db.Exec(ctx, `INSERT INTO conversations (id, user_low_id, user_high_id, next_sequence) VALUES ($1, $2, $3, 2)`, conversationID, lowID, highID); err != nil {
		t.Fatalf("insert conversation: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2), ($1, $3)`, conversationID, senderID, readerID); err != nil {
		t.Fatalf("insert conversation members: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO messages (conversation_id, sender_id, client_message_id, sequence, ciphertext, nonce, encryption_key_version) VALUES ($1, $2, 'before-read', 1, $3, $3, 'integration')`, conversationID, senderID, []byte{1}); err != nil {
		t.Fatalf("insert initial message: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO user_read_cursors (user_id, conversation_id, last_read_sequence, unread_count) VALUES ($1, $2, 0, 0)`, readerID, conversationID); err != nil {
		t.Fatalf("initialize read cursor: %v", err)
	}

	cursors := NewReadCursorRepository(db)
	if cursor, err := cursors.Advance(ctx, readerID, conversationID, 1); err != nil || cursor.Cursor.Sequence != 1 {
		t.Fatalf("initial cursor advance = %+v, %v; want sequence 1", cursor, err)
	}

	// Reproduce Sender.Send's transaction boundary while holding both rows that
	// serialize a send and its unread increment. Keep the transaction uncommitted
	// until Advance is confirmed waiting on the conversation lock.
	sendTx, err := db.Begin(ctx)
	if err != nil {
		t.Fatalf("begin send transaction: %v", err)
	}
	defer sendTx.Rollback(ctx)
	if _, err := sendTx.Exec(ctx, `SELECT id FROM conversations WHERE id = $1 FOR UPDATE`, conversationID); err != nil {
		t.Fatalf("lock conversation: %v", err)
	}
	if _, err := sendTx.Exec(ctx, `SELECT user_id FROM user_read_cursors WHERE user_id = $1 AND conversation_id = $2 FOR UPDATE`, readerID, conversationID); err != nil {
		t.Fatalf("lock cursor: %v", err)
	}
	if _, err := sendTx.Exec(ctx, `UPDATE conversations SET next_sequence = next_sequence + 1 WHERE id = $1`, conversationID); err != nil {
		t.Fatalf("allocate message sequence: %v", err)
	}
	if _, err := sendTx.Exec(ctx, `INSERT INTO messages (conversation_id, sender_id, client_message_id, sequence, ciphertext, nonce, encryption_key_version) VALUES ($1, $2, 'after-read', 2, $3, $3, 'integration')`, conversationID, senderID, []byte{2}); err != nil {
		t.Fatalf("insert uncommitted message: %v", err)
	}
	if _, err := sendTx.Exec(ctx, `UPDATE user_read_cursors SET unread_count = unread_count + 1 WHERE user_id = $1 AND conversation_id = $2`, readerID, conversationID); err != nil {
		t.Fatalf("increment uncommitted unread count: %v", err)
	}

	advanceDone := make(chan struct{})
	var advanced application.ReadAdvance
	var advanceErr error
	go func() {
		defer close(advanceDone)
		advanced, advanceErr = cursors.Advance(ctx, readerID, conversationID, 1)
	}()

	// Observe PostgreSQL's lock wait instead of relying on a sleep to infer that
	// Advance has reached the lock. This makes the race setup deterministic.
	lockWaitObserved := false
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
		var waiting bool
		if err := db.QueryRow(ctx, `SELECT EXISTS (
			SELECT 1 FROM pg_stat_activity
			WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND state = 'active'
			AND query LIKE '%FROM conversations WHERE id = $1 FOR UPDATE%'
		)`).Scan(&waiting); err != nil {
			t.Fatalf("inspect PostgreSQL lock wait: %v", err)
		}
		if waiting {
			lockWaitObserved = true
			break
		}
		select {
		case <-advanceDone:
			t.Fatalf("Advance completed before the send transaction committed: cursor=%+v err=%v", advanced, advanceErr)
		case <-time.After(10 * time.Millisecond):
		case <-ctx.Done():
			t.Fatalf("wait for Advance lock: %v", ctx.Err())
		}
	}
	if !lockWaitObserved {
		t.Fatal("Advance did not block on the uncommitted send transaction")
	}
	if err := sendTx.Commit(ctx); err != nil {
		t.Fatalf("commit send transaction: %v", err)
	}
	select {
	case <-advanceDone:
	case <-ctx.Done():
		t.Fatalf("wait for cursor advancement: %v", ctx.Err())
	}
	if advanceErr != nil {
		t.Fatalf("advance cursor after send commit: %v", advanceErr)
	}
	if advanced.Cursor.Sequence != 1 || advanced.Cursor.VisibleFromSequence != 1 {
		t.Fatalf("advanced cursor = %+v, want monotonic sequence 1 and visible-from 1", advanced)
	}
	var finalSequence, unread int64
	if err := db.QueryRow(ctx, `SELECT last_read_sequence, unread_count FROM user_read_cursors WHERE user_id = $1 AND conversation_id = $2`, readerID, conversationID).Scan(&finalSequence, &unread); err != nil {
		t.Fatalf("read final cursor: %v", err)
	}
	if finalSequence != 1 {
		t.Fatalf("last_read_sequence = %d, want monotonic requested cursor 1", finalSequence)
	}
	if unread != 1 {
		t.Fatalf("unread_count = %d, want 1 for the committed message after the cursor", unread)
	}
}

func TestGroupReadRecipientsRequireActiveMembership(t *testing.T) {
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
	readerID, activePeerID, removedID, conversationID, directConversationID := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	userIDs := []uuid.UUID{readerID, activePeerID, removedID}
	for i, userID := range userIDs {
		if _, err := db.Exec(ctx, `INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, 'integration', 'Integration')`, userID, fmt.Sprintf("%s-%d@integration.test", userID, i)); err != nil {
			t.Fatalf("insert user: %v", err)
		}
	}
	defer func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = db.Exec(cleanupCtx, `DELETE FROM conversations WHERE id = ANY($1)`, []uuid.UUID{conversationID, directConversationID})
		_, _ = db.Exec(cleanupCtx, `DELETE FROM users WHERE id = ANY($1)`, userIDs)
	}()
	if _, err := db.Exec(ctx, `INSERT INTO conversations (id, kind, group_name, owner_id, next_sequence) VALUES ($1, 'group', 'Read test', $2, 1)`, conversationID, readerID); err != nil {
		t.Fatalf("insert group: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO conversation_members (conversation_id, user_id, active, left_at) VALUES ($1, $2, true, NULL), ($1, $3, true, NULL), ($1, $4, false, now())`, conversationID, readerID, activePeerID, removedID); err != nil {
		t.Fatalf("insert group members: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO messages (conversation_id, sender_id, client_message_id, sequence, ciphertext, nonce, encryption_key_version) VALUES ($1, $2, $3, 1, $4, $4, 'integration')`, conversationID, activePeerID, uuid.NewString(), []byte{1}); err != nil {
		t.Fatalf("insert group message: %v", err)
	}
	resolver := NewPresenceRepository(db)
	groupPeers, err := resolver.PeerIDs(ctx, readerID)
	if err != nil || len(groupPeers) != 1 || groupPeers[0] != activePeerID {
		t.Fatalf("active group peers = %v, err %v; want only active member %s", groupPeers, err, activePeerID)
	}
	activeMemberPeers, err := resolver.PeerIDs(ctx, activePeerID)
	if err != nil || len(activeMemberPeers) != 1 || activeMemberPeers[0] != readerID {
		t.Fatalf("active member peers = %v, err %v; want active member %s", activeMemberPeers, err, readerID)
	}
	removedMemberPeers, err := resolver.PeerIDs(ctx, removedID)
	if err != nil || len(removedMemberPeers) != 0 {
		t.Fatalf("removed member peers = %v, err %v; want no authorized peers", removedMemberPeers, err)
	}
	peers, err := resolver.ResolveReadRecipients(ctx, readerID, conversationID)
	if err != nil || len(peers) != 1 || peers[0] != activePeerID {
		t.Fatalf("active reader recipients = %v, err %v", peers, err)
	}
	if cursor, err := NewReadCursorRepository(db).Advance(ctx, readerID, conversationID, 1); err != nil || cursor.Cursor.Sequence != 1 || cursor.Cursor.VisibleFromSequence != 1 || len(cursor.RecipientIDs) != 1 || cursor.RecipientIDs[0] != activePeerID {
		t.Fatalf("advance active reader cursor: cursor=%+v err=%v", cursor, err)
	}
	if _, err := resolver.ResolveReadRecipients(ctx, removedID, conversationID); err == nil {
		t.Fatal("removed member was authorized to publish a read cursor")
	}
	if _, err := NewReadCursorRepository(db).Advance(ctx, removedID, conversationID, 1); err == nil {
		t.Fatal("removed member advanced a read cursor")
	}
	var cursorCount int
	if err := db.QueryRow(ctx, `SELECT count(*) FROM user_read_cursors WHERE user_id = $1 AND conversation_id = $2`, removedID, conversationID).Scan(&cursorCount); err != nil {
		t.Fatalf("count removed member cursors: %v", err)
	}
	if cursorCount != 0 {
		t.Fatalf("removed member cursor rows = %d, want 0", cursorCount)
	}

	lowID, highID := orderedIDs(readerID, activePeerID)
	if _, err := db.Exec(ctx, `INSERT INTO conversations (id, user_low_id, user_high_id, next_sequence) VALUES ($1, $2, $3, 1)`, directConversationID, lowID, highID); err != nil {
		t.Fatalf("insert direct conversation: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2), ($1, $3)`, directConversationID, readerID, activePeerID); err != nil {
		t.Fatalf("insert direct members: %v", err)
	}
	directPeers, err := resolver.ResolveReadRecipients(ctx, readerID, directConversationID)
	if err != nil || len(directPeers) != 1 || directPeers[0] != activePeerID {
		t.Fatalf("direct reader recipients = %v, err %v", directPeers, err)
	}
	directPeerIDs, err := resolver.PeerIDs(ctx, readerID)
	if err != nil || len(directPeerIDs) != 1 || directPeerIDs[0] != activePeerID {
		t.Fatalf("direct and group peers = %v, err %v; want one distinct peer %s", directPeerIDs, err, activePeerID)
	}

	// Hold the same conversation lock used by membership mutations, start a read,
	// and revoke its peer before releasing the lock. The read must observe the
	// committed revocation and cannot return the formerly authorized peer set.
	revokeTx, err := db.Begin(ctx)
	if err != nil {
		t.Fatalf("begin revocation transaction: %v", err)
	}
	defer revokeTx.Rollback(ctx)
	if _, err := revokeTx.Exec(ctx, `SELECT id FROM conversations WHERE id = $1 FOR UPDATE`, conversationID); err != nil {
		t.Fatalf("lock conversation for revocation: %v", err)
	}
	advanceDone := make(chan error, 1)
	go func() {
		_, advanceErr := NewReadCursorRepository(db).Advance(ctx, readerID, conversationID, 1)
		advanceDone <- advanceErr
	}()
	waitForQueryLock(t, ctx, db, "%SELECT id FROM conversations WHERE id = $1 FOR UPDATE%", advanceDone)
	if _, err := revokeTx.Exec(ctx, `UPDATE conversation_members SET active = false, left_at = now() WHERE conversation_id = $1 AND user_id = $2`, conversationID, readerID); err != nil {
		t.Fatalf("revoke reader membership: %v", err)
	}
	if _, err := revokeTx.Exec(ctx, `UPDATE conversations SET membership_revision = membership_revision + 1 WHERE id = $1`, conversationID); err != nil {
		t.Fatalf("advance membership revision: %v", err)
	}
	if err := revokeTx.Commit(ctx); err != nil {
		t.Fatalf("commit revocation: %v", err)
	}
	if err := <-advanceDone; err == nil {
		t.Fatal("concurrent cursor advance authorized a reader revoked before its lock linearization point")
	}
}

func waitForQueryLock(t *testing.T, ctx context.Context, db *pgxpool.Pool, queryPattern string, done <-chan error) {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
		var waiting bool
		if err := db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND state = 'active' AND query LIKE $1)`, queryPattern).Scan(&waiting); err != nil {
			t.Fatalf("inspect PostgreSQL lock wait: %v", err)
		}
		if waiting {
			return
		}
		select {
		case err := <-done:
			t.Fatalf("operation completed before lock release: %v", err)
		case <-time.After(10 * time.Millisecond):
		case <-ctx.Done():
			t.Fatalf("wait for PostgreSQL lock: %v", ctx.Err())
		}
	}
	t.Fatal("operation did not block on the conversation lock")
}

func orderedIDs(first, second uuid.UUID) (uuid.UUID, uuid.UUID) {
	if first.String() < second.String() {
		return first, second
	}
	return second, first
}
