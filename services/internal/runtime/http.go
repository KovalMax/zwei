package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"log/slog"
	"net/http"
	"time"
)

type HealthResponse struct {
	Service string `json:"service"`
	Status  string `json:"status"`
}

const (
	httpReadHeaderTimeout = 5 * time.Second
	httpReadTimeout       = 15 * time.Second
	httpWriteTimeout      = 15 * time.Second
	httpIdleTimeout       = 60 * time.Second
	httpMaxHeaderBytes    = 1 << 20
)

// ConfigureHTTPServer applies bounded timeouts to request/response servers.
// Streaming upgrades use ConfigureWebSocketServer instead because a finite
// write timeout would terminate an otherwise healthy long-lived socket.
func ConfigureHTTPServer(server *http.Server) {
	server.ReadHeaderTimeout = httpReadHeaderTimeout
	server.ReadTimeout = httpReadTimeout
	server.WriteTimeout = httpWriteTimeout
	server.IdleTimeout = httpIdleTimeout
	server.MaxHeaderBytes = httpMaxHeaderBytes
}

// ConfigureWebSocketServer protects the HTTP upgrade handshake without
// imposing request/response deadlines on the hijacked WebSocket connection.
func ConfigureWebSocketServer(server *http.Server) {
	server.ReadHeaderTimeout = httpReadHeaderTimeout
	server.MaxHeaderBytes = httpMaxHeaderBytes
}

func NewHealthHandler(service string) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health/live", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, HealthResponse{Service: service, Status: "ok"})
	})
	mux.HandleFunc("GET /health/ready", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, HealthResponse{Service: service, Status: "ok"})
	})
	return mux
}

func RunHTTP(ctx context.Context, logger *slog.Logger, server *http.Server) error {
	serverErr := make(chan error, 1)
	go func() {
		logger.Info("http server started", "address", server.Addr)
		serverErr <- server.ListenAndServe()
	}()

	select {
	case err := <-serverErr:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return server.Shutdown(shutdownCtx)
	}
}

func NewLogger() *slog.Logger {
	return slog.Default()
}

func WriteJSON(w http.ResponseWriter, status int, value any) {
	writeJSON(w, status, value)
}

func WithCORS(next http.Handler, allowedOrigins map[string]struct{}) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if _, allowed := allowedOrigins[origin]; allowed {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS")
		}
		if r.Method == http.MethodOptions {
			if _, allowed := allowedOrigins[origin]; !allowed && origin != "" {
				http.Error(w, "origin not allowed", http.StatusForbidden)
				return
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		log.Printf("write JSON response: %v", err)
	}
}
