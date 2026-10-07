package main

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"

	postgresinfra "github.com/KovalMax/zwei/services/realtime/internal/infrastructure/postgres"
)

type conversationOutboxFake struct {
	events             []postgresinfra.ConversationCreatedEvent
	claimErr           error
	markErr            error
	claimed            bool
	marked             int
	released           int
	claimHasLimit      bool
	releaseHasDeadline bool
}

func (f *conversationOutboxFake) ClaimConversationCreated(ctx context.Context, limit int) ([]postgresinfra.ConversationCreatedEvent, error) {
	_, f.claimHasLimit = ctx.Deadline()
	f.claimed = limit == conversationOutboxBatchSize
	return f.events, f.claimErr
}

func (f *conversationOutboxFake) MarkProcessed(ctx context.Context, _ postgresinfra.ConversationCreatedEvent) error {
	if _, ok := ctx.Deadline(); !ok {
		return errors.New("mark context has no deadline")
	}
	f.marked++
	return f.markErr
}

func (f *conversationOutboxFake) Release(ctx context.Context, _ postgresinfra.ConversationCreatedEvent) error {
	_, f.releaseHasDeadline = ctx.Deadline()
	f.released++
	return nil
}

type conversationNotifierFake struct {
	err                error
	called             bool
	contextHasDeadline bool
}

func (f *conversationNotifierFake) NotifyConversationCreated(ctx context.Context, _ uuid.UUID, _ []uuid.UUID) error {
	f.called = true
	_, f.contextHasDeadline = ctx.Deadline()
	return f.err
}

func (*conversationNotifierFake) NotifyGroupProjection(context.Context, uuid.UUID, int64, bool, []uuid.UUID) error {
	return nil
}

func TestProcessConversationEventsBoundsOperationsAndReleasesFailedPublish(t *testing.T) {
	event := postgresinfra.ConversationCreatedEvent{ID: uuid.New(), ClaimToken: uuid.New(), ConversationID: uuid.New(), UserIDs: []uuid.UUID{uuid.New()}}
	outbox := &conversationOutboxFake{events: []postgresinfra.ConversationCreatedEvent{event}}
	notifier := &conversationNotifierFake{err: errors.New("publish failed")}

	processConversationEvents(context.Background(), outbox, notifier)

	if !outbox.claimed || !outbox.claimHasLimit {
		t.Fatal("claim did not use the expected batch size and bounded context")
	}
	if !notifier.called || !notifier.contextHasDeadline {
		t.Fatal("notification did not receive a bounded event context")
	}
	if outbox.marked != 0 || outbox.released != 1 || !outbox.releaseHasDeadline {
		t.Fatalf("marked=%d released=%d release deadline=%v; want 0, 1, true", outbox.marked, outbox.released, outbox.releaseHasDeadline)
	}
}

func TestProcessConversationEventsMarksSuccessfulPublish(t *testing.T) {
	event := postgresinfra.ConversationCreatedEvent{ID: uuid.New(), ClaimToken: uuid.New(), ConversationID: uuid.New()}
	outbox := &conversationOutboxFake{events: []postgresinfra.ConversationCreatedEvent{event}}
	notifier := &conversationNotifierFake{}

	processConversationEvents(context.Background(), outbox, notifier)

	if !notifier.called || outbox.marked != 1 || outbox.released != 0 {
		t.Fatalf("called=%v marked=%d released=%d; want true, 1, 0", notifier.called, outbox.marked, outbox.released)
	}
}

func TestProcessConversationEventsReleasesWhenMarkFails(t *testing.T) {
	event := postgresinfra.ConversationCreatedEvent{ID: uuid.New(), ClaimToken: uuid.New(), ConversationID: uuid.New()}
	outbox := &conversationOutboxFake{
		events:  []postgresinfra.ConversationCreatedEvent{event},
		markErr: errors.New("mark failed"),
	}
	notifier := &conversationNotifierFake{}

	processConversationEvents(context.Background(), outbox, notifier)

	if !notifier.called || outbox.marked != 1 || outbox.released != 1 || !outbox.releaseHasDeadline {
		t.Fatalf("called=%v marked=%d released=%d release deadline=%v; want true, 1, 1, true", notifier.called, outbox.marked, outbox.released, outbox.releaseHasDeadline)
	}
}

func TestProcessConversationEventsReleasesClaimsDuringShutdown(t *testing.T) {
	event := postgresinfra.ConversationCreatedEvent{ID: uuid.New(), ClaimToken: uuid.New()}
	outbox := &conversationOutboxFake{events: []postgresinfra.ConversationCreatedEvent{event}}
	notifier := &conversationNotifierFake{}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	processConversationEvents(ctx, outbox, notifier)

	if notifier.called || outbox.marked != 0 || outbox.released != 1 || !outbox.releaseHasDeadline {
		t.Fatalf("called=%v marked=%d released=%d release deadline=%v; want false, 0, 1, true", notifier.called, outbox.marked, outbox.released, outbox.releaseHasDeadline)
	}
}

func TestConversationEventOperationTimeoutsAreBounded(t *testing.T) {
	if conversationOutboxClaimTimeout <= 0 || conversationOutboxClaimTimeout >= 30*time.Second {
		t.Fatalf("claim timeout = %s; want positive and less than the 30s claim lease", conversationOutboxClaimTimeout)
	}
	if conversationOutboxEventTimeout <= 0 || conversationOutboxEventTimeout >= 30*time.Second {
		t.Fatalf("event timeout = %s; want positive and less than the 30s claim lease", conversationOutboxEventTimeout)
	}
}
