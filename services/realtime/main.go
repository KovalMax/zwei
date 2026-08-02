package main

import (
	"net/http"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/KovalMax/zwei/services/internal/runtime"
	"github.com/KovalMax/zwei/services/realtime/internal/application"
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
	hub := application.NewHub(messaging.NewSender(db, encryptionSecret))
	handler := websockettransport.NewHandler(ctx, hub, sharedauth.NewSessionValidator(db, []byte(secret)), origins)
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

func getenv(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
