package application

import (
	"context"
	"testing"

	"github.com/google/uuid"

	"github.com/KovalMax/zwei/services/chat/internal/domain/conversation"
)

type groupStoreFake struct {
	created         []uuid.UUID
	changeRoleCalls int
	transferCalls   int
	groups          []conversation.Group
}

func (f *groupStoreFake) CreateGroup(_ context.Context, _ uuid.UUID, _ string, members []uuid.UUID) (conversation.Group, error) {
	f.created = members
	return conversation.Group{}, nil
}
func (f *groupStoreFake) GetGroup(context.Context, uuid.UUID, uuid.UUID) (conversation.Group, error) {
	return conversation.Group{}, nil
}
func (f *groupStoreFake) ListGroups(context.Context, uuid.UUID) ([]conversation.Group, error) {
	return f.groups, nil
}
func (f *groupStoreFake) AddMember(context.Context, uuid.UUID, uuid.UUID, uuid.UUID) (conversation.Group, error) {
	return conversation.Group{}, nil
}
func (f *groupStoreFake) RemoveMember(context.Context, uuid.UUID, uuid.UUID, uuid.UUID) (conversation.Group, error) {
	return conversation.Group{}, nil
}
func (f *groupStoreFake) RenameGroup(context.Context, uuid.UUID, uuid.UUID, string) (conversation.Group, error) {
	return conversation.Group{}, nil
}
func (f *groupStoreFake) ChangeRole(context.Context, uuid.UUID, uuid.UUID, uuid.UUID, conversation.Role) (conversation.Group, error) {
	f.changeRoleCalls++
	return conversation.Group{}, nil
}
func (f *groupStoreFake) TransferOwnership(context.Context, uuid.UUID, uuid.UUID, uuid.UUID) (conversation.Group, error) {
	f.transferCalls++
	return conversation.Group{}, nil
}
func (f *groupStoreFake) LeaveGroup(context.Context, uuid.UUID, uuid.UUID) error  { return nil }
func (f *groupStoreFake) DeleteGroup(context.Context, uuid.UUID, uuid.UUID) error { return nil }

func TestCreateDeduplicatesOwnerAndMembers(t *testing.T) {
	owner, member := uuid.New(), uuid.New()
	store := &groupStoreFake{}
	if _, err := NewGroups(store).Create(context.Background(), owner, "Team", []uuid.UUID{owner, member, member}); err != nil {
		t.Fatal(err)
	}
	if len(store.created) != 1 || store.created[0] != member {
		t.Fatalf("members = %v, want only %s", store.created, member)
	}
}

func TestCreateRejectsMoreThanSixteenMembers(t *testing.T) {
	members := make([]uuid.UUID, conversation.MaxGroupMembers)
	for index := range members {
		members[index] = uuid.New()
	}
	if _, err := NewGroups(&groupStoreFake{}).Create(context.Background(), uuid.New(), "Team", members); err != conversation.ErrInvalidMembers {
		t.Fatalf("error = %v", err)
	}
}

func TestChangeRoleRejectsOwnerAndUnknownRolesBeforePersistence(t *testing.T) {
	store := &groupStoreFake{}
	groups := NewGroups(store)
	for _, role := range []conversation.Role{conversation.RoleOwner, "operator"} {
		if _, err := groups.ChangeRole(context.Background(), uuid.New(), uuid.New(), uuid.New(), role); err != conversation.ErrInvalidRole {
			t.Fatalf("ChangeRole(%q) error = %v, want %v", role, err, conversation.ErrInvalidRole)
		}
	}
	if store.changeRoleCalls != 0 {
		t.Fatalf("persistence calls = %d, want 0", store.changeRoleCalls)
	}
}

func TestListReturnsAuthorizedStoreProjection(t *testing.T) {
	want := []conversation.Group{{ID: uuid.New()}}
	groups, err := NewGroups(&groupStoreFake{groups: want}).List(context.Background(), uuid.New())
	if err != nil {
		t.Fatal(err)
	}
	if len(groups) != 1 || groups[0].ID != want[0].ID {
		t.Fatalf("groups = %#v, want %#v", groups, want)
	}
}

func TestTransferOwnershipRejectsSelfTransferBeforePersistence(t *testing.T) {
	store := &groupStoreFake{}
	userID := uuid.New()
	if _, err := NewGroups(store).TransferOwnership(context.Background(), userID, uuid.New(), userID); err != ErrSelfOwnershipTransfer {
		t.Fatalf("self-transfer error = %v, want %v", err, ErrSelfOwnershipTransfer)
	}
	if store.transferCalls != 0 {
		t.Fatalf("persistence calls = %d, want 0", store.transferCalls)
	}
}
