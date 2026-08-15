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
	passwords := password.NewBcryptHasher()
	if len(os.Args) > 1 && os.Args[1] == "admin" {
		if err := runAdminCommand(ctx, repository, passwords, os.Args[2:]); err != nil {
			panic(err)
		}
		return
	}
	authService := application.NewService(repository, passwords, token.NewJWTIssuer(cfg.JWTSecret), cfg.AccessLifetime, cfg.RefreshLifetime)
	adminService := application.NewAdminService(repository, passwords, email.NewSMTP(cfg.SMTPHost, cfg.SMTPPort, cfg.SMTPFrom, cfg.SMTPUsername, cfg.SMTPPassword), cfg.ActivationURL, cfg.InvitationURL)
	adminIPs, err := httptransport.NewIPAllowlist(cfg.AdminAllowedIPs)
	if err != nil {
		panic(err)
	}
	handler := httptransport.NewHandler(authService, adminService, sharedauth.NewSessionValidator(db, cfg.JWTSecret), adminIPs)
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

func runAdminCommand(ctx context.Context, repository application.Repository, passwords application.PasswordHasher, args []string) error {
	if len(args) == 0 || args[0] != "create" {
		return errors.New("usage: service admin create [--email email --display-name name]")
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
