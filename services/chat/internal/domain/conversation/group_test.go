package conversation

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/google/uuid"
)

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
	if name, err := NewGroupName(strings.Repeat("界", 80)); err != nil || utf8.RuneCountInString(name) != 80 {
		t.Fatalf("NewGroupName() rejected 80-character multibyte name: %v", err)
	}
	if _, err := NewGroupName(strings.Repeat("界", 81)); err != ErrInvalidGroupName {
		t.Fatalf("NewGroupName() accepted an 81-character multibyte name: %v", err)
	}
}

func TestGroupRoles(t *testing.T) {
	if !ValidRole(RoleOwner) || !ValidRole(RoleAdmin) || !ValidRole(RoleMember) || ValidRole("operator") {
		t.Fatal("ValidRole() did not preserve the group role invariant")
	}
}

func TestGroupMemberJSONDoesNotExposeEmail(t *testing.T) {
	encoded, err := json.Marshal(GroupMember{UserID: uuid.New(), DisplayName: "Member", Role: RoleMember})
	if err != nil {
		t.Fatalf("marshal group member: %v", err)
	}
	if bytes.Contains(encoded, []byte(`"email"`)) {
		t.Fatalf("group member projection exposed an email: %s", encoded)
	}
}
