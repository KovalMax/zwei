package application

import (
	"context"
	"errors"

	"github.com/google/uuid"
)

var ErrConversationNotFound = errors.New("conversation not found")

// ArchiveStore changes a user's archive state after verifying active membership.
type ArchiveStore interface {
	SetArchived(context.Context, uuid.UUID, uuid.UUID, bool) error
}

type Archive struct{ store ArchiveStore }

func NewArchive(store ArchiveStore) *Archive { return &Archive{store: store} }

func (a *Archive) Set(ctx context.Context, userID, conversationID uuid.UUID, archived bool) error {
	if userID == uuid.Nil || conversationID == uuid.Nil {
		return ErrConversationNotFound
	}
	return a.store.SetArchived(ctx, userID, conversationID, archived)
}
