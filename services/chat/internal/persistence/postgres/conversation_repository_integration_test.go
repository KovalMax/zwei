package postgres

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"sort"
	"strconv"
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

func TestGroupActivityIndexMatchesGroupPageOrdering(t *testing.T) {
	databaseURL := os.Getenv("ZWEI_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set ZWEI_TEST_DATABASE_URL to run PostgreSQL integration tests")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	db, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Close()

	var valid, ready, unique, firstNoCollation, secondNoCollation bool
	var keyCount, attributeCount int
	var firstOrderingOptions, secondOrderingOptions int
	var accessMethod, tableName, firstKey, secondKey, predicate string
	var firstOpclass, firstOpclassSchema, secondOpclass, secondOpclassSchema string
	err = db.QueryRow(ctx, `
		SELECT index_state.indisvalid,
			index_state.indisready,
			index_state.indisunique,
			index_state.indnkeyatts,
			index_state.indnatts,
			access_method.amname,
			table_class.relname,
			pg_get_indexdef(index_class.oid, 1, true),
			pg_get_indexdef(index_class.oid, 2, true),
			(index_state.indoption[0] & 3),
			(index_state.indoption[1] & 3),
			first_opclass.opcname,
			first_opclass_namespace.nspname,
			second_opclass.opcname,
			second_opclass_namespace.nspname,
			index_state.indcollation[0] = 0,
			index_state.indcollation[1] = 0,
			pg_get_expr(index_state.indpred, index_state.indrelid)
		FROM pg_class index_class
		JOIN pg_namespace index_namespace ON index_namespace.oid = index_class.relnamespace
		JOIN pg_index index_state ON index_state.indexrelid = index_class.oid
		JOIN pg_class table_class ON table_class.oid = index_state.indrelid
		JOIN pg_am access_method ON access_method.oid = index_class.relam
		JOIN pg_opclass first_opclass ON first_opclass.oid = index_state.indclass[0]
		JOIN pg_namespace first_opclass_namespace ON first_opclass_namespace.oid = first_opclass.opcnamespace
		JOIN pg_opclass second_opclass ON second_opclass.oid = index_state.indclass[1]
		JOIN pg_namespace second_opclass_namespace ON second_opclass_namespace.oid = second_opclass.opcnamespace
		WHERE index_namespace.nspname = current_schema()
			AND index_class.relname = 'conversations_group_activity_idx'
			AND table_class.relname = 'conversations'`).Scan(
		&valid,
		&ready,
		&unique,
		&keyCount,
		&attributeCount,
		&accessMethod,
		&tableName,
		&firstKey,
		&secondKey,
		&firstOrderingOptions,
		&secondOrderingOptions,
		&firstOpclass,
		&firstOpclassSchema,
		&secondOpclass,
		&secondOpclassSchema,
		&firstNoCollation,
		&secondNoCollation,
		&predicate,
	)
	if err != nil {
		t.Fatalf("read conversations_group_activity_idx definition: %v", err)
	}
	if !valid || !ready {
		t.Fatalf("conversations_group_activity_idx valid=%t ready=%t, want both true", valid, ready)
	}
	if tableName != "conversations" || accessMethod != "btree" || unique || keyCount != 2 || attributeCount != 2 || firstKey != "COALESCE(last_message_at, created_at)" || secondKey != "id" || firstOrderingOptions != 3 || secondOrderingOptions != 3 || firstOpclass != "timestamptz_ops" || firstOpclassSchema != "pg_catalog" || secondOpclass != "uuid_ops" || secondOpclassSchema != "pg_catalog" || !firstNoCollation || !secondNoCollation {
		t.Fatalf("group activity index = table:%q method:%q unique:%t key attrs:%d total attrs:%d (key1=%q ordering=%d opclass=%s.%s no-collation=%t, key2=%q ordering=%d opclass=%s.%s no-collation=%t), want exact DESC NULLS FIRST nonunique btree with pg_catalog.timestamptz_ops/uuid_ops and zero collations", tableName, accessMethod, unique, keyCount, attributeCount, firstKey, firstOrderingOptions, firstOpclassSchema, firstOpclass, firstNoCollation, secondKey, secondOrderingOptions, secondOpclassSchema, secondOpclass, secondNoCollation)
	}
	if predicate != "(kind = 'group'::text)" {
		t.Fatalf("group activity index predicate = %q, want only group conversations", predicate)
	}
}

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
	for index, body := range []string{"History page one", "History page two", "History page three"} {
		if _, _, err := messaging.NewSender(db, secret).Send(ctx, messaging.SendRequest{SenderID: ownerID, ConversationID: group.ID, ClientMessageID: fmt.Sprintf("history-page-%d", index), Body: body}); err != nil {
			t.Fatalf("send history message %q: %v", body, err)
		}
	}
	historyRepository := NewHistoryRepository(db, secret)
	firstPage, cursor, err := historyRepository.List(ctx, ownerID, group.ID, 0, 2)
	if err != nil {
		t.Fatalf("list first history page: %v", err)
	}
	if len(firstPage) != 2 || firstPage[0].Sequence <= firstPage[1].Sequence || firstPage[0].Body != "History page three" || firstPage[1].Body != "History page two" {
		t.Fatalf("first history page = %+v, want newest two messages in descending sequence order", firstPage)
	}
	before, err := strconv.ParseInt(cursor, 10, 64)
	if err != nil || before != firstPage[1].Sequence {
		t.Fatalf("next cursor = %q, want oldest sequence in first page %d", cursor, firstPage[1].Sequence)
	}
	secondPage, _, err := historyRepository.List(ctx, ownerID, group.ID, before, 2)
	if err != nil {
		t.Fatalf("list second history page: %v", err)
	}
	if len(secondPage) != 2 || secondPage[0].Sequence <= secondPage[1].Sequence || secondPage[0].Sequence >= firstPage[1].Sequence {
		t.Fatalf("second history page = %+v, want the next older messages in descending order without overlap", secondPage)
	}
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

	groupPage, err := repository.ListGroupsPage(ctx, ownerID, 25, nil)
	groups := groupPage.Items
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
	groupPage, err = repository.ListGroupsPage(ctx, ownerID, 25, nil)
	groups = groupPage.Items
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

func TestRepositoryGroupPagesBoundAndTraverseAuthorizedProjections(t *testing.T) {
	databaseURL := os.Getenv("ZWEI_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set ZWEI_TEST_DATABASE_URL to run PostgreSQL integration tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	db, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Close()

	ownerID, activeMemberID, inactiveMemberID := uuid.New(), uuid.New(), uuid.New()
	userIDs := []uuid.UUID{ownerID, activeMemberID, inactiveMemberID}
	for index, userID := range userIDs {
		if _, err := db.Exec(ctx, `INSERT INTO users (id, email, password_hash, display_name, kyc_status, email_verified_at) VALUES ($1, $2, 'integration', $3, 1, now())`, userID, userID.String()+"@integration.test", fmt.Sprintf("Page user %d", index)); err != nil {
			t.Fatalf("insert user %s: %v", userID, err)
		}
	}
	defer func() { _, _ = db.Exec(context.Background(), `DELETE FROM users WHERE id = ANY($1)`, userIDs) }()

	repository := NewConversationRepository(db, "group-page-integration-key")
	groupIDs := make([]uuid.UUID, 0, 53)
	for range 53 {
		group, err := repository.CreateGroup(ctx, ownerID, "Page group", nil)
		if err != nil {
			t.Fatalf("create group: %v", err)
		}
		groupIDs = append(groupIDs, group.ID)
	}
	// Equal effective timestamps exercise the exact group_id DESC tie-breaker and
	// the COALESCE fallback for every group with no message timestamp.
	tieAt := time.Date(2026, 5, 4, 3, 2, 1, 123456000, time.UTC)
	if _, err := db.Exec(ctx, `UPDATE conversations SET created_at = $2, last_message_at = NULL WHERE id = ANY($1)`, groupIDs, tieAt); err != nil {
		t.Fatalf("set tied fallback timestamps: %v", err)
	}
	projectionGroup := groupIDs[0]
	if _, err := db.Exec(ctx, `INSERT INTO conversation_members (conversation_id, user_id, role, visible_from_sequence) VALUES ($1, $2, 'member', 1), ($1, $3, 'member', 1)`, projectionGroup, activeMemberID, inactiveMemberID); err != nil {
		t.Fatalf("insert projection members: %v", err)
	}
	if _, err := db.Exec(ctx, `UPDATE conversation_members SET active = false, left_at = now() WHERE conversation_id = $1 AND user_id = $2`, projectionGroup, inactiveMemberID); err != nil {
		t.Fatalf("deactivate projection member: %v", err)
	}
	// A group with no active caller membership must never enter the candidate IDs.
	inaccessible, err := repository.CreateGroup(ctx, activeMemberID, "Inaccessible", nil)
	if err != nil {
		t.Fatalf("create inaccessible group: %v", err)
	}
	if _, err := db.Exec(ctx, `UPDATE conversation_members SET active = false, left_at = now() WHERE conversation_id = $1 AND user_id = $2`, inaccessible.ID, activeMemberID); err != nil {
		t.Fatalf("deactivate caller membership: %v", err)
	}

	first, err := repository.ListGroupsPage(ctx, ownerID, 25, nil)
	if err != nil {
		t.Fatalf("first page: %v", err)
	}
	if len(first.Items) != 25 || first.NextCursor == nil {
		t.Fatalf("first page has %d items and cursor %v, want 25 and cursor", len(first.Items), first.NextCursor)
	}
	wantIDs := append([]uuid.UUID(nil), groupIDs...)
	sort.Slice(wantIDs, func(i, j int) bool { return wantIDs[i].String() > wantIDs[j].String() })
	seen := make(map[uuid.UUID]bool, 27)
	for index, group := range first.Items {
		if group.ID != wantIDs[index] {
			t.Fatalf("first page item %d = %s, want %s", index, group.ID, wantIDs[index])
		}
		if group.LastMessageAt.UTC() != tieAt {
			t.Fatalf("fallback activity time = %s, want %s", group.LastMessageAt, tieAt)
		}
		if seen[group.ID] {
			t.Fatalf("duplicate first-page group %s", group.ID)
		}
		seen[group.ID] = true
		if group.ID == projectionGroup && (len(group.Members) != 2 || !hasGroupMember(group.Members, activeMemberID) || hasGroupMember(group.Members, inactiveMemberID)) {
			t.Fatalf("active member projection = %+v", group.Members)
		}
	}
	second, err := repository.ListGroupsPage(ctx, ownerID, 25, first.NextCursor)
	if err != nil {
		t.Fatalf("second page: %v", err)
	}
	for index, group := range second.Items {
		if group.ID != wantIDs[index+25] {
			t.Fatalf("second page item %d = %s, want %s", index, group.ID, wantIDs[index+25])
		}
		if seen[group.ID] {
			t.Fatalf("duplicate paginated group %s", group.ID)
		}
		seen[group.ID] = true
	}
	if len(second.Items) != 25 || second.NextCursor == nil {
		t.Fatalf("second page has %d items and cursor %v, want 25 and cursor", len(second.Items), second.NextCursor)
	}
	if second.NextCursor.Upper != first.NextCursor.Upper || second.NextCursor.After.GroupID != second.Items[len(second.Items)-1].ID {
		t.Fatalf("second cursor = %+v, want preserved upper and last emitted key", second.NextCursor)
	}
	third, err := repository.ListGroupsPage(ctx, ownerID, 25, second.NextCursor)
	if err != nil {
		t.Fatalf("third page: %v", err)
	}
	if len(third.Items) != 3 || third.NextCursor != nil {
		t.Fatalf("third page has %d items and cursor %v, want 3 and terminal", len(third.Items), third.NextCursor)
	}
	for index, group := range third.Items {
		if group.ID != wantIDs[index+50] {
			t.Fatalf("third page item %d = %s, want %s", index, group.ID, wantIDs[index+50])
		}
		if seen[group.ID] {
			t.Fatalf("duplicate paginated group %s", group.ID)
		}
		seen[group.ID] = true
	}
	if len(seen) != 53 {
		t.Fatalf("unique groups across pages = %d, want 53", len(seen))
	}
	empty, err := repository.ListGroupsPage(ctx, uuid.New(), 25, nil)
	if err != nil {
		t.Fatalf("empty page: %v", err)
	}
	if empty.Items == nil || len(empty.Items) != 0 || empty.NextCursor != nil {
		t.Fatalf("empty page = %+v, want empty non-nil items and nil cursor", empty)
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
