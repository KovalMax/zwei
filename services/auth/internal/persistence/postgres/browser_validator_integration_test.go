package postgres

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/KovalMax/zwei/services/auth/internal/application"
	"github.com/KovalMax/zwei/services/auth/internal/infrastructure/token"
	sharedauth "github.com/KovalMax/zwei/services/shared/auth"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestBrowserSessionValidatorPostgres(t *testing.T) {
	url := os.Getenv("ZWEI_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set ZWEI_TEST_DATABASE_URL for PostgreSQL integration")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	db, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	repo := NewRepository(db, nil)
	user1, device1 := createPushTestUser(t, ctx, repo, db)
	user2, device2 := createPushTestUser(t, ctx, repo, db)
	defer db.Exec(context.Background(), `DELETE FROM users WHERE id = ANY($1)`, []string{user1.String(), user2.String()})
	secret := []byte("01234567890123456789012345678901")
	sessions := application.NewBrowserSessions(repo, token.NewJWTIssuer(secret), time.Minute, time.Hour)
	validator := sharedauth.NewSessionValidator(db, secret)
	target1 := application.BrowserSessionTarget{UserID: user1, DeviceID: device1, SessionVersion: 1}
	created, err := sessions.Create(ctx, application.CreateBrowserSessionCommand{Target: target1})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Exec(context.Background(), `DELETE FROM browser_auth_heads WHERE browser_id=$1`, created.BrowserID)
	validate := func(raw string, valid bool) sharedauth.Identity {
		t.Helper()
		identity, err := validator.AuthenticateBearer(ctx, "Bearer "+raw)
		if (err == nil) != valid {
			t.Fatalf("validate valid=%v: %v", valid, err)
		}
		return identity
	}
	identity := validate(created.Tokens.AccessToken, true)
	ticket, err := token.NewJWTIssuer(secret).IssueWebSocketTicket(identity, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := validator.AuthenticateWebSocketTicket(ctx, ticket); err != nil {
		t.Fatal(err)
	}
	wrong := identity
	wrong.UserID = user2
	if !errors.Is(validator.Validate(ctx, wrong, false), sharedauth.ErrSessionInvalid) {
		t.Fatal("wrong user accepted")
	}
	cred := application.BrowserCredential{BrowserID: created.BrowserID, Generation: created.Generation, RefreshToken: created.Tokens.RefreshToken}
	refreshed, err := sessions.Refresh(ctx, application.RefreshBrowserSessionCommand{Current: cred})
	if err != nil {
		t.Fatal(err)
	}
	validate(created.Tokens.AccessToken, true)
	validate(refreshed.Tokens.AccessToken, true)
	cred = application.BrowserCredential{BrowserID: refreshed.BrowserID, Generation: refreshed.Generation, RefreshToken: refreshed.Tokens.RefreshToken}
	replaced, err := sessions.Replace(ctx, application.ReplaceBrowserSessionCommand{Current: cred, Target: application.BrowserSessionTarget{UserID: user2, DeviceID: device2, SessionVersion: 1}})
	if err != nil {
		t.Fatal(err)
	}
	validate(created.Tokens.AccessToken, false)
	if _, err := validator.AuthenticateWebSocketTicket(ctx, ticket); !errors.Is(err, sharedauth.ErrSessionInvalid) {
		t.Fatalf("stale ticket: %v", err)
	}
	validate(refreshed.Tokens.AccessToken, false)
	validate(replaced.Tokens.AccessToken, true)
	if _, err := db.Exec(ctx, `UPDATE users SET session_version = session_version + 1 WHERE id = $1`, user2); err != nil {
		t.Fatal(err)
	}
	validate(replaced.Tokens.AccessToken, false)
	if _, err := db.Exec(ctx, `UPDATE users SET session_version = session_version - 1 WHERE id = $1`, user2); err != nil {
		t.Fatal(err)
	}
	validate(replaced.Tokens.AccessToken, true)
	cred = application.BrowserCredential{BrowserID: replaced.BrowserID, Generation: replaced.Generation, RefreshToken: replaced.Tokens.RefreshToken}
	if err := sessions.Logout(ctx, application.LogoutBrowserSessionCommand{Current: cred, UserID: user2, SessionVersion: 1}); err != nil {
		t.Fatal(err)
	}
	validate(replaced.Tokens.AccessToken, false)
}
