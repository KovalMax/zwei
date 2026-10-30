package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"strings"
	"syscall"

	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/term"

	"github.com/KovalMax/zwei/services/auth/internal/application"
	"github.com/KovalMax/zwei/services/auth/internal/infrastructure/config"
	"github.com/KovalMax/zwei/services/auth/internal/infrastructure/email"
	"github.com/KovalMax/zwei/services/auth/internal/infrastructure/password"
	"github.com/KovalMax/zwei/services/auth/internal/infrastructure/token"
	"github.com/KovalMax/zwei/services/auth/internal/persistence/postgres"
	httptransport "github.com/KovalMax/zwei/services/auth/internal/transport/http"
	"github.com/KovalMax/zwei/services/internal/runtime"
	sharedauth "github.com/KovalMax/zwei/services/shared/auth"
	"github.com/KovalMax/zwei/services/shared/pushcrypto"
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
	pushCodec, err := pushcrypto.NewKeyring(cfg.PushEncryptionKeys, cfg.PushEncryptionCurrentVersion, cfg.PushFingerprintKey)
	if err != nil {
		panic(err)
	}
	repository := postgres.NewRepository(db, pushCodec, cfg.VAPIDKeyID)
	passwords := password.NewBcryptHasher()
	if len(os.Args) > 1 && os.Args[1] == "admin" {
		if err := runAdminCommand(ctx, repository, passwords, os.Args[2:]); err != nil {
			panic(err)
		}
		return
	}
	if err := repository.EnsurePushFingerprintKeyIdentity(ctx); err != nil {
		panic(err)
	}
	issuer := token.NewJWTIssuer(cfg.JWTSecret)
	authService := application.NewService(repository, passwords, issuer, cfg.AccessLifetime, cfg.RefreshLifetime)
	adminService := application.NewAdminService(repository, passwords, email.NewSMTP(cfg.SMTPHost, cfg.SMTPPort, cfg.SMTPFrom, cfg.SMTPUsername, cfg.SMTPPassword), cfg.ActivationURL, cfg.InvitationURL)
	adminIPs, err := httptransport.NewIPAllowlist(cfg.AdminAllowedIPs, cfg.TrustedProxyCIDRs)
	if err != nil {
		panic(err)
	}
	origins, err := runtime.ParseOrigins(getenv("ALLOWED_ORIGINS", "https://chat.localhost"))
	if err != nil {
		panic(err)
	}
	validator := sharedauth.NewSessionValidator(db, cfg.JWTSecret)
	handler := httptransport.NewHandler(authService, adminService, validator, adminIPs, origins, cfg.VAPIDPublicKey, cfg.GiphyAPIKey)
	mux := runtime.NewHealthHandler("auth")
	handler.Register(mux)
	registerBrowserV2(mux, cfg, handler, authService, repository, issuer, validator)
	server := &http.Server{Addr: ":" + cfg.Port, Handler: runtime.WithCORS(cacheControl(mux), origins)}
	runtime.ConfigureHTTPServer(server)
	if err := runtime.RunHTTP(ctx, runtime.NewLogger(), server); err != nil {
		panic(err)
	}
}

func registerBrowserV2(mux *http.ServeMux, cfg config.Config, handler *httptransport.Handler, authService *application.Service, repository *postgres.Repository, issuer *token.JWTIssuer, validator *sharedauth.SessionValidator) {
	browserSessions := application.NewBrowserSessions(repository, issuer, cfg.AccessLifetime, cfg.RefreshLifetime)
	browser := httptransport.NewBrowserV2Handler(handler, authService, repository, browserSessions, validator)
	browser.SetRegistration(application.NewBrowserRegistration(authService, browserSessions, repository))
	browser.SetCandidateDiscovery(repository)
	browser.Register(mux)
}

func runAdminCommand(ctx context.Context, repository application.Repository, passwords application.PasswordHasher, args []string) error {
	if len(args) > 0 && args[0] == "rekey-push-fingerprint-key" {
		flags := flag.NewFlagSet("admin rekey-push-fingerprint-key", flag.ContinueOnError)
		replicasStopped := flags.Bool("confirm-replicas-stopped", false, "confirm all Auth and Realtime replicas are stopped")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		if !*replicasStopped {
			return errors.New("re-key requires --confirm-replicas-stopped")
		}
		repository, ok := repository.(*postgres.Repository)
		if !ok {
			return errors.New("push fingerprint key re-key unavailable")
		}
		if err := repository.RekeyPushFingerprintKey(ctx); err != nil {
			return err
		}
		fmt.Println("push subscriptions deleted and fingerprint key identity reset; users must re-enroll")
		return nil
	}
	if len(args) == 0 || args[0] != "create" {
		return errors.New("usage: service admin create [--email email --display-name name] | admin rekey-push-fingerprint-key --confirm-replicas-stopped")
	}
	flags := flag.NewFlagSet("admin create", flag.ContinueOnError)
	emailAddress := flags.String("email", "", "administrator email")
	displayName := flags.String("display-name", "", "administrator display name")
	if err := flags.Parse(args[1:]); err != nil {
		return err
	}
	reader := bufio.NewReader(os.Stdin)
	var err error
	if *emailAddress == "" {
		*emailAddress, err = prompt(reader, "Admin email: ")
		if err != nil {
			return err
		}
	}
	if *displayName == "" {
		*displayName, err = prompt(reader, "Display name: ")
		if err != nil {
			return err
		}
	}
	passwordValue, err := promptPassword(reader)
	if err != nil {
		return err
	}
	adminService := application.NewAdminService(repository, passwords, nil, "", "")
	if err := adminService.CreateAdmin(ctx, *emailAddress, passwordValue, *displayName); err != nil {
		return fmt.Errorf("create admin: %w", err)
	}
	fmt.Println("administrator created")
	return nil
}

func prompt(reader *bufio.Reader, label string) (string, error) {
	fmt.Print(label)
	value, err := reader.ReadString('\n')
	return strings.TrimSpace(value), err
}

func promptPassword(reader *bufio.Reader) (string, error) {
	if term.IsTerminal(int(syscall.Stdin)) {
		fmt.Print("Password: ")
		value, err := term.ReadPassword(int(syscall.Stdin))
		fmt.Println()
		return strings.TrimSpace(string(value)), err
	}
	return prompt(reader, "Password: ")
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
