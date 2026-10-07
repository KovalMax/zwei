package main

import (
	"context"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/KovalMax/zwei/services/internal/runtime"
	"github.com/KovalMax/zwei/services/realtime/internal/application"
	postgresinfra "github.com/KovalMax/zwei/services/realtime/internal/infrastructure/postgres"
	redisinfra "github.com/KovalMax/zwei/services/realtime/internal/infrastructure/redis"
	turninfra "github.com/KovalMax/zwei/services/realtime/internal/infrastructure/turn"
	websockettransport "github.com/KovalMax/zwei/services/realtime/internal/transport/websocket"
	sharedauth "github.com/KovalMax/zwei/services/shared/auth"
	"github.com/KovalMax/zwei/services/shared/messaging"
)

func main() {
	ctx, cancel := runtime.SignalContext()
	defer cancel()

	secret := os.Getenv("JWT_SECRET")
	if len(secret) < 32 {
		panic("JWT_SECRET must contain at least 32 bytes")
	}
	origins, err := runtime.ParseOrigins(getenv("ALLOWED_ORIGINS", "https://chat.localhost"))
	if err != nil {
		panic(err)
	}
	databaseURL := getenv("DATABASE_URL", "postgres://messenger_user:user-password@database:5432/messenger?sslmode=disable")
	db, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		panic(err)
	}
	defer db.Close()
	if err := db.Ping(ctx); err != nil {
		panic(err)
	}
	encryptionSecret := getenv("MESSAGE_ENCRYPTION_KEY", "local-development-key-change-me")
	turnURLs := strings.Split(getenv("TURN_URLS", "turn:turn.chat.localhost:3478?transport=udp,turn:turn.chat.localhost:3478?transport=tcp"), ",")
	turnIssuer, err := turninfra.NewCredentialIssuer(getenv("TURN_SHARED_SECRET", "local-development-turn-shared-secret-change-me"), turnURLs, 2*time.Hour)
	if err != nil {
		panic(err)
	}
	coordination, err := redisinfra.NewPresenceCoordinator(getenv("REDIS_URL", "redis://redis:6379/0"))
	if err != nil {
		panic(err)
	}
	defer coordination.Close()
	if err := coordination.Ping(ctx); err != nil {
		panic(err)
	}
	presence := postgresinfra.NewPresenceRepository(db)
	groupCall := postgresinfra.NewGroupCallRepository(db)
	hub := application.NewHubWithGroupCallAuthorizer(messaging.NewSender(db, encryptionSecret), presence, groupCall, coordination, messaging.NewDeliveryRepository(db, encryptionSecret), postgresinfra.NewReadCursorRepository(db), postgresinfra.NewReconciliationRepository(db, encryptionSecret), coordination, turnIssuer, runtime.NewLogger())
	go coordination.StartHeartbeat(ctx)
	go func() {
		superviseRedisSubscription(ctx, func(subscriptionContext context.Context) error {
			return coordination.Consume(subscriptionContext, func(change redisinfra.Change) {
				hub.NotifyPresenceChanged(subscriptionContext, change.UserID, change.Online)
			})
		})
	}()
	go func() {
		superviseRedisSubscription(ctx, func(subscriptionContext context.Context) error {
			return coordination.ConsumeConversations(subscriptionContext, func(change redisinfra.ConversationChange) {
				if change.MembershipRevision > 0 {
					hub.DeliverGroupProjection(subscriptionContext, change.ConversationID, change.MembershipRevision, change.Deleted, change.UserIDs)
					return
				}
				_ = hub.DeliverConversationCreated(subscriptionContext, change.ConversationID, change.UserIDs)
			})
		})
	}()
	go func() {
		superviseRedisSubscription(ctx, func(subscriptionContext context.Context) error {
			return coordination.ConsumeTyping(subscriptionContext, func(change redisinfra.TypingChange) {
				eventType := "typing.stopped"
				if change.Started {
					eventType = "typing.started"
				}
				_ = hub.DeliverTypingToConversation(subscriptionContext, eventType, change.ConversationID, change.UserID)
			})
		})
	}()
	go func() {
		superviseRedisSubscription(ctx, func(subscriptionContext context.Context) error {
			return coordination.ConsumeMessages(subscriptionContext, func(change redisinfra.MessageChange) { hub.DeliverMessageCreated(change.Message) })
		})
	}()
	go func() {
		superviseRedisSubscription(ctx, func(subscriptionContext context.Context) error {
			return coordination.ConsumeReads(subscriptionContext, func(change redisinfra.ReadChange) {
				if len(change.RecipientIDs) == 0 && change.RecipientID != uuid.Nil {
					change.RecipientIDs = []uuid.UUID{change.RecipientID}
				}
				hub.DeliverReadCursor(change.ReaderID, change.RecipientIDs, change.ConversationID, change.Sequence, change.VisibleFromSequence)
			})
		})
	}()
	go func() {
		superviseRedisSubscription(ctx, func(subscriptionContext context.Context) error {
			return coordination.ConsumeCalls(subscriptionContext, hub.DeliverCall)
		})
	}()
	go func() {
		superviseRedisSubscription(ctx, func(subscriptionContext context.Context) error {
			return coordination.ConsumeGroupRooms(subscriptionContext, hub.DeliverGroupRoom)
		})
	}()
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				calls, err := coordination.ExpireCalls(ctx)
				if err == nil {
					for _, call := range calls {
						hub.DeliverCall(application.CallChange{Type: "ended", Call: call})
						_ = coordination.PublishCall(ctx, application.CallChange{Type: "ended", Call: call})
					}
				}
				// This service-owned loop claims logical group-room expiries and
				// stops with the process context. Redis TTL retains only a short
				// terminal snapshot; it cannot itself notify the room participants.
				if rooms, err := coordination.ExpireGroupRooms(ctx, 100); err == nil {
					hub.NotifyExpiredGroupRooms(ctx, rooms)
				}
			}
		}
	}()
	outbox := postgresinfra.NewOutboxRepository(db)
	go consumeConversationEvents(ctx, outbox, hub)
	handler := websockettransport.NewHandler(ctx, hub, sharedauth.NewSessionValidator(db, []byte(secret)), coordination, origins)
	mux := runtime.NewHealthHandler("realtime")
	mux.Handle("GET /ws", handler)
	mux.Handle("GET /ws/v2", websockettransport.NewVersionedHandler(ctx, hub, sharedauth.NewSessionValidator(db, []byte(secret)), coordination, origins, 2))
	server := &http.Server{
		Addr:    ":" + getenv("REALTIME_PORT", "8083"),
		Handler: mux,
	}
	runtime.ConfigureWebSocketServer(server)
	if err := runtime.RunHTTP(ctx, runtime.NewLogger(), server); err != nil {
		panic(err)
	}
}

type conversationEventOutbox interface {
	ClaimConversationCreated(context.Context, int) ([]postgresinfra.ConversationCreatedEvent, error)
	MarkProcessed(context.Context, postgresinfra.ConversationCreatedEvent) error
	Release(context.Context, postgresinfra.ConversationCreatedEvent) error
}

type conversationEventNotifier interface {
	NotifyConversationCreated(context.Context, uuid.UUID, []uuid.UUID) error
	NotifyGroupProjection(context.Context, uuid.UUID, int64, bool, []uuid.UUID) error
}

const (
	conversationOutboxBatchSize      = 100
	conversationOutboxClaimTimeout   = 5 * time.Second
	conversationOutboxEventTimeout   = 10 * time.Second
	conversationOutboxReleaseTimeout = 2 * time.Second
)

func consumeConversationEvents(ctx context.Context, outbox conversationEventOutbox, hub conversationEventNotifier) {
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			processConversationEvents(ctx, outbox, hub)
		}
	}
}

func processConversationEvents(ctx context.Context, outbox conversationEventOutbox, hub conversationEventNotifier) {
	claimCtx, cancelClaim := context.WithTimeout(ctx, conversationOutboxClaimTimeout)
	events, err := outbox.ClaimConversationCreated(claimCtx, conversationOutboxBatchSize)
	cancelClaim()
	if err != nil {
		return
	}
	for _, event := range events {
		if ctx.Err() != nil {
			_ = releaseConversationEvent(ctx, outbox, event)
			return
		}
		eventCtx, cancelEvent := context.WithTimeout(ctx, conversationOutboxEventTimeout)
		if event.EventType == "group.membership.changed" {
			err = hub.NotifyGroupProjection(eventCtx, event.ConversationID, event.MembershipRevision, event.Deleted, event.UserIDs)
		} else {
			err = hub.NotifyConversationCreated(eventCtx, event.ConversationID, event.UserIDs)
		}
		if err == nil {
			err = outbox.MarkProcessed(eventCtx, event)
		}
		cancelEvent()
		if err != nil {
			_ = releaseConversationEvent(ctx, outbox, event)
			if ctx.Err() != nil {
				return
			}
		}
	}
}

func releaseConversationEvent(ctx context.Context, outbox conversationEventOutbox, event postgresinfra.ConversationCreatedEvent) error {
	// Cleanup gets a small bounded grace period even when service shutdown has
	// canceled the processing context, so the durable claim is promptly reusable.
	releaseCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), conversationOutboxReleaseTimeout)
	defer cancel()
	return outbox.Release(releaseCtx, event)
}

func superviseRedisSubscription(ctx context.Context, consume func(context.Context) error) {
	backoff := time.Second
	for {
		if err := consume(ctx); ctx.Err() != nil {
			return
		} else if err == nil {
			backoff = time.Second
		} else {
			timer := time.NewTimer(backoff)
			select {
			case <-ctx.Done():
				if !timer.Stop() {
					<-timer.C
				}
				return
			case <-timer.C:
			}
			backoff *= 2
			if backoff > 30*time.Second {
				backoff = 30 * time.Second
			}
		}
	}
}

func getenv(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
