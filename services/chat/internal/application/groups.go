package application

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"

	"github.com/KovalMax/zwei/services/chat/internal/domain/conversation"
)

var (
	ErrNotFound              = errors.New("group not found")
	ErrForbidden             = errors.New("group action is not allowed")
	ErrMemberExists          = errors.New("user is already an active group member")
	ErrGroupFull             = errors.New("group has reached its 16 member limit")
	ErrSelfOwnershipTransfer = errors.New("cannot transfer group ownership to yourself")
	ErrInvalidGroupPage      = errors.New("invalid group page")
)

const (
	DefaultGroupPageLimit = 25
	MaxGroupPageLimit     = 25
)

// GroupSortKey is the stable activity-order tuple used to traverse group pages.
type GroupSortKey struct {
	SortAt  time.Time
	GroupID uuid.UUID
}

// GroupPageCursor bounds traversal without granting access to any group.
type GroupPageCursor struct {
	Upper    GroupSortKey
	After    GroupSortKey
	Archived bool
}

type GroupPage struct {
	Items      []conversation.Group
	NextCursor *GroupPageCursor
}

// GroupStore is the persistence port consumed by group use cases.
type GroupStore interface {
	CreateGroup(context.Context, uuid.UUID, string, []uuid.UUID) (conversation.Group, error)
	ListGroupsPage(context.Context, uuid.UUID, int, bool, *GroupPageCursor) (GroupPage, error)
	GetGroup(context.Context, uuid.UUID, uuid.UUID) (conversation.Group, error)
	AddMember(context.Context, uuid.UUID, uuid.UUID, uuid.UUID) (conversation.Group, error)
	RemoveMember(context.Context, uuid.UUID, uuid.UUID, uuid.UUID) (conversation.Group, error)
	RenameGroup(context.Context, uuid.UUID, uuid.UUID, string) (conversation.Group, error)
	ChangeRole(context.Context, uuid.UUID, uuid.UUID, uuid.UUID, conversation.Role) (conversation.Group, error)
	TransferOwnership(context.Context, uuid.UUID, uuid.UUID, uuid.UUID) (conversation.Group, error)
	LeaveGroup(context.Context, uuid.UUID, uuid.UUID) error
	DeleteGroup(context.Context, uuid.UUID, uuid.UUID) error
}

type Groups struct{ store GroupStore }

func NewGroups(store GroupStore) *Groups { return &Groups{store: store} }

func (g *Groups) Create(ctx context.Context, ownerID uuid.UUID, name string, memberIDs []uuid.UUID) (conversation.Group, error) {
	name, err := conversation.NewGroupName(name)
	if err != nil {
		return conversation.Group{}, err
	}
	if ownerID == uuid.Nil {
		return conversation.Group{}, conversation.ErrInvalidMembers
	}
	seen := map[uuid.UUID]struct{}{ownerID: {}}
	members := make([]uuid.UUID, 0, len(memberIDs))
	for _, id := range memberIDs {
		if id == uuid.Nil {
			return conversation.Group{}, conversation.ErrInvalidMembers
		}
		if _, exists := seen[id]; !exists {
			seen[id] = struct{}{}
			if id != ownerID {
				members = append(members, id)
			}
		}
	}
	if len(seen) > conversation.MaxGroupMembers {
		return conversation.Group{}, conversation.ErrInvalidMembers
	}
	return g.store.CreateGroup(ctx, ownerID, name, members)
}

func (g *Groups) Get(ctx context.Context, callerID, groupID uuid.UUID) (conversation.Group, error) {
	return g.store.GetGroup(ctx, callerID, groupID)
}

func (g *Groups) ListPage(ctx context.Context, callerID uuid.UUID, limit int, archived bool, cursor *GroupPageCursor) (GroupPage, error) {
	if callerID == uuid.Nil || limit < 1 || limit > MaxGroupPageLimit {
		return GroupPage{}, ErrInvalidGroupPage
	}
	if err := ValidateGroupPageCursor(cursor); err != nil {
		return GroupPage{}, ErrInvalidGroupPage
	}
	if cursor != nil && cursor.Archived != archived {
		return GroupPage{}, ErrInvalidGroupPage
	}
	return g.store.ListGroupsPage(ctx, callerID, limit, archived, cursor)
}

func ValidateGroupPageCursor(cursor *GroupPageCursor) error {
	if cursor == nil {
		return nil
	}
	if !validGroupSortKey(cursor.Upper) || !validGroupSortKey(cursor.After) || compareGroupSortKeys(cursor.After, cursor.Upper) > 0 {
		return ErrInvalidGroupPage
	}
	return nil
}

func validGroupSortKey(key GroupSortKey) bool { return !key.SortAt.IsZero() && key.GroupID != uuid.Nil }

// Positive means left sorts before/right (newer timestamp, then larger ID).
func compareGroupSortKeys(left, right GroupSortKey) int {
	if left.SortAt.After(right.SortAt) {
		return 1
	}
	if left.SortAt.Before(right.SortAt) {
		return -1
	}
	if left.GroupID == right.GroupID {
		return 0
	}
	if left.GroupID.String() > right.GroupID.String() {
		return 1
	}
	return -1
}

func (g *Groups) AddMember(ctx context.Context, callerID, groupID, memberID uuid.UUID) (conversation.Group, error) {
	if memberID == uuid.Nil {
		return conversation.Group{}, ErrNotFound
	}
	return g.store.AddMember(ctx, callerID, groupID, memberID)
}

func (g *Groups) RemoveMember(ctx context.Context, callerID, groupID, memberID uuid.UUID) (conversation.Group, error) {
	return g.store.RemoveMember(ctx, callerID, groupID, memberID)
}

func (g *Groups) Rename(ctx context.Context, callerID, groupID uuid.UUID, name string) (conversation.Group, error) {
	name, err := conversation.NewGroupName(name)
	if err != nil {
		return conversation.Group{}, err
	}
	return g.store.RenameGroup(ctx, callerID, groupID, name)
}

func (g *Groups) ChangeRole(ctx context.Context, callerID, groupID, memberID uuid.UUID, role conversation.Role) (conversation.Group, error) {
	if !conversation.ValidRole(role) || role == conversation.RoleOwner {
		return conversation.Group{}, conversation.ErrInvalidRole
	}
	return g.store.ChangeRole(ctx, callerID, groupID, memberID, role)
}

func (g *Groups) TransferOwnership(ctx context.Context, callerID, groupID, memberID uuid.UUID) (conversation.Group, error) {
	if callerID == memberID {
		return conversation.Group{}, ErrSelfOwnershipTransfer
	}
	return g.store.TransferOwnership(ctx, callerID, groupID, memberID)
}

func (g *Groups) Leave(ctx context.Context, callerID, groupID uuid.UUID) error {
	return g.store.LeaveGroup(ctx, callerID, groupID)
}
func (g *Groups) Delete(ctx context.Context, callerID, groupID uuid.UUID) error {
	return g.store.DeleteGroup(ctx, callerID, groupID)
}
