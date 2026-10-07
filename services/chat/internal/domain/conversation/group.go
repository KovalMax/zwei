package conversation

import (
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
)

const MaxGroupMembers = 16

var (
	ErrInvalidGroupName = errors.New("group name must be 1-80 characters")
	ErrInvalidMembers   = errors.New("group must have at most 16 distinct members")
	ErrInvalidRole      = errors.New("invalid group role")
)

type Role string

const (
	RoleOwner  Role = "owner"
	RoleAdmin  Role = "admin"
	RoleMember Role = "member"
)

func NewGroupName(name string) (string, error) {
	name = strings.TrimSpace(name)
	length := utf8.RuneCountInString(name)
	if length == 0 || length > 80 {
		return "", ErrInvalidGroupName
	}
	return name, nil
}

func ValidRole(role Role) bool { return role == RoleOwner || role == RoleAdmin || role == RoleMember }

type GroupMember struct {
	UserID              uuid.UUID `json:"user_id"`
	DisplayName         string    `json:"display_name"`
	Role                Role      `json:"role"`
	VisibleFromSequence int64     `json:"visible_from_sequence"`
	JoinedAt            time.Time `json:"joined_at"`
}

type Group struct {
	ID                 uuid.UUID     `json:"id"`
	Name               string        `json:"name"`
	AvatarSeed         uuid.UUID     `json:"avatar_seed"`
	OwnerID            uuid.UUID     `json:"owner_id"`
	MembershipRevision int64         `json:"membership_revision"`
	CreatedAt          time.Time     `json:"created_at"`
	LastMessageAt      time.Time     `json:"last_message_at"`
	Members            []GroupMember `json:"members"`
}
