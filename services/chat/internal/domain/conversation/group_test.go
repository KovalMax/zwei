package conversation

import "testing"

func TestNewGroupName(t *testing.T) {
	name, err := NewGroupName("  Project team  ")
	if err != nil || name != "Project team" {
		t.Fatalf("NewGroupName() = %q, %v", name, err)
	}
	for _, value := range []string{"", string(make([]byte, 81))} {
		if _, err := NewGroupName(value); err != ErrInvalidGroupName {
			t.Fatalf("NewGroupName(%q) error = %v", value, err)
		}
	}
}

func TestGroupRoles(t *testing.T) {
	if !ValidRole(RoleOwner) || !ValidRole(RoleAdmin) || !ValidRole(RoleMember) || ValidRole("operator") {
		t.Fatal("ValidRole() did not preserve the group role invariant")
	}
}
