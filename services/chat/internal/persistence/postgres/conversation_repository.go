package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/KovalMax/zwei/services/chat/internal/application"
	"github.com/KovalMax/zwei/services/chat/internal/domain/conversation"
	sharedmessage "github.com/KovalMax/zwei/services/shared/message"
)

var ErrNotFound = errors.New("conversation or user not found")

// Repository is the PostgreSQL adapter for direct-conversation queries and creation.
type Repository struct {
	db  *pgxpool.Pool
	key []byte
}

func NewConversationRepository(db *pgxpool.Pool, encryptionSecret string) *Repository {
	key := sha256.Sum256([]byte(encryptionSecret))
	return &Repository{db: db, key: key[:]}
}

func (r *Repository) SearchUsers(ctx context.Context, userID uuid.UUID, query string) ([]conversation.User, error) {
	pattern := "%" + strings.ToLower(query) + "%"
	rows, err := r.db.Query(ctx, `SELECT id, display_name, email FROM users WHERE id <> $1 AND kyc_status = 1 AND email_verified_at IS NOT NULL AND (lower(display_name) LIKE $2 OR lower(email) LIKE $2) ORDER BY display_name, id LIMIT 20`, userID, pattern)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	users := make([]conversation.User, 0)
	for rows.Next() {
		var user conversation.User
		if err := rows.Scan(&user.ID, &user.DisplayName, &user.Email); err != nil {
			return nil, err
		}
		users = append(users, user)
	}
	return users, rows.Err()
}

func (r *Repository) Create(ctx context.Context, userID, otherUserID uuid.UUID) (conversation.Conversation, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return conversation.Conversation{}, err
	}
	defer tx.Rollback(ctx)
	var exists bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM users WHERE id = $1)`, otherUserID).Scan(&exists); err != nil {
		return conversation.Conversation{}, err
	}
	if !exists {
		return conversation.Conversation{}, ErrNotFound
	}
	low, high := conversation.OrderedUsers(userID, otherUserID)
	var result conversation.Conversation
	created := true
	err = tx.QueryRow(ctx, `INSERT INTO conversations (user_low_id, user_high_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id, created_at`, low, high).Scan(&result.ID, &result.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		created = false
		err = tx.QueryRow(ctx, `SELECT id, created_at FROM conversations WHERE kind = 'direct' AND user_low_id = $1 AND user_high_id = $2`, low, high).Scan(&result.ID, &result.CreatedAt)
	}
	if err != nil {
		return conversation.Conversation{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2), ($1, $3) ON CONFLICT DO NOTHING`, result.ID, low, high); err != nil {
		return conversation.Conversation{}, err
	}
	if created {
		payload, err := json.Marshal(struct {
			ConversationID uuid.UUID   `json:"conversation_id"`
			UserIDs        []uuid.UUID `json:"user_ids"`
		}{ConversationID: result.ID, UserIDs: []uuid.UUID{userID, otherUserID}})
		if err != nil {
			return conversation.Conversation{}, err
		}
		if _, err = tx.Exec(ctx, `INSERT INTO outbox_events (event_type, payload) VALUES ('conversation.created', $1)`, payload); err != nil {
			return conversation.Conversation{}, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return conversation.Conversation{}, err
	}
	if err = r.db.QueryRow(ctx, `SELECT u.id, u.display_name, u.email FROM users u WHERE u.id = $1`, otherUserID).Scan(&result.OtherUserID, &result.OtherDisplayName, &result.OtherEmail); err != nil {
		return conversation.Conversation{}, err
	}
	result.LastMessageAt = result.CreatedAt
	return result, nil
}

func (r *Repository) List(ctx context.Context, userID uuid.UUID) ([]conversation.Conversation, error) {
	rows, err := r.db.Query(ctx, `SELECT c.id, peer.id, peer.display_name, peer.email, c.created_at, COALESCE(c.last_message_at, c.created_at), COALESCE(rc.unread_count, 0) FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id JOIN users peer ON peer.id = CASE WHEN c.user_low_id = $1 THEN c.user_high_id ELSE c.user_low_id END LEFT JOIN user_read_cursors rc ON rc.user_id = $1 AND rc.conversation_id = c.id WHERE c.kind = 'direct' AND cm.user_id = $1 AND cm.active ORDER BY COALESCE(c.last_message_at, c.created_at) DESC, c.id DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	conversations := make([]conversation.Conversation, 0)
	for rows.Next() {
		var item conversation.Conversation
		if err := rows.Scan(&item.ID, &item.OtherUserID, &item.OtherDisplayName, &item.OtherEmail, &item.CreatedAt, &item.LastMessageAt, &item.UnreadCount); err != nil {
			return nil, err
		}
		conversations = append(conversations, item)
	}
	return conversations, rows.Err()
}

func (r *Repository) Get(ctx context.Context, userID, conversationID uuid.UUID) (conversation.Conversation, error) {
	var item conversation.Conversation
	err := r.db.QueryRow(ctx, `SELECT c.id, u.id, u.display_name, u.email, c.created_at FROM conversations c JOIN conversation_members m ON m.conversation_id = c.id JOIN users u ON u.id = CASE WHEN c.user_low_id = $1 THEN c.user_high_id ELSE c.user_low_id END WHERE c.kind = 'direct' AND c.id = $2 AND m.user_id = $1 AND m.active`, userID, conversationID).Scan(&item.ID, &item.OtherUserID, &item.OtherDisplayName, &item.OtherEmail, &item.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return conversation.Conversation{}, ErrNotFound
	}
	return item, err
}

func (r *Repository) CreateGroup(ctx context.Context, ownerID uuid.UUID, name string, memberIDs []uuid.UUID) (conversation.Group, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return conversation.Group{}, err
	}
	defer tx.Rollback(ctx)
	ids := append([]uuid.UUID{ownerID}, memberIDs...)
	if _, err = tx.Exec(ctx, `SELECT id FROM users WHERE id = ANY($1) AND kyc_status = 1 AND email_verified_at IS NOT NULL FOR SHARE`, ids); err != nil {
		return conversation.Group{}, err
	}
	var count int
	if err = tx.QueryRow(ctx, `SELECT COUNT(*) FROM users WHERE id = ANY($1) AND kyc_status = 1 AND email_verified_at IS NOT NULL`, ids).Scan(&count); err != nil {
		return conversation.Group{}, err
	}
	if count != len(ids) {
		return conversation.Group{}, application.ErrNotFound
	}
	var group conversation.Group
	if err = tx.QueryRow(ctx, `INSERT INTO conversations (kind, group_name, group_avatar_seed, owner_id) VALUES ('group', $1, gen_random_uuid(), $2) RETURNING id, group_avatar_seed, owner_id, membership_revision, created_at, COALESCE(last_message_at, created_at)`, name, ownerID).Scan(&group.ID, &group.AvatarSeed, &group.OwnerID, &group.MembershipRevision, &group.CreatedAt, &group.LastMessageAt); err != nil {
		return conversation.Group{}, err
	}
	for _, memberID := range ids {
		role := conversation.RoleMember
		if memberID == ownerID {
			role = conversation.RoleOwner
		}
		if _, err = tx.Exec(ctx, `INSERT INTO conversation_members (conversation_id, user_id, role, visible_from_sequence) VALUES ($1, $2, $3, 1)`, group.ID, memberID, role); err != nil {
			return conversation.Group{}, err
		}
		if _, err = tx.Exec(ctx, `INSERT INTO user_read_cursors (user_id, conversation_id, last_read_sequence, unread_count) VALUES ($1, $2, 0, 0) ON CONFLICT DO NOTHING`, memberID, group.ID); err != nil {
			return conversation.Group{}, err
		}
	}
	if err = r.writeGroupEvent(ctx, tx, "group.membership.changed", group.ID, false); err != nil {
		return conversation.Group{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return conversation.Group{}, err
	}
	return r.GetGroup(ctx, ownerID, group.ID)
}

func (r *Repository) GetGroup(ctx context.Context, callerID, groupID uuid.UUID) (conversation.Group, error) {
	rows, err := r.db.Query(ctx, `SELECT c.id, c.group_name, c.group_avatar_seed, c.owner_id, c.membership_revision, c.created_at, COALESCE(c.last_message_at, c.created_at), m.user_id, u.display_name, u.email, m.role, m.visible_from_sequence, m.joined_at FROM conversations c JOIN conversation_members me ON me.conversation_id = c.id AND me.user_id = $1 AND me.active JOIN conversation_members m ON m.conversation_id = c.id AND m.active JOIN users u ON u.id = m.user_id WHERE c.id = $2 AND c.kind = 'group' ORDER BY m.joined_at, m.user_id`, callerID, groupID)
	if err != nil {
		return conversation.Group{}, err
	}
	defer rows.Close()
	groups, err := scanGroupProjections(rows)
	if err != nil {
		return conversation.Group{}, err
	}
	if len(groups) == 0 {
		return conversation.Group{}, application.ErrNotFound
	}
	return groups[0], nil
}

// ListGroups returns only projections the caller is currently authorized to see.
func (r *Repository) ListGroups(ctx context.Context, callerID uuid.UUID) ([]conversation.Group, error) {
	rows, err := r.db.Query(ctx, `SELECT c.id, c.group_name, c.group_avatar_seed, c.owner_id, c.membership_revision, c.created_at, COALESCE(c.last_message_at, c.created_at), m.user_id, u.display_name, u.email, m.role, m.visible_from_sequence, m.joined_at FROM conversations c JOIN conversation_members me ON me.conversation_id = c.id AND me.user_id = $1 AND me.active JOIN conversation_members m ON m.conversation_id = c.id AND m.active JOIN users u ON u.id = m.user_id WHERE c.kind = 'group' ORDER BY COALESCE(c.last_message_at, c.created_at) DESC, c.id DESC, m.joined_at, m.user_id`, callerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanGroupProjections(rows)
}

// scanGroupProjections assembles each bounded active-member projection from one ordered SQL snapshot.
func scanGroupProjections(rows pgx.Rows) ([]conversation.Group, error) {
	groups := make([]conversation.Group, 0)
	for rows.Next() {
		var group conversation.Group
		var member conversation.GroupMember
		if err := rows.Scan(&group.ID, &group.Name, &group.AvatarSeed, &group.OwnerID, &group.MembershipRevision, &group.CreatedAt, &group.LastMessageAt, &member.UserID, &member.DisplayName, &member.Email, &member.Role, &member.VisibleFromSequence, &member.JoinedAt); err != nil {
			return nil, err
		}
		if len(groups) == 0 || groups[len(groups)-1].ID != group.ID {
			groups = append(groups, group)
		}
		current := &groups[len(groups)-1]
		if len(current.Members) >= conversation.MaxGroupMembers {
			return nil, fmt.Errorf("group %s exceeds active-member limit", current.ID)
		}
		current.Members = append(current.Members, member)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return groups, nil
}

func (r *Repository) AddMember(ctx context.Context, callerID, groupID, memberID uuid.UUID) (conversation.Group, error) {
	return r.changeMembership(ctx, callerID, groupID, memberID, true)
}

func (r *Repository) RemoveMember(ctx context.Context, callerID, groupID, memberID uuid.UUID) (conversation.Group, error) {
	return r.changeMembership(ctx, callerID, groupID, memberID, false)
}

func (r *Repository) changeMembership(ctx context.Context, callerID, groupID, memberID uuid.UUID, add bool) (conversation.Group, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return conversation.Group{}, err
	}
	defer tx.Rollback(ctx)
	role, ownerID, nextSequence, err := r.groupActor(ctx, tx, callerID, groupID)
	if err != nil {
		return conversation.Group{}, err
	}
	if role != conversation.RoleOwner && role != conversation.RoleAdmin {
		return conversation.Group{}, application.ErrForbidden
	}
	if !add && memberID == ownerID {
		return conversation.Group{}, application.ErrForbidden
	}
	actorName, err := r.displayName(ctx, tx, callerID)
	if err != nil {
		return conversation.Group{}, err
	}
	memberName, err := r.displayName(ctx, tx, memberID)
	if err != nil {
		return conversation.Group{}, err
	}
	if add {
		var valid bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM users WHERE id = $1 AND kyc_status = 1 AND email_verified_at IS NOT NULL)`, memberID).Scan(&valid); err != nil {
			return conversation.Group{}, err
		}
		if !valid {
			return conversation.Group{}, application.ErrNotFound
		}
		var count int
		if err = tx.QueryRow(ctx, `SELECT COUNT(*) FROM conversation_members WHERE conversation_id = $1 AND active`, groupID).Scan(&count); err != nil {
			return conversation.Group{}, err
		}
		if count >= conversation.MaxGroupMembers {
			return conversation.Group{}, application.ErrGroupFull
		}
		var active bool
		err = tx.QueryRow(ctx, `SELECT active FROM conversation_members WHERE conversation_id = $1 AND user_id = $2 FOR UPDATE`, groupID, memberID).Scan(&active)
		if err == nil && active {
			return conversation.Group{}, application.ErrMemberExists
		}
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return conversation.Group{}, err
		}
		if _, err = tx.Exec(ctx, `INSERT INTO conversation_members (conversation_id, user_id, role, visible_from_sequence, active, left_at) VALUES ($1, $2, 'member', $3, true, NULL) ON CONFLICT (conversation_id, user_id) DO UPDATE SET role = 'member', visible_from_sequence = EXCLUDED.visible_from_sequence, active = true, left_at = NULL, joined_at = now()`, groupID, memberID, nextSequence); err != nil {
			return conversation.Group{}, err
		}
		if _, err = tx.Exec(ctx, `INSERT INTO user_read_cursors (user_id, conversation_id, last_read_sequence, unread_count) VALUES ($1, $2, $3, 0) ON CONFLICT (user_id, conversation_id) DO UPDATE SET last_read_sequence = EXCLUDED.last_read_sequence, unread_count = 0, updated_at = now()`, memberID, groupID, nextSequence-1); err != nil {
			return conversation.Group{}, err
		}
	} else {
		command, err := tx.Exec(ctx, `UPDATE conversation_members SET active = false, left_at = now() WHERE conversation_id = $1 AND user_id = $2 AND active`, groupID, memberID)
		if err != nil {
			return conversation.Group{}, err
		}
		if command.RowsAffected() == 0 {
			return conversation.Group{}, application.ErrNotFound
		}
	}
	if _, err = tx.Exec(ctx, `UPDATE conversations SET membership_revision = membership_revision + 1 WHERE id = $1`, groupID); err != nil {
		return conversation.Group{}, err
	}
	entry := fmt.Sprintf("%s removed %s from the group.", actorName, memberName)
	if add {
		entry = fmt.Sprintf("%s added %s to the group.", actorName, memberName)
	}
	if err = r.writeGroupSystemEntry(ctx, tx, groupID, callerID, entry); err != nil {
		return conversation.Group{}, err
	}
	if err = r.writeGroupEvent(ctx, tx, "group.membership.changed", groupID, false, memberID); err != nil {
		return conversation.Group{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return conversation.Group{}, err
	}
	return r.GetGroup(ctx, callerID, groupID)
}

func (r *Repository) RenameGroup(ctx context.Context, callerID, groupID uuid.UUID, name string) (conversation.Group, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return conversation.Group{}, err
	}
	defer tx.Rollback(ctx)
	role, _, _, err := r.groupActor(ctx, tx, callerID, groupID)
	if err != nil {
		return conversation.Group{}, err
	}
	if role != conversation.RoleOwner && role != conversation.RoleAdmin {
		return conversation.Group{}, application.ErrForbidden
	}
	if _, err = tx.Exec(ctx, `UPDATE conversations SET group_name = $2, membership_revision = membership_revision + 1 WHERE id = $1`, groupID, name); err != nil {
		return conversation.Group{}, err
	}
	if err = r.writeGroupEvent(ctx, tx, "group.membership.changed", groupID, false); err != nil {
		return conversation.Group{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return conversation.Group{}, err
	}
	return r.GetGroup(ctx, callerID, groupID)
}

func (r *Repository) ChangeRole(ctx context.Context, callerID, groupID, memberID uuid.UUID, role conversation.Role) (conversation.Group, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return conversation.Group{}, err
	}
	defer tx.Rollback(ctx)
	actorRole, ownerID, _, err := r.groupActor(ctx, tx, callerID, groupID)
	if err != nil {
		return conversation.Group{}, err
	}
	if actorRole != conversation.RoleOwner && actorRole != conversation.RoleAdmin || memberID == ownerID {
		return conversation.Group{}, application.ErrForbidden
	}
	actorName, err := r.displayName(ctx, tx, callerID)
	if err != nil {
		return conversation.Group{}, err
	}
	memberName, err := r.displayName(ctx, tx, memberID)
	if err != nil {
		return conversation.Group{}, err
	}
	command, err := tx.Exec(ctx, `UPDATE conversation_members SET role = $3 WHERE conversation_id = $1 AND user_id = $2 AND active`, groupID, memberID, role)
	if err != nil {
		return conversation.Group{}, err
	}
	if command.RowsAffected() == 0 {
		return conversation.Group{}, application.ErrNotFound
	}
	if _, err = tx.Exec(ctx, `UPDATE conversations SET membership_revision = membership_revision + 1 WHERE id = $1`, groupID); err != nil {
		return conversation.Group{}, err
	}
	roleLabel := "a member"
	if role == conversation.RoleAdmin {
		roleLabel = "an admin"
	}
	if err = r.writeGroupSystemEntry(ctx, tx, groupID, callerID, fmt.Sprintf("%s made %s %s.", actorName, memberName, roleLabel)); err != nil {
		return conversation.Group{}, err
	}
	if err = r.writeGroupEvent(ctx, tx, "group.membership.changed", groupID, false); err != nil {
		return conversation.Group{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return conversation.Group{}, err
	}
	return r.GetGroup(ctx, callerID, groupID)
}

func (r *Repository) TransferOwnership(ctx context.Context, callerID, groupID, memberID uuid.UUID) (conversation.Group, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return conversation.Group{}, err
	}
	defer tx.Rollback(ctx)
	role, _, _, err := r.groupActor(ctx, tx, callerID, groupID)
	if err != nil {
		return conversation.Group{}, err
	}
	if role != conversation.RoleOwner {
		return conversation.Group{}, application.ErrForbidden
	}
	if callerID == memberID {
		return conversation.Group{}, application.ErrSelfOwnershipTransfer
	}
	actorName, err := r.displayName(ctx, tx, callerID)
	if err != nil {
		return conversation.Group{}, err
	}
	memberName, err := r.displayName(ctx, tx, memberID)
	if err != nil {
		return conversation.Group{}, err
	}
	command, err := tx.Exec(ctx, `UPDATE conversation_members SET role = 'owner' WHERE conversation_id = $1 AND user_id = $2 AND active`, groupID, memberID)
	if err != nil {
		return conversation.Group{}, err
	}
	if command.RowsAffected() == 0 {
		return conversation.Group{}, application.ErrNotFound
	}
	if _, err = tx.Exec(ctx, `UPDATE conversation_members SET role = 'admin' WHERE conversation_id = $1 AND user_id = $2`, groupID, callerID); err != nil {
		return conversation.Group{}, err
	}
	if _, err = tx.Exec(ctx, `UPDATE conversations SET owner_id = $2, membership_revision = membership_revision + 1 WHERE id = $1`, groupID, memberID); err != nil {
		return conversation.Group{}, err
	}
	if err = r.writeGroupSystemEntry(ctx, tx, groupID, callerID, fmt.Sprintf("%s transferred group ownership to %s.", actorName, memberName)); err != nil {
		return conversation.Group{}, err
	}
	if err = r.writeGroupEvent(ctx, tx, "group.membership.changed", groupID, false); err != nil {
		return conversation.Group{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return conversation.Group{}, err
	}
	return r.GetGroup(ctx, callerID, groupID)
}

func (r *Repository) LeaveGroup(ctx context.Context, callerID, groupID uuid.UUID) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	role, _, _, err := r.groupActor(ctx, tx, callerID, groupID)
	if err != nil {
		return err
	}
	if role == conversation.RoleOwner {
		var members int
		if err = tx.QueryRow(ctx, `SELECT COUNT(*) FROM conversation_members WHERE conversation_id = $1 AND active`, groupID).Scan(&members); err != nil {
			return err
		}
		if members > 1 {
			return application.ErrForbidden
		}
		if err = r.writeGroupEvent(ctx, tx, "group.membership.changed", groupID, true, callerID); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `DELETE FROM conversations WHERE id = $1`, groupID); err != nil {
			return err
		}
	} else {
		actorName, err := r.displayName(ctx, tx, callerID)
		if err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `UPDATE conversation_members SET active = false, left_at = now() WHERE conversation_id = $1 AND user_id = $2`, groupID, callerID); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `UPDATE conversations SET membership_revision = membership_revision + 1 WHERE id = $1`, groupID); err != nil {
			return err
		}
		if err = r.writeGroupSystemEntry(ctx, tx, groupID, callerID, fmt.Sprintf("%s left the group.", actorName)); err != nil {
			return err
		}
		if err = r.writeGroupEvent(ctx, tx, "group.membership.changed", groupID, false, callerID); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (r *Repository) DeleteGroup(ctx context.Context, callerID, groupID uuid.UUID) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	role, _, _, err := r.groupActor(ctx, tx, callerID, groupID)
	if err != nil {
		return err
	}
	if role != conversation.RoleOwner {
		return application.ErrForbidden
	}
	if err = r.writeGroupEvent(ctx, tx, "group.membership.changed", groupID, true); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM conversations WHERE id = $1`, groupID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *Repository) groupActor(ctx context.Context, tx pgx.Tx, callerID, groupID uuid.UUID) (conversation.Role, uuid.UUID, int64, error) {
	var role conversation.Role
	var ownerID uuid.UUID
	var nextSequence int64
	err := tx.QueryRow(ctx, `SELECT m.role, c.owner_id, c.next_sequence FROM conversations c JOIN conversation_members m ON m.conversation_id = c.id AND m.user_id = $1 AND m.active WHERE c.id = $2 AND c.kind = 'group' FOR UPDATE OF c, m`, callerID, groupID).Scan(&role, &ownerID, &nextSequence)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", uuid.Nil, 0, application.ErrNotFound
	}
	return role, ownerID, nextSequence, err
}

func (r *Repository) displayName(ctx context.Context, tx pgx.Tx, userID uuid.UUID) (string, error) {
	var displayName string
	if err := tx.QueryRow(ctx, `SELECT display_name FROM users WHERE id = $1`, userID).Scan(&displayName); err != nil {
		return "", err
	}
	return displayName, nil
}

func (r *Repository) writeGroupEvent(ctx context.Context, tx pgx.Tx, eventType string, groupID uuid.UUID, deleted bool, extraRecipients ...uuid.UUID) error {
	var revision int64
	if err := tx.QueryRow(ctx, `SELECT membership_revision FROM conversations WHERE id = $1`, groupID).Scan(&revision); err != nil {
		return err
	}
	if deleted {
		revision++
	}
	rows, err := tx.Query(ctx, `SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND active`, groupID)
	if err != nil {
		return err
	}
	defer rows.Close()
	recipients := make([]uuid.UUID, 0)
	seen := make(map[uuid.UUID]struct{})
	for rows.Next() {
		var userID uuid.UUID
		if err := rows.Scan(&userID); err != nil {
			return err
		}
		seen[userID] = struct{}{}
		recipients = append(recipients, userID)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	authorizedUserIDs := append([]uuid.UUID(nil), recipients...)
	for _, userID := range extraRecipients {
		if userID != uuid.Nil {
			if _, exists := seen[userID]; !exists {
				seen[userID] = struct{}{}
				recipients = append(recipients, userID)
			}
		}
	}
	payload, err := json.Marshal(struct {
		ConversationID     uuid.UUID   `json:"conversation_id"`
		MembershipRevision int64       `json:"membership_revision"`
		Deleted            bool        `json:"deleted"`
		UserIDs            []uuid.UUID `json:"user_ids"`
		AuthorizedUserIDs  []uuid.UUID `json:"authorized_user_ids,omitempty"`
	}{ConversationID: groupID, MembershipRevision: revision, Deleted: deleted, UserIDs: recipients, AuthorizedUserIDs: authorizedUserIDs})
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO outbox_events (event_type, payload) VALUES ($1, $2)`, eventType, payload)
	return err
}

// writeGroupSystemEntry makes membership activity visible only from each member's join boundary.
func (r *Repository) writeGroupSystemEntry(ctx context.Context, tx pgx.Tx, groupID, actorID uuid.UUID, body string) error {
	sequence := int64(0)
	if err := tx.QueryRow(ctx, `UPDATE conversations SET next_sequence = next_sequence + 1, last_message_at = now() WHERE id = $1 RETURNING next_sequence - 1`, groupID).Scan(&sequence); err != nil {
		return err
	}
	ciphertext, nonce, err := sharedmessage.Encrypt(r.key, []byte(body))
	if err != nil {
		return err
	}
	var messageID uuid.UUID
	if err = tx.QueryRow(ctx, `INSERT INTO messages (conversation_id, sender_id, client_message_id, sequence, ciphertext, nonce, encryption_key_version, kind) VALUES ($1, $2, $3, $4, $5, $6, 'v1', 'system') RETURNING id`, groupID, actorID, "group-system-"+uuid.NewString(), sequence, ciphertext, nonce).Scan(&messageID); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO message_delivery (message_id, device_id) SELECT $1, d.id FROM devices d JOIN conversation_members m ON m.user_id = d.user_id WHERE m.conversation_id = $2 AND m.active AND m.user_id <> $3 AND d.revoked_at IS NULL`, messageID, groupID, actorID); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO user_read_cursors (user_id, conversation_id, last_read_sequence, unread_count) SELECT m.user_id, $1, m.visible_from_sequence - 1, 1 FROM conversation_members m WHERE m.conversation_id = $1 AND m.active AND m.user_id <> $2 ON CONFLICT (user_id, conversation_id) DO UPDATE SET unread_count = user_read_cursors.unread_count + 1, updated_at = now()`, groupID, actorID)
	return err
}
