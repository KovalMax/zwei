package application

import (
	"context"
	"encoding/json"
	"errors"
	"sync"

	"github.com/google/uuid"

	sharedauth "github.com/KovalMax/zwei/services/shared/auth"
	"github.com/KovalMax/zwei/services/shared/messaging"
)

type Client interface {
	Identity() sharedauth.Identity
	SendJSON(any)
	Close()
}

type Hub struct {
	sender  *messaging.Sender
	mu      sync.RWMutex
	clients map[string]Client
}

func NewHub(sender *messaging.Sender) *Hub {
	return &Hub{sender: sender, clients: make(map[string]Client)}
}

func (h *Hub) Add(client Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.clients[key(client.Identity())] = client
}
func (h *Hub) Remove(client Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.clients, key(client.Identity()))
}

func (h *Hub) Handle(ctx context.Context, client Client, payload []byte) error {
	var request struct {
		Type      string `json:"type"`
		RequestID string `json:"request_id,omitempty"`
		Payload   struct {
			ConversationID  uuid.UUID `json:"conversation_id"`
			ClientMessageID string    `json:"client_message_id"`
			Body            string    `json:"body"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(payload, &request); err != nil || request.Type != "message.send" {
		return errors.New("unsupported event")
	}
	message, created, err := h.sender.Send(ctx, messaging.SendRequest{SenderID: client.Identity().UserID, ConversationID: request.Payload.ConversationID, ClientMessageID: request.Payload.ClientMessageID, Body: request.Payload.Body})
	if err != nil {
		return err
	}
	client.SendJSON(serverEvent{Type: "message.accepted", RequestID: request.RequestID, Payload: message})
	if created {
		for _, recipient := range h.recipients(message.RecipientID) {
			recipient.SendJSON(serverEvent{Type: "message.created", Payload: message})
		}
	}
	return nil
}

type serverEvent struct {
	Type      string `json:"type"`
	RequestID string `json:"request_id,omitempty"`
	Payload   any    `json:"payload,omitempty"`
}

func (h *Hub) recipients(userID uuid.UUID) []Client {
	h.mu.RLock()
	defer h.mu.RUnlock()
	recipients := make([]Client, 0)
	for _, client := range h.clients {
		if client.Identity().UserID == userID {
			recipients = append(recipients, client)
		}
	}
	return recipients
}
func key(identity sharedauth.Identity) string {
	return identity.UserID.String() + ":" + identity.DeviceID
}
