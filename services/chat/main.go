package main

import (
	"net/http"
	"os"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/maxkoval/p2p-webchat/services/chat/internal/persistence/postgres"
	httptransport "github.com/maxkoval/p2p-webchat/services/chat/internal/transport/http"
	"github.com/maxkoval/p2p-webchat/services/internal/runtime"
	sharedauth "github.com/maxkoval/p2p-webchat/services/shared/auth"
	"github.com/maxkoval/p2p-webchat/services/shared/messaging"
)

func main() {
	ctx, cancel := runtime.SignalContext()
	defer cancel()
	secret := os.Getenv("JWT_SECRET")
	if len(secret) < 32 {
		panic("JWT_SECRET must contain at least 32 bytes")
	}
	db, err := pgxpool.New(ctx, getenv("DATABASE_URL", "postgres://messenger_user:user-password@database:5432/messenger?sslmode=disable"))
	if err != nil {
		panic(err)
	}
	defer db.Close()
	if err := db.Ping(ctx); err != nil {
		panic(err)
	}
	encryptionSecret := getenv("MESSAGE_ENCRYPTION_KEY", "local-development-key-change-me")
	handler := httptransport.NewHandler(messaging.NewSender(db, encryptionSecret), sharedauth.NewSessionValidator(db, []byte(secret)), postgres.NewConversationRepository(db), postgres.NewHistoryRepository(db, encryptionSecret))
	mux := runtime.NewHealthHandler("chat")
	handler.Register(mux)
	origins, err := runtime.ParseOrigins(getenv("ALLOWED_ORIGINS", "https://chat.localhost"))
	if err != nil {
		panic(err)
	}
	server := &http.Server{Addr: ":" + getenv("CHAT_PORT", "8082"), Handler: runtime.WithCORS(cacheControl(mux), origins)}
	if err := runtime.RunHTTP(ctx, runtime.NewLogger(), server); err != nil {
		panic(err)
	}
}

func cacheControl(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		next.ServeHTTP(w, r)
	})
}
func getenv(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
