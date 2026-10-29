package token

import (
	"errors"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"

	sharedauth "github.com/KovalMax/zwei/services/shared/auth"
)

type JWTIssuer struct {
	secret []byte
	now    func() time.Time
}

func NewJWTIssuer(secret []byte) *JWTIssuer { return &JWTIssuer{secret: secret, now: time.Now} }
func (i *JWTIssuer) IssueAccess(identity sharedauth.Identity, lifetime time.Duration) (string, error) {
	return i.issue(identity, "", lifetime)
}
func (i *JWTIssuer) IssueWebSocketTicket(identity sharedauth.Identity, lifetime time.Duration) (string, error) {
	return i.issue(identity, "websocket", lifetime)
}
func (i *JWTIssuer) issue(identity sharedauth.Identity, purpose string, lifetime time.Duration) (string, error) {
	if (identity.BrowserID == uuid.Nil) != (identity.BrowserGeneration == uuid.Nil) {
		return "", errors.New("invalid browser binding")
	}
	now := i.now()
	claims := sharedauth.Claims{SessionVersion: identity.SessionVersion, DeviceID: identity.DeviceID, Purpose: purpose, RegisteredClaims: jwt.RegisteredClaims{Issuer: "p2p-webchat-auth", Subject: identity.UserID.String(), ID: uuid.NewString(), IssuedAt: jwt.NewNumericDate(now), ExpiresAt: jwt.NewNumericDate(now.Add(lifetime)), NotBefore: jwt.NewNumericDate(now)}}
	if identity.BrowserID != uuid.Nil {
		claims.BrowserID = identity.BrowserID.String()
		claims.BrowserGeneration = identity.BrowserGeneration.String()
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(i.secret)
}
