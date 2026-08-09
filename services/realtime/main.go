package main

import (
	"context"
	"net/http"
	"os"
	"strings"
	"time"

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
	hub := application.NewHubWithLogger(messaging.NewSender(db, encryptionSecret), presence, coordination, messaging.NewDeliveryRepository(db, encryptionSecret), postgresinfra.NewReadCursorRepository(db), coordination, turnIssuer, runtime.NewLogger())
	go coordination.StartHeartbeat(ctx)
	go func() {
		_ = coordination.Consume(ctx, func(change redisinfra.Change) { hub.NotifyPresenceChanged(ctx, change.UserID, change.Online) })
	}()
	go func() {
		_ = coordination.ConsumeConversations(ctx, func(change redisinfra.ConversationChange) {
			hub.DeliverConversationCreated(change.ConversationID, change.UserIDs)
		})
	}()
	go func() {
		_ = coordination.ConsumeTyping(ctx, func(change redisinfra.TypingChange) {
			recipientID, err := presence.RecipientID(ctx, change.UserID, change.ConversationID)
			if err != nil {
				return
			}
			eventType := "typing.stopped"
			if change.Started {
				eventType = "typing.started"
			}
			hub.DeliverTyping(eventType, change.ConversationID, change.UserID, recipientID)
		})
	}()
	go func() {
		_ = coordination.ConsumeMessages(ctx, func(change redisinfra.MessageChange) { hub.DeliverMessageCreated(change.Message) })
	}()
	go func() {
		_ = coordination.ConsumeReads(ctx, func(change redisinfra.ReadChange) {
			hub.DeliverReadCursor(change.ReaderID, change.RecipientID, change.ConversationID, change.Sequence)
		})
	}()
	go func() {
		_ = coordination.ConsumeCalls(ctx, hub.DeliverCall)
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
				if err != nil {
					continue
				}
				for _, call := range calls {
					hub.DeliverCall(application.CallChange{Type: "ended", Call: call})
					_ = coordination.PublishCall(ctx, application.CallChange{Type: "ended", Call: call})
				}
			}
		}
	}()
	outbox := postgresinfra.NewOutboxRepository(db)
	go consumeConversationEvents(ctx, outbox, hub)
	handler := websockettransport.NewHandler(ctx, hub, sharedauth.NewSessionValidator(db, []byte(secret)), coordination, origins)
	mux := runtime.NewHealthHandler("realtime")
	mux.Handle("GET /ws", handler)
	server := &http.Server{
		Addr:              ":" + getenv("REALTIME_PORT", "8083"),
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	if err := runtime.RunHTTP(ctx, runtime.NewLogger(), server); err != nil {
		panic(err)
	}
}

func consumeConversationEvents(ctx context.Context, outbox *postgresinfra.OutboxRepository, hub *application.Hub) {
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			events, err := outbox.ClaimConversationCreated(ctx, 100)
			if err != nil {
				continue
			}
			for _, event := range events {
				hub.NotifyConversationCreated(event.ConversationID, event.UserIDs)
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
