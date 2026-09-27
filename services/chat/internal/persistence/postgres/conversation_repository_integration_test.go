package postgres

import (
	"context"
	"crypto/sha256"
	"errors"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/KovalMax/zwei/services/chat/internal/application"
	"github.com/KovalMax/zwei/services/chat/internal/domain/conversation"
	sharedmessage "github.com/KovalMax/zwei/services/shared/message"
	"github.com/KovalMax/zwei/services/shared/messaging"
)

func TestRepositoryConcurrentDirectCreateAndListWithSingleConnection(t *testing.T) {
	databaseURL := os.Getenv("ZWEI_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set ZWEI_TEST_DATABASE_URL to run PostgreSQL integration tests")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatalf("parse database configuration: %v", err)
	}
	config.MaxConns = 1
	db, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Close()

	firstUserID, secondUserID := uuid.New(), uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, 'integration', 'First'), ($3, $4, 'integration', 'Second')`, firstUserID, firstUserID.String()+"@integration.test", secondUserID, secondUserID.String()+"@integration.test"); err != nil {
		t.Fatalf("insert users: %v", err)
	}
	defer func() {
		_, _ = db.Exec(context.Background(), `DELETE FROM users WHERE id = ANY($1)`, []uuid.UUID{firstUserID, secondUserID})
	}()

	repository := NewConversationRepository(db, "integration-group-key")
	results := make(chan error, 2)
	var start sync.WaitGroup
	start.Add(1)
	for range 2 {
		go func() {
			start.Wait()
			_, err := repository.Create(ctx, firstUserID, secondUserID)
			results <- err
		}()
	}
	start.Done()
	for range 2 {
		if err := <-results; err != nil {
			t.Fatalf("create direct conversation: %v", err)
		}
	}

	conversations, err := repository.List(ctx, firstUserID)
	if err != nil {
		t.Fatalf("list conversations: %v", err)
	}
	if len(conversations) != 1 || conversations[0].OtherUserID != secondUserID {
		t.Fatalf("list conversations = %+v, want one direct conversation with %s", conversations, secondUserID)
	}
}

func TestRepositoryGroupMembershipMutationsRemainConsistentUnderConcurrency(t *testing.T) {
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

	ownerID, firstMemberID, secondMemberID, addedMemberID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	userIDs := []uuid.UUID{ownerID, firstMemberID, secondMemberID, addedMemberID}
	for _, userID := range userIDs {
		if _, err := db.Exec(ctx, `INSERT INTO users (id, email, password_hash, display_name, kyc_status, email_verified_at) VALUES ($1, $2, 'integration', 'Group member', 1, now())`, userID, userID.String()+"@integration.test"); err != nil {
			t.Fatalf("insert user %s: %v", userID, err)
		}
	}
	defer func() {
		_, _ = db.Exec(context.Background(), `DELETE FROM users WHERE id = ANY($1)`, userIDs)
	}()

	repository := NewConversationRepository(db, "group-membership-integration-key")
	group, err := repository.CreateGroup(ctx, ownerID, "Integration group", []uuid.UUID{firstMemberID, secondMemberID})
	if err != nil {
		t.Fatalf("create group: %v", err)
	}

	start := make(chan struct{})
	results := make(chan error, 2)
	var workers sync.WaitGroup
	workers.Add(2)
	go func() {
		defer workers.Done()
		<-start
		_, err := repository.AddMember(ctx, ownerID, group.ID, addedMemberID)
		results <- err
	}()
	go func() {
		defer workers.Done()
		<-start
		_, err := repository.ChangeRole(ctx, ownerID, group.ID, firstMemberID, conversation.RoleAdmin)
		results <- err
	}()
	close(start)
	workers.Wait()
	close(results)
	for err := range results {
		if err != nil {
			t.Fatalf("concurrent membership mutation: %v", err)
		}
	}

	updated, err := repository.GetGroup(ctx, ownerID, group.ID)
	if err != nil {
		t.Fatalf("get group after concurrent mutations: %v", err)
	}
	if updated.MembershipRevision != group.MembershipRevision+2 {
		t.Fatalf("membership revision = %d, want %d", updated.MembershipRevision, group.MembershipRevision+2)
	}
	if groupMemberRole(updated, addedMemberID) != conversation.RoleMember || groupMemberRole(updated, firstMemberID) != conversation.RoleAdmin {
		t.Fatalf("members after concurrent mutations = %+v", updated.Members)
	}
	assertSystemEntryCount(t, ctx, db, group.ID, 2)

	start = make(chan struct{})
	results = make(chan error, 2)
	workers.Add(2)
	go func() {
		defer workers.Done()
		<-start
		_, err := repository.RemoveMember(ctx, ownerID, group.ID, addedMemberID)
		results <- err
	}()
	go func() {
		defer workers.Done()
		<-start
		_, err := repository.ChangeRole(ctx, ownerID, group.ID, secondMemberID, conversation.RoleAdmin)
		results <- err
	}()
	close(start)
	workers.Wait()
	close(results)
	for err := range results {
		if err != nil {
			t.Fatalf("concurrent removal and role mutation: %v", err)
		}
	}
	updated, err = repository.GetGroup(ctx, ownerID, group.ID)
	if err != nil {
		t.Fatalf("get group after concurrent removal and role mutation: %v", err)
	}
	if updated.MembershipRevision != group.MembershipRevision+4 || groupMemberRole(updated, addedMemberID) != "" || groupMemberRole(updated, secondMemberID) != conversation.RoleAdmin {
		t.Fatalf("members after concurrent removal and role mutation = %+v, revision %d", updated.Members, updated.MembershipRevision)
	}
	assertSystemEntryCount(t, ctx, db, group.ID, 4)

	start = make(chan struct{})
	results = make(chan error, 2)
	workers.Add(2)
	for _, targetID := range []uuid.UUID{firstMemberID, secondMemberID} {
		go func(memberID uuid.UUID) {
			defer workers.Done()
			<-start
			_, err := repository.TransferOwnership(ctx, ownerID, group.ID, memberID)
			results <- err
		}(targetID)
	}
	close(start)
	workers.Wait()
	close(results)
	successes := 0
	for err := range results {
		if err == nil {
			successes++
			continue
		}
		if !errors.Is(err, application.ErrForbidden) {
			t.Fatalf("concurrent ownership transfer error = %v", err)
		}
	}
	if successes != 1 {
		t.Fatalf("ownership transfer successes = %d, want 1", successes)
	}

	updated, err = repository.GetGroup(ctx, ownerID, group.ID)
	if err != nil {
		t.Fatalf("get group after ownership transfers: %v", err)
	}
	owners := 0
	for _, member := range updated.Members {
		if member.Role == conversation.RoleOwner {
			owners++
			if member.UserID != updated.OwnerID {
				t.Fatalf("owner member = %s, group owner = %s", member.UserID, updated.OwnerID)
			}
		}
	}
	if owners != 1 {
		t.Fatalf("active owners = %d, want 1", owners)
	}
	assertSystemEntryCount(t, ctx, db, group.ID, 5)
}

func TestRepositoryGroupMembershipWritesConciseEncryptedSystemEntries(t *testing.T) {
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

	ownerID, memberID, addedMemberID := uuid.New(), uuid.New(), uuid.New()
	userIDs := []uuid.UUID{ownerID, memberID, addedMemberID}
	for userID, displayName := range map[uuid.UUID]string{ownerID: "Owner", memberID: "Member", addedMemberID: "Added member"} {
		if _, err := db.Exec(ctx, `INSERT INTO users (id, email, password_hash, display_name, kyc_status, email_verified_at) VALUES ($1, $2, 'integration', $3, 1, now())`, userID, userID.String()+"@integration.test", displayName); err != nil {
			t.Fatalf("insert user %s: %v", userID, err)
		}
	}
	defer func() {
		_, _ = db.Exec(context.Background(), `DELETE FROM users WHERE id = ANY($1)`, userIDs)
	}()

	secret := "group-system-entry-integration-key"
	repository := NewConversationRepository(db, secret)
	group, err := repository.CreateGroup(ctx, ownerID, "System entries", []uuid.UUID{memberID})
	if err != nil {
		t.Fatalf("create group: %v", err)
	}
	assertSystemEntry(t, ctx, db, secret, group.ID, "")
	if _, _, err := messaging.NewSender(db, secret).Send(ctx, messaging.SendRequest{SenderID: ownerID, ConversationID: group.ID, ClientMessageID: "before-member-join", Body: "Visible only before joining"}); err != nil {
		t.Fatalf("send before member joins: %v", err)
	}

	if _, err := repository.AddMember(ctx, ownerID, group.ID, addedMemberID); err != nil {
		t.Fatalf("add member: %v", err)
	}
	assertSystemEntry(t, ctx, db, secret, group.ID, "Owner added Added member to the group.")
	history, _, err := NewHistoryRepository(db, secret).List(ctx, addedMemberID, group.ID, 0, 10)
	if err != nil {
		t.Fatalf("list new member history: %v", err)
	}
	if len(history) != 1 || history[0].Body != "Owner added Added member to the group." || history[0].Kind != "system" {
		t.Fatalf("new member history = %+v, want only the join system entry", history)
	}
	if _, err := repository.ChangeRole(ctx, ownerID, group.ID, addedMemberID, conversation.RoleAdmin); err != nil {
		t.Fatalf("change role: %v", err)
	}
	assertSystemEntry(t, ctx, db, secret, group.ID, "Owner made Added member an admin.")
	if _, err := repository.TransferOwnership(ctx, ownerID, group.ID, addedMemberID); err != nil {
		t.Fatalf("transfer ownership: %v", err)
	}
	assertSystemEntry(t, ctx, db, secret, group.ID, "Owner transferred group ownership to Added member.")
	if _, err := repository.RemoveMember(ctx, addedMemberID, group.ID, memberID); err != nil {
		t.Fatalf("remove member: %v", err)
	}
	assertSystemEntry(t, ctx, db, secret, group.ID, "Added member removed Member from the group.")
	if err := repository.LeaveGroup(ctx, ownerID, group.ID); err != nil {
		t.Fatalf("leave group: %v", err)
	}
	assertSystemEntry(t, ctx, db, secret, group.ID, "Owner left the group.")
	if _, _, err := NewHistoryRepository(db, secret).List(ctx, ownerID, group.ID, 0, 10); !errors.Is(err, ErrNotFound) {
		t.Fatalf("removed member history error = %v, want %v", err, ErrNotFound)
	}
}

func TestRepositoryGroupReadsUseActiveMembershipSnapshotAndSelfTransferIsReadOnly(t *testing.T) {
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

	ownerID, firstMemberID, secondMemberID := uuid.New(), uuid.New(), uuid.New()
	userIDs := []uuid.UUID{ownerID, firstMemberID, secondMemberID}
	for index, userID := range userIDs {
		if _, err := db.Exec(ctx, `INSERT INTO users (id, email, password_hash, display_name, kyc_status, email_verified_at) VALUES ($1, $2, 'integration', $3, 1, now())`, userID, userID.String()+"@integration.test", []string{"Owner", "First", "Second"}[index]); err != nil {
			t.Fatalf("insert user %s: %v", userID, err)
		}
	}
	defer func() { _, _ = db.Exec(context.Background(), `DELETE FROM users WHERE id = ANY($1)`, userIDs) }()

	repository := NewConversationRepository(db, "group-read-integration-key")
	firstGroup, err := repository.CreateGroup(ctx, ownerID, "First group", []uuid.UUID{firstMemberID})
	if err != nil {
		t.Fatalf("create first group: %v", err)
	}
	secondGroup, err := repository.CreateGroup(ctx, ownerID, "Second group", []uuid.UUID{secondMemberID})
	if err != nil {
		t.Fatalf("create second group: %v", err)
	}
	for groupID, lastMessageAt := range map[uuid.UUID]string{firstGroup.ID: "2026-01-01T00:00:00Z", secondGroup.ID: "2026-01-02T00:00:00Z"} {
		if _, err := db.Exec(ctx, `UPDATE conversations SET last_message_at = $2::timestamptz WHERE id = $1`, groupID, lastMessageAt); err != nil {
			t.Fatalf("set deterministic group ordering: %v", err)
		}
	}

	groups, err := repository.ListGroups(ctx, ownerID)
	if err != nil {
		t.Fatalf("list groups: %v", err)
	}
	if len(groups) != 2 || groups[0].ID != secondGroup.ID || groups[1].ID != firstGroup.ID {
		t.Fatalf("listed group order = %+v, want second then first", groups)
	}
	if got := groups[0].Members; len(got) != 2 || !hasGroupMember(got, ownerID) || !hasGroupMember(got, secondMemberID) {
		t.Fatalf("second group active-member projection = %+v", got)
	}
	if got := groups[1].Members; len(got) != 2 || !hasGroupMember(got, ownerID) || !hasGroupMember(got, firstMemberID) {
		t.Fatalf("first group active-member projection = %+v", got)
	}
	if got, err := repository.GetGroup(ctx, firstMemberID, firstGroup.ID); err != nil || len(got.Members) != 2 {
		t.Fatalf("get group active-member projection = %+v, %v", got, err)
	}

	before, err := repository.GetGroup(ctx, ownerID, firstGroup.ID)
	if err != nil {
		t.Fatalf("read group before self-transfer: %v", err)
	}
	beforeSystemEntries := groupSystemEntryCount(t, ctx, db, firstGroup.ID)
	beforeOutboxEvents := groupOutboxEventCount(t, ctx, db, firstGroup.ID)
	if _, err := repository.TransferOwnership(ctx, ownerID, firstGroup.ID, ownerID); !errors.Is(err, application.ErrSelfOwnershipTransfer) {
		t.Fatalf("self-transfer error = %v, want %v", err, application.ErrSelfOwnershipTransfer)
	}
	after, err := repository.GetGroup(ctx, ownerID, firstGroup.ID)
	if err != nil {
		t.Fatalf("read group after rejected self-transfer: %v", err)
	}
	if after.OwnerID != before.OwnerID || after.MembershipRevision != before.MembershipRevision || groupMemberRole(after, ownerID) != groupMemberRole(before, ownerID) || groupMemberRole(after, firstMemberID) != groupMemberRole(before, firstMemberID) {
		t.Fatalf("self-transfer mutated group: before=%+v after=%+v", before, after)
	}
	if got := groupSystemEntryCount(t, ctx, db, firstGroup.ID); got != beforeSystemEntries {
		t.Fatalf("system entries after rejected self-transfer = %d, want %d", got, beforeSystemEntries)
	}
	if got := groupOutboxEventCount(t, ctx, db, firstGroup.ID); got != beforeOutboxEvents {
		t.Fatalf("outbox events after rejected self-transfer = %d, want %d", got, beforeOutboxEvents)
	}

	if _, err := db.Exec(ctx, `UPDATE conversation_members SET active = false, left_at = now() WHERE conversation_id = $1 AND user_id = $2`, secondGroup.ID, ownerID); err != nil {
		t.Fatalf("deactivate caller membership: %v", err)
	}
	groups, err = repository.ListGroups(ctx, ownerID)
	if err != nil {
		t.Fatalf("list groups after membership removal: %v", err)
	}
	if len(groups) != 1 || groups[0].ID != firstGroup.ID {
		t.Fatalf("groups after caller membership removal = %+v, want only first group", groups)
	}
	if _, err := repository.GetGroup(ctx, ownerID, secondGroup.ID); !errors.Is(err, application.ErrNotFound) {
		t.Fatalf("get group after caller membership removal = %v, want not found", err)
	}
}

func hasGroupMember(members []conversation.GroupMember, userID uuid.UUID) bool {
	for _, member := range members {
		if member.UserID == userID {
			return true
		}
	}
	return false
}

func groupMemberRole(group conversation.Group, userID uuid.UUID) conversation.Role {
	for _, member := range group.Members {
		if member.UserID == userID {
			return member.Role
		}
	}
	return ""
}

func assertSystemEntryCount(t *testing.T, ctx context.Context, db *pgxpool.Pool, groupID uuid.UUID, want int) {
	t.Helper()
	var count int
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM messages WHERE conversation_id = $1 AND kind = 'system'`, groupID).Scan(&count); err != nil {
		t.Fatalf("count system entries: %v", err)
	}
	if count != want {
		t.Fatalf("system entries = %d, want %d", count, want)
	}
}

func groupSystemEntryCount(t *testing.T, ctx context.Context, db *pgxpool.Pool, groupID uuid.UUID) int {
	t.Helper()
	var count int
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM messages WHERE conversation_id = $1 AND kind = 'system'`, groupID).Scan(&count); err != nil {
		t.Fatalf("count group system entries: %v", err)
	}
	return count
}

func groupOutboxEventCount(t *testing.T, ctx context.Context, db *pgxpool.Pool, groupID uuid.UUID) int {
	t.Helper()
	var count int
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM outbox_events WHERE payload->>'conversation_id' = $1`, groupID.String()).Scan(&count); err != nil {
		t.Fatalf("count group outbox events: %v", err)
	}
	return count
}

func assertSystemEntry(t *testing.T, ctx context.Context, db *pgxpool.Pool, secret string, groupID uuid.UUID, want string) {
	t.Helper()
	var kind string
	var ciphertext, nonce []byte
	err := db.QueryRow(ctx, `SELECT kind, ciphertext, nonce FROM messages WHERE conversation_id = $1 ORDER BY sequence DESC LIMIT 1`, groupID).Scan(&kind, &ciphertext, &nonce)
	if want == "" {
		if !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("initial system entry query error = %v, want no entry", err)
		}
		return
	}
	if err != nil {
		t.Fatalf("read latest system entry: %v", err)
	}
	if kind != "system" {
		t.Fatalf("message kind = %q, want system", kind)
	}
	key := sha256.Sum256([]byte(secret))
	body, err := sharedmessage.Decrypt(key[:], ciphertext, nonce)
	if err != nil {
		t.Fatalf("decrypt system entry: %v", err)
	}
	if body != want {
		t.Fatalf("system entry = %q, want %q", body, want)
	}
}
