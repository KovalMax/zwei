package token

import (
	"time"

	"github.com/golang-jwt/jwt/v5"

	sharedauth "github.com/maxkoval/p2p-webchat/services/shared/auth"
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
	now := i.now()
	claims := sharedauth.Claims{SessionVersion: identity.SessionVersion, DeviceID: identity.DeviceID, Purpose: purpose, RegisteredClaims: jwt.RegisteredClaims{Issuer: "p2p-webchat-auth", Subject: identity.UserID.String(), IssuedAt: jwt.NewNumericDate(now), ExpiresAt: jwt.NewNumericDate(now.Add(lifetime)), NotBefore: jwt.NewNumericDate(now)}}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(i.secret)
}
