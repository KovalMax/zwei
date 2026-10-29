package auth

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

type Claims struct {
	SessionVersion    int64  `json:"session_version"`
	DeviceID          string `json:"device_id,omitempty"`
	BrowserID         string `json:"browser_id,omitempty"`
	BrowserGeneration string `json:"browser_generation,omitempty"`
	Purpose           string `json:"purpose,omitempty"`
	jwt.RegisteredClaims
}

// UnmarshalJSON distinguishes absent legacy claims from explicit null or empty claims.
func (c *Claims) UnmarshalJSON(data []byte) error {
	type claimsAlias Claims
	var decoded claimsAlias
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	_, hasID := fields["browser_id"]
	_, hasGeneration := fields["browser_generation"]
	if hasID != hasGeneration || (hasID && (decoded.BrowserID == "" || decoded.BrowserGeneration == "")) {
		return errors.New("invalid browser binding")
	}
	*c = Claims(decoded)
	return nil
}

type Identity struct {
	UserID            uuid.UUID
	SessionVersion    int64
	DeviceID          string
	BrowserID         uuid.UUID
	BrowserGeneration uuid.UUID
}

func ParseBearer(r *http.Request, secret []byte) (Identity, error) {
	return ParseBearerHeader(r.Header.Get("Authorization"), secret)
}

func ParseBearerHeader(authorization string, secret []byte) (Identity, error) {
	parts := strings.Fields(authorization)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return Identity{}, errors.New("missing bearer token")
	}
	claims, err := parseClaims(parts[1], secret)
	if err != nil {
		return Identity{}, err
	}
	if claims.Purpose != "" {
		return Identity{}, errors.New("invalid token purpose")
	}
	return identityFromClaims(claims)
}

func Parse(rawToken string, secret []byte) (Identity, error) {
	claims, err := parseClaims(rawToken, secret)
	if err != nil {
		return Identity{}, err
	}
	return identityFromClaims(claims)
}

func parseClaims(rawToken string, secret []byte) (*Claims, error) {
	if len(secret) < 32 {
		return nil, errors.New("token secret is too short")
	}
	parsed, err := jwt.ParseWithClaims(rawToken, &Claims{}, func(token *jwt.Token) (any, error) {
		if token.Method != jwt.SigningMethodHS256 {
			return nil, errors.New("unexpected signing method")
		}
		return secret, nil
	})
	if err != nil || !parsed.Valid {
		return nil, errors.New("invalid token")
	}
	claims, ok := parsed.Claims.(*Claims)
	if !ok {
		return nil, errors.New("invalid claims")
	}
	return claims, nil
}

func identityFromClaims(claims *Claims) (Identity, error) {
	userID, err := uuid.Parse(claims.Subject)
	if err != nil {
		return Identity{}, errors.New("invalid subject")
	}
	identity := Identity{UserID: userID, SessionVersion: claims.SessionVersion, DeviceID: claims.DeviceID}
	if claims.BrowserID != "" || claims.BrowserGeneration != "" {
		identity.BrowserID, err = uuid.Parse(claims.BrowserID)
		if err != nil || identity.BrowserID == uuid.Nil {
			return Identity{}, errors.New("invalid browser binding")
		}
		identity.BrowserGeneration, err = uuid.Parse(claims.BrowserGeneration)
		if err != nil || identity.BrowserGeneration == uuid.Nil {
			return Identity{}, errors.New("invalid browser binding")
		}
	}
	return identity, nil
}

func ParseWebSocketTicket(rawToken string, secret []byte) (Identity, error) {
	claims, err := parseClaims(rawToken, secret)
	if err != nil {
		return Identity{}, err
	}
	if claims.Purpose != "websocket" {
		return Identity{}, errors.New("invalid websocket ticket")
	}
	return identityFromClaims(claims)
}
