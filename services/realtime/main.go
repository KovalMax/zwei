package main

import (
	"context"
	"encoding/hex"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/KovalMax/zwei/services/internal/runtime"
	"github.com/KovalMax/zwei/services/realtime/internal/application"
	"github.com/KovalMax/zwei/services/realtime/internal/application/callpush"
	"github.com/KovalMax/zwei/services/realtime/internal/application/messagepush"
	postgresinfra "github.com/KovalMax/zwei/services/realtime/internal/infrastructure/postgres"
	redisinfra "github.com/KovalMax/zwei/services/realtime/internal/infrastructure/redis"
	turninfra "github.com/KovalMax/zwei/services/realtime/internal/infrastructure/turn"
	webpushinfra "github.com/KovalMax/zwei/services/realtime/internal/infrastructure/webpush"
	websockettransport "github.com/KovalMax/zwei/services/realtime/internal/transport/websocket"
	sharedauth "github.com/KovalMax/zwei/services/shared/auth"
	"github.com/KovalMax/zwei/services/shared/messaging"
	"github.com/KovalMax/zwei/services/shared/pushcrypto"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(logger)
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
	codec, err := pushCodecFromEnvironment()
	if err != nil {
		panic(err)
	}
	if err := postgresinfra.EnsurePushFingerprintKeyIdentity(ctx, db, codec); err != nil {
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
	hub := application.NewHubWithGroupCallAuthorizer(messaging.NewSender(db, encryptionSecret), presence, groupCall, coordination, messaging.NewDeliveryRepository(db, encryptionSecret), postgresinfra.NewReadCursorRepository(db), postgresinfra.NewReconciliationRepository(db, encryptionSecret), coordination, turnIssuer, logger)
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
					hub.NotifyExpiredCalls(ctx, calls)
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
	var pushWorkerDone chan struct{}
	var callPushDone chan struct{}
	if dispatcher, enabled, err := newMessagePushDispatcher(db, coordination); err != nil {
		panic(err)
	} else if enabled {
		pushWorkerDone = make(chan struct{})
		go func() { defer close(pushWorkerDone); consumeMessagePushIntents(ctx, dispatcher, logger) }()
		queue, err := newCallPushQueue(db, coordination, coordination, groupCall)
		if err != nil {
			panic(err)
		}
		hub.SetCallPushQueue(queue)
		callPushDone = make(chan struct{})
		go func() { defer close(callPushDone); queue.Run(ctx) }()
	}
	mux := runtime.NewHealthHandler("realtime")
	mux.Handle("GET /ws/v2", websockettransport.NewHandler(ctx, hub, sharedauth.NewSessionValidator(db, []byte(secret)), coordination, origins))
	server := &http.Server{
		Addr:    ":" + getenv("REALTIME_PORT", "8083"),
		Handler: mux,
	}
	runtime.ConfigureWebSocketServer(server)
	serverErr := runtime.RunHTTP(ctx, logger, server)
	cancel()
	if pushWorkerDone != nil {
		<-pushWorkerDone
	}
	if callPushDone != nil {
		<-callPushDone
	}
	if serverErr != nil {
		panic(serverErr)
	}
}

func newCallPushQueue(db *pgxpool.Pool, presence *redisinfra.PresenceCoordinator, calls application.CallCoordinator, authorizer application.GroupCallAuthorizer) (*callpush.Queue, error) {
	publicKey, privateKey, subject := os.Getenv("VAPID_PUBLIC_KEY"), os.Getenv("VAPID_PRIVATE_KEY"), os.Getenv("VAPID_SUBJECT")
	codec, err := pushCodecFromEnvironment()
	if err != nil {
		return nil, err
	}
	sender, err := webpushinfra.New(publicKey, privateKey, subject, nil)
	if err != nil {
		return nil, err
	}
	vapidKeyID, err := pushcrypto.VAPIDFingerprint(publicKey)
	if err != nil {
		return nil, err
	}
	repository := postgresinfra.NewCallPushRepository(db, codec, vapidKeyID, calls, presence, authorizer)
	return callpush.New(repository, presence, sender, 64), nil
}

func newMessagePushDispatcher(db *pgxpool.Pool, presence *redisinfra.PresenceCoordinator) (*messagepush.Dispatcher, bool, error) {
	publicKey, privateKey, subject := os.Getenv("VAPID_PUBLIC_KEY"), os.Getenv("VAPID_PRIVATE_KEY"), os.Getenv("VAPID_SUBJECT")
	if publicKey == "" && privateKey == "" && subject == "" {
		return nil, false, nil
	}
	if publicKey == "" || privateKey == "" || subject == "" {
		return nil, false, errors.New("incomplete VAPID configuration")
	}
	codec, err := pushCodecFromEnvironment()
	if err != nil {
		return nil, false, err
	}
	sender, err := webpushinfra.New(publicKey, privateKey, subject, nil)
	if err != nil {
		return nil, false, errors.New("invalid VAPID configuration")
	}
	vapidKeyID, err := pushcrypto.VAPIDFingerprint(publicKey)
	if err != nil {
		return nil, false, errors.New("invalid VAPID configuration")
	}
	return messagepush.New(postgresinfra.NewMessagePushOutbox(db, codec, vapidKeyID), presence, sender), true, nil
}

func pushCodecFromEnvironment() (*pushcrypto.Codec, error) {
	keys := make(map[string][]byte)
	for version, name := range map[string]string{"v1": "PUSH_SUBSCRIPTION_ENCRYPTION_KEY_V1", "v2": "PUSH_SUBSCRIPTION_ENCRYPTION_KEY_V2"} {
		value := os.Getenv(name)
		if value == "" {
			continue
		}
		key, err := hex.DecodeString(value)
		if err != nil || len(key) != 32 {
			return nil, errors.New("invalid push subscription encryption configuration")
		}
		keys[version] = key
	}
	current := os.Getenv("PUSH_SUBSCRIPTION_ENCRYPTION_CURRENT_VERSION")
	if current == "" {
		current = "v1"
	}
	if current != "v1" && current != "v2" {
		return nil, errors.New("invalid current push subscription encryption version")
	}
	if current == "v2" && len(keys["v1"]) != 32 {
		return nil, errors.New("v2 rotation requires retaining PUSH_SUBSCRIPTION_ENCRYPTION_KEY_V1 for old rows")
	}
	fingerprint, err := hex.DecodeString(os.Getenv("PUSH_SUBSCRIPTION_FINGERPRINT_KEY"))
	if err != nil || len(fingerprint) < 32 {
		return nil, errors.New("invalid push subscription fingerprint configuration")
	}
	codec, err := pushcrypto.NewKeyring(keys, current, fingerprint)
	if err != nil {
		return nil, errors.New("invalid push subscription encryption configuration")
	}
	return codec, nil
}

func consumeMessagePushIntents(ctx context.Context, dispatcher *messagepush.Dispatcher, logger *slog.Logger) {
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			workCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
			err := dispatcher.Process(workCtx, 4)
			cancel()
			if err != nil && ctx.Err() == nil {
				var diagnostic *messagepush.DiagnosticError
				if errors.As(err, &diagnostic) {
					reason := "internal"
					switch diagnostic.Reason {
					case "resolve_failed", "presence_failed", "provider_failed", "internal":
						reason = diagnostic.Reason
					}
					if reason == "provider_failed" && diagnostic.HTTPStatus >= 100 && diagnostic.HTTPStatus <= 599 {
						if messagepush.IsAppleProviderCode(diagnostic.ProviderCode) {
							logger.Warn("message push batch failed", "reason", reason, "http_status", diagnostic.HTTPStatus, "provider_code", diagnostic.ProviderCode)
						} else {
							logger.Warn("message push batch failed", "reason", reason, "http_status", diagnostic.HTTPStatus)
						}
					} else {
						logger.Warn("message push batch failed", "reason", reason)
					}
				} else {
					logger.Warn("message push batch failed", "reason", "internal")
				}
			}
		}
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
