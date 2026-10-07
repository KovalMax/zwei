package postgres

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestResolveTypingRecipientsAuthorizesDirectAndGroupConversations(t *testing.T) {
	databaseURL := os.Getenv("ZWEI_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set ZWEI_TEST_DATABASE_URL to run PostgreSQL integration tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	db, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Close()
	if err := db.Ping(ctx); err != nil {
		t.Fatalf("ping database: %v", err)
	}

	caller, activePeer, removedPeer, unrelatedPeer := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	groupID, directID := uuid.New(), uuid.New()
	userIDs := []uuid.UUID{caller, activePeer, removedPeer, unrelatedPeer}
	for i, userID := range userIDs {
		if _, err := db.Exec(ctx, `INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, 'integration', 'Typing integration')`, userID, userID.String()+"@typing-integration.test"); err != nil {
			t.Fatalf("insert user %d: %v", i, err)
		}
	}
	defer func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = db.Exec(cleanupCtx, `DELETE FROM users WHERE id = ANY($1)`, userIDs)
	}()
	if _, err := db.Exec(ctx, `INSERT INTO conversations (id, kind, group_name, owner_id, next_sequence) VALUES ($1, 'group', 'Typing integration', $2, 1)`, groupID, caller); err != nil {
		t.Fatalf("insert group: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member'), ($1, $4, 'member')`, groupID, caller, activePeer, removedPeer); err != nil {
		t.Fatalf("insert group members: %v", err)
	}
	if _, err := db.Exec(ctx, `UPDATE conversation_members SET active = false, left_at = now() WHERE conversation_id = $1 AND user_id = $2`, groupID, removedPeer); err != nil {
		t.Fatalf("remove group member: %v", err)
	}
	lowID, highID := orderedIDs(caller, unrelatedPeer)
	if _, err := db.Exec(ctx, `INSERT INTO conversations (id, kind, user_low_id, user_high_id, next_sequence) VALUES ($1, 'direct', $2, $3, 1)`, directID, lowID, highID); err != nil {
		t.Fatalf("insert unrelated direct conversation: %v", err)
	}
	repository := NewPresenceRepository(db)

	groupRecipients, err := repository.ResolveTypingRecipients(ctx, caller, groupID)
	if err != nil {
		t.Fatalf("resolve group typing recipients: %v", err)
	}
	if len(groupRecipients) != 1 || groupRecipients[0] != activePeer {
		t.Fatalf("group typing recipients = %v, want only active peer %s", groupRecipients, activePeer)
	}
	if _, err := repository.ResolveTypingRecipients(ctx, removedPeer, groupID); err == nil {
		t.Fatal("removed caller was authorized for group typing")
	}

	directRecipients, err := repository.ResolveTypingRecipients(ctx, removedPeer, directID)
	if err == nil || len(directRecipients) != 0 {
		t.Fatalf("unrelated direct conversation recipients = %v, error = %v; want unauthorized", directRecipients, err)
	}

	// The direct V1 conversation still resolves exactly its other participant.
	directID = uuid.New()
	lowID, highID = orderedIDs(caller, activePeer)
	if _, err := db.Exec(ctx, `INSERT INTO conversations (id, kind, user_low_id, user_high_id, next_sequence) VALUES ($1, 'direct', $2, $3, 1)`, directID, lowID, highID); err != nil {
		t.Fatalf("insert caller direct conversation: %v", err)
	}
	directRecipients, err = repository.ResolveTypingRecipients(ctx, caller, directID)
	if err != nil || len(directRecipients) != 1 || directRecipients[0] != activePeer {
		t.Fatalf("direct typing recipients = %v, error = %v; want [%s]", directRecipients, err, activePeer)
	}
}
