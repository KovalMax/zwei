package application

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
)

const (
	GroupRoomRinging  = "ringing"
	GroupRoomActive   = "active"
	GroupRoomEnded    = "ended"
	GroupRoomCapacity = 4
)

var ErrGroupRoomFull = errors.New("group call is full (maximum 4 participants)")

// GroupRoom is ephemeral signaling coordination state. PostgreSQL membership
// remains authoritative and is checked by the transport before each command.
type GroupRoom struct {
	ID                 uuid.UUID          `json:"room_id"`
	ConversationID     uuid.UUID          `json:"conversation_id"`
	MembershipRevision int64              `json:"membership_revision"`
	Generation         int64              `json:"generation"`
	StateRevision      int64              `json:"state_revision"`
	Status             string             `json:"status"`
	ExpiresAt          time.Time          `json:"expires_at"`
	Participants       []GroupParticipant `json:"participants"`
	Presenter          *GroupParticipant  `json:"presenter,omitempty"`
}

// GroupParticipant binds membership to the opaque socket that joined the room.
// ConnectionID is intentionally excluded from browser payloads.
type GroupParticipant struct {
	UserID       uuid.UUID `json:"user_id"`
	DeviceID     string    `json:"device_id"`
	ConnectionID string    `json:"-"`
}

// GroupRoomCoordinator owns only ephemeral cross-replica room state.
type GroupRoomCoordinator interface {
	StartGroupRoom(context.Context, GroupRoom, string) (GroupRoom, error)
	JoinGroupRoom(context.Context, uuid.UUID, GroupParticipant, int64, string) (GroupRoom, error)
	LeaveGroupRoom(context.Context, uuid.UUID, GroupParticipant) (GroupRoom, error)
	EndGroupRoom(context.Context, uuid.UUID, GroupParticipant) (GroupRoom, error)
	AbortGroupRoomStart(context.Context, uuid.UUID, int64, GroupParticipant) error
	GetGroupRoom(context.Context, uuid.UUID) (GroupRoom, error)
	GetGroupRoomForConversation(context.Context, uuid.UUID) (GroupRoom, error)
	SyncGroupRoom(context.Context, uuid.UUID, int64, GroupParticipant) (GroupRoom, bool, error)
	SetGroupPresenter(context.Context, uuid.UUID, GroupParticipant, bool) (GroupRoom, error)
	RemoveGroupConnection(context.Context, uuid.UUID, string, string) ([]GroupRoom, error)
	EndGroupRoomForMembershipChange(context.Context, uuid.UUID, uuid.UUID, int64, int64, int64) (GroupRoom, error)
	ExpireGroupRooms(context.Context, int) ([]GroupRoom, error)
	PublishGroupRoom(context.Context, GroupRoomChange) error
}

// GroupRoomChange is an internal pub/sub envelope. Connection IDs are retained
// for routing but are never copied into browser payloads.
type GroupRoomChange struct {
	Source       string    `json:"source,omitempty"`
	Type         string    `json:"type"`
	Room         GroupRoom `json:"room"`
	FromUserID   uuid.UUID `json:"from_user_id,omitempty"`
	FromDeviceID string    `json:"from_device_id,omitempty"`
	ToUserID     uuid.UUID `json:"to_user_id,omitempty"`
	ToDeviceID   string    `json:"to_device_id,omitempty"`
	ConnectionID string    `json:"connection_id,omitempty"`
	// ParticipantConnectionIDs is internal pub/sub routing metadata. It restores
	// opaque socket ownership after a GroupRoom crosses Redis; it is never
	// included in the browser event payload.
	ParticipantConnectionIDs map[string]string `json:"participant_connection_ids,omitempty"`
	RecipientUserIDs         []uuid.UUID       `json:"recipient_user_ids,omitempty"`
	// MembershipProjectionRevision and MembershipProjectionDeleted are trusted
	// internal outbox metadata used only to validate projection-driven endings.
	MembershipProjectionRevision int64           `json:"membership_projection_revision"`
	MembershipProjectionDeleted  bool            `json:"membership_projection_deleted"`
	Signal                       json.RawMessage `json:"signal,omitempty"`
}

type GroupRoomConsumer interface {
	ConsumeGroupRooms(context.Context, func(context.Context, GroupRoomChange)) error
}

// GroupCallAuthorizer holds the conversation membership lock while a group-call
// command mutates ephemeral state and publishes its resulting event.
type GroupCallAuthorizer interface {
	BeginGroupCall(context.Context, uuid.UUID, uuid.UUID) (GroupCallLease, error)
}

// GroupProjectionVerifier checks a membership projection without requiring an
// actor to remain an active member (which is not true after removal).
type GroupProjectionVerifier interface {
	GroupMembershipRevision(context.Context, uuid.UUID) (int64, error)
}

type GroupCallLease interface {
	MembershipRevision() int64
	ActiveMemberIDs() []uuid.UUID
	Commit(context.Context) error
	Rollback(context.Context) error
}
