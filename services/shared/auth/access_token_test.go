package auth

import (
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

func TestParseBearerReturnsIdentity(t *testing.T) {
	secret := []byte("01234567890123456789012345678901")
	userID := uuid.New()
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, Claims{
		SessionVersion: 4,
		DeviceID:       "browser-1",
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   userID.String(),
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Minute)),
		},
	}).SignedString(secret)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("GET", "/", nil)
	r.Header.Set("Authorization", "Bearer "+token)
	identity, err := ParseBearer(r, secret)
	if err != nil {
		t.Fatal(err)
	}
	if identity.UserID != userID || identity.SessionVersion != 4 || identity.DeviceID != "browser-1" {
		t.Fatalf("unexpected identity: %+v", identity)
	}
}

func TestParseRejectsWrongSecretAndAlgorithm(t *testing.T) {
	secret := []byte("01234567890123456789012345678901")
	userID := uuid.New()
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, Claims{RegisteredClaims: jwt.RegisteredClaims{Subject: userID.String(), ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Minute))}}).SignedString(secret)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Parse(token, []byte("different-secret-012345678901234567")); err == nil {
		t.Fatal("accepted token signed by wrong secret")
	}
}
