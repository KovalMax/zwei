package application

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
)

type archiveStoreFake struct {
	userID, conversationID uuid.UUID
	archived               bool
	err                    error
	calls                  int
}

func (f *archiveStoreFake) SetArchived(_ context.Context, userID, conversationID uuid.UUID, archived bool) error {
	f.calls++
	f.userID, f.conversationID, f.archived = userID, conversationID, archived
	return f.err
}

func TestArchiveSetUsesCallerAndPropagatesStoreResult(t *testing.T) {
	userID, conversationID := uuid.New(), uuid.New()
	wantErr := errors.New("storage failure")
	store := &archiveStoreFake{err: wantErr}
	err := NewArchive(store).Set(context.Background(), userID, conversationID, true)
	if !errors.Is(err, wantErr) || store.calls != 1 || store.userID != userID || store.conversationID != conversationID || !store.archived {
		t.Fatalf("Set result=%v store=%+v", err, store)
	}
}

func TestArchiveSetRejectsMissingIdentityBeforeStore(t *testing.T) {
	store := &archiveStoreFake{}
	if err := NewArchive(store).Set(context.Background(), uuid.Nil, uuid.New(), true); err != ErrConversationNotFound {
		t.Fatalf("error=%v, want %v", err, ErrConversationNotFound)
	}
	if store.calls != 0 {
		t.Fatalf("store calls=%d, want 0", store.calls)
	}
}
