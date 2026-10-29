package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/KovalMax/zwei/services/auth/internal/application"
	"github.com/KovalMax/zwei/services/auth/internal/infrastructure/config"
	"github.com/KovalMax/zwei/services/auth/internal/infrastructure/password"
	"github.com/KovalMax/zwei/services/auth/internal/infrastructure/token"
	"github.com/KovalMax/zwei/services/auth/internal/persistence/postgres"
	httptransport "github.com/KovalMax/zwei/services/auth/internal/transport/http"
	sharedauth "github.com/KovalMax/zwei/services/shared/auth"
)

func TestBrowserV2CompositionRoutes(t *testing.T) {
	secret := []byte("0123456789abcdef0123456789abcdef")
	repo := postgres.NewRepository(nil, nil)
	issuer := token.NewJWTIssuer(secret)
	service := application.NewService(repo, password.NewBcryptHasher(), issuer, time.Minute, time.Hour)
	validator := sharedauth.NewSessionValidator(nil, secret)
	base := httptransport.NewHandler(service, nil, validator, nil, map[string]struct{}{"https://chat.localhost": {}}, "")
	{
		mux := http.NewServeMux()
		base.Register(mux)
		registerBrowserV2(mux, config.Config{AccessLifetime: time.Minute, RefreshLifetime: time.Hour}, base, service, repo, issuer, validator)
		for _, path := range []string{"register", "login", "refresh", "logout", "discovery", "continue"} {
			req := httptest.NewRequest("POST", "https://chat.localhost/api/auth/v2/"+path, strings.NewReader("{}"))
			req.Header.Set("Origin", "https://chat.localhost")
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, req)
			if w.Code == http.StatusNotFound || w.Code >= 500 {
				t.Errorf("enabled %s: %d %s", path, w.Code, w.Body.String())
			}
			if path == "logout" && w.Code != http.StatusUnauthorized {
				t.Errorf("unauthenticated logout: %d", w.Code)
			}
		}
		for _, path := range []string{"register", "login", "refresh"} {
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, httptest.NewRequest("POST", "/api/auth/"+path, strings.NewReader("{}")))
			if w.Code != http.StatusNotFound {
				t.Errorf("legacy %s: %d", path, w.Code)
			}
		}
	}
}
