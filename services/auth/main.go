package main

import (
	"net/http"
	"os"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/KovalMax/zwei/services/auth/internal/application"
	"github.com/KovalMax/zwei/services/auth/internal/infrastructure/config"
	"github.com/KovalMax/zwei/services/auth/internal/infrastructure/password"
	"github.com/KovalMax/zwei/services/auth/internal/infrastructure/token"
	"github.com/KovalMax/zwei/services/auth/internal/persistence/postgres"
	httptransport "github.com/KovalMax/zwei/services/auth/internal/transport/http"
	"github.com/KovalMax/zwei/services/internal/runtime"
	sharedauth "github.com/KovalMax/zwei/services/shared/auth"
)

func main() {
	ctx, cancel := runtime.SignalContext()
	defer cancel()
	cfg, err := config.Load()
	if err != nil {
		panic(err)
	}
	db, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		panic(err)
	}
	defer db.Close()
	if err := db.Ping(ctx); err != nil {
		panic(err)
	}
	repository := postgres.NewRepository(db)
	authService := application.NewService(repository, password.NewBcryptHasher(), token.NewJWTIssuer(cfg.JWTSecret), cfg.AccessLifetime, cfg.RefreshLifetime)
	handler := httptransport.NewHandler(authService, sharedauth.NewSessionValidator(db, cfg.JWTSecret))
	mux := runtime.NewHealthHandler("auth")
	handler.Register(mux)
	origins, err := runtime.ParseOrigins(getenv("ALLOWED_ORIGINS", "https://chat.localhost"))
	if err != nil {
		panic(err)
	}
	server := &http.Server{Addr: ":" + cfg.Port, Handler: runtime.WithCORS(cacheControl(mux), origins)}
	runtime.ConfigureHTTPServer(server)
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
