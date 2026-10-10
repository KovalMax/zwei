package application

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/KovalMax/zwei/services/chat/internal/domain/conversation"
)

type groupStoreFake struct {
	created         []uuid.UUID
	changeRoleCalls int
	transferCalls   int
	groups          []conversation.Group
	pageCalls       int
	pageLimit       int
	pageCursor      *GroupPageCursor
}

func (f *groupStoreFake) CreateGroup(_ context.Context, _ uuid.UUID, _ string, members []uuid.UUID) (conversation.Group, error) {
	f.created = members
	return conversation.Group{}, nil
}
func (f *groupStoreFake) GetGroup(context.Context, uuid.UUID, uuid.UUID) (conversation.Group, error) {
	return conversation.Group{}, nil
}
func (f *groupStoreFake) ListGroupsPage(_ context.Context, _ uuid.UUID, limit int, _ bool, cursor *GroupPageCursor) (GroupPage, error) {
	f.pageCalls++
	f.pageLimit, f.pageCursor = limit, cursor
	return GroupPage{Items: f.groups}, nil
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

func TestListPageReturnsAuthorizedStoreProjection(t *testing.T) {
	want := []conversation.Group{{ID: uuid.New()}}
	groups, err := NewGroups(&groupStoreFake{groups: want}).ListPage(context.Background(), uuid.New(), 25, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(groups.Items) != 1 || groups.Items[0].ID != want[0].ID {
		t.Fatalf("groups = %#v, want %#v", groups, want)
	}
}

func TestListPageRejectsInvalidBoundsAndCursorBeforeStore(t *testing.T) {
	store := &groupStoreFake{}
	groups := NewGroups(store)
	valid := GroupSortKey{SortAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), GroupID: uuid.New()}
	for _, test := range []struct {
		name   string
		limit  int
		cursor *GroupPageCursor
	}{
		{name: "zero limit", limit: 0},
		{name: "over maximum", limit: 26},
		{name: "missing upper tuple", limit: 25, cursor: &GroupPageCursor{After: valid}},
		{name: "after is newer than upper", limit: 25, cursor: &GroupPageCursor{Upper: valid, After: GroupSortKey{SortAt: valid.SortAt.Add(time.Second), GroupID: valid.GroupID}}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := groups.ListPage(context.Background(), uuid.New(), test.limit, false, test.cursor); err != ErrInvalidGroupPage {
				t.Fatalf("error = %v, want %v", err, ErrInvalidGroupPage)
			}
		})
	}
	if store.pageCalls != 0 {
		t.Fatalf("store calls = %d, want 0", store.pageCalls)
	}
}

func TestListPageRejectsCursorFromOtherArchiveScope(t *testing.T) {
	store := &groupStoreFake{}
	key := GroupSortKey{SortAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), GroupID: uuid.New()}
	for _, test := range []struct {
		archived       bool
		cursorArchived bool
	}{{false, true}, {true, false}} {
		cursor := &GroupPageCursor{Upper: key, After: key, Archived: test.cursorArchived}
		if _, err := NewGroups(store).ListPage(context.Background(), uuid.New(), 25, test.archived, cursor); err != ErrInvalidGroupPage {
			t.Fatalf("request archived=%t cursor archived=%t error = %v, want %v", test.archived, test.cursorArchived, err, ErrInvalidGroupPage)
		}
	}
	if store.pageCalls != 0 {
		t.Fatalf("store calls = %d, want 0", store.pageCalls)
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
