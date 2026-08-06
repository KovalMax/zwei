package application

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
)

const (
	CallRinging = "ringing"
	CallActive  = "active"
	CallEnded   = "ended"
)

var (
	ErrCallUnavailable = errors.New("call unavailable")
	ErrCallBusy        = errors.New("user is already in a call")
	ErrCallNotFound    = errors.New("call not found")
	ErrCallNotAllowed  = errors.New("call not allowed")
	ErrCallTaken       = errors.New("call already accepted")
)

// Call is ephemeral shared signaling state. It is deliberately not a persisted domain aggregate.
type Call struct {
	ID               uuid.UUID `json:"call_id"`
	ConversationID   uuid.UUID `json:"conversation_id"`
	CallerID         uuid.UUID `json:"caller_id"`
	RecipientID      uuid.UUID `json:"recipient_id"`
	CallerDeviceID   string    `json:"caller_device_id"`
	AcceptedDeviceID string    `json:"accepted_device_id,omitempty"`
	Status           string    `json:"status"`
	ExpiresAt        time.Time `json:"expires_at"`
}

type CallChange struct {
	Source       string          `json:"source,omitempty"`
	Type         string          `json:"type"`
	Call         Call            `json:"call"`
	FromDeviceID string          `json:"from_device_id,omitempty"`
	ToDeviceID   string          `json:"to_device_id,omitempty"`
	Signal       json.RawMessage `json:"signal,omitempty"`
}

// ICEServer is the browser-safe TURN configuration for one call participant.
// It deliberately contains no shared TURN secret.
type ICEServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username"`
	Credential string   `json:"credential"`
}

type TURNCredentialIssuer interface {
	Issue(Call, uuid.UUID) (ICEServer, error)
}

// CallCoordinator is the application port for atomic, cross-replica call state and fan-out.
type CallCoordinator interface {
	Start(context.Context, Call) (Call, error)
	Accept(context.Context, uuid.UUID, uuid.UUID, string) (Call, error)
	Decline(context.Context, uuid.UUID, uuid.UUID, string) (Call, error)
	Cancel(context.Context, uuid.UUID, uuid.UUID, string) (Call, error)
	End(context.Context, uuid.UUID, uuid.UUID, string) (Call, error)
	EndByDevice(context.Context, uuid.UUID, string) ([]Call, error)
	Get(context.Context, uuid.UUID) (Call, error)
	PublishCall(context.Context, CallChange) error
}

type CallConsumer interface {
	ConsumeCalls(context.Context, func(CallChange)) error
}

type CallExpiryCoordinator interface {
	ExpireCalls(context.Context) ([]Call, error)
}
