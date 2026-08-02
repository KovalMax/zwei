package auth

import (
	"errors"
	"net/http"
	"strings"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

type Claims struct {
	SessionVersion int64  `json:"session_version"`
	DeviceID       string `json:"device_id,omitempty"`
	Purpose        string `json:"purpose,omitempty"`
	jwt.RegisteredClaims
}

type Identity struct {
	UserID         uuid.UUID
	SessionVersion int64
	DeviceID       string
}

func ParseBearer(r *http.Request, secret []byte) (Identity, error) {
	return ParseBearerHeader(r.Header.Get("Authorization"), secret)
}

func ParseBearerHeader(authorization string, secret []byte) (Identity, error) {
	parts := strings.Fields(authorization)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return Identity{}, errors.New("missing bearer token")
	}
	return Parse(parts[1], secret)
}

func Parse(rawToken string, secret []byte) (Identity, error) {
	if len(secret) < 32 {
		return Identity{}, errors.New("token secret is too short")
	}
	parsed, err := jwt.ParseWithClaims(rawToken, &Claims{}, func(token *jwt.Token) (any, error) {
		if token.Method != jwt.SigningMethodHS256 {
			return nil, errors.New("unexpected signing method")
		}
		return secret, nil
	})
	if err != nil || !parsed.Valid {
		return Identity{}, errors.New("invalid token")
	}
	claims, ok := parsed.Claims.(*Claims)
	if !ok {
		return Identity{}, errors.New("invalid claims")
	}
	userID, err := uuid.Parse(claims.Subject)
	if err != nil {
		return Identity{}, errors.New("invalid subject")
	}
	return Identity{UserID: userID, SessionVersion: claims.SessionVersion, DeviceID: claims.DeviceID}, nil
}

func ParseWebSocketTicket(rawToken string, secret []byte) (Identity, error) {
	identity, err := Parse(rawToken, secret)
	if err != nil {
		return Identity{}, err
	}
	parsed, err := jwt.ParseWithClaims(rawToken, &Claims{}, func(token *jwt.Token) (any, error) {
		if token.Method != jwt.SigningMethodHS256 {
			return nil, errors.New("unexpected signing method")
		}
		return secret, nil
	})
	if err != nil || !parsed.Valid || parsed.Claims.(*Claims).Purpose != "websocket" {
		return Identity{}, errors.New("invalid websocket ticket")
	}
	return identity, nil
}
