package turn

import (
	"crypto/hmac"
	"crypto/sha1" // coturn REST credentials require HMAC-SHA1.
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/KovalMax/zwei/services/realtime/internal/application"
)

type CredentialIssuer struct {
	secret   []byte
	urls     []string
	lifetime time.Duration
	now      func() time.Time
}

func NewCredentialIssuer(secret string, urls []string, lifetime time.Duration) (*CredentialIssuer, error) {
	if len(secret) < 32 {
		return nil, errors.New("TURN shared secret must contain at least 32 bytes")
	}
	cleanURLs := make([]string, 0, len(urls))
	for _, url := range urls {
		if trimmed := strings.TrimSpace(url); trimmed != "" {
			cleanURLs = append(cleanURLs, trimmed)
		}
	}
	if len(cleanURLs) == 0 || lifetime <= 0 {
		return nil, errors.New("TURN configuration is invalid")
	}
	return &CredentialIssuer{secret: []byte(secret), urls: cleanURLs, lifetime: lifetime, now: time.Now}, nil
}

func (i *CredentialIssuer) Issue(call application.Call, userID uuid.UUID) (application.ICEServer, error) {
	if call.ID == uuid.Nil || userID == uuid.Nil {
		return application.ICEServer{}, errors.New("call credential identity is invalid")
	}
	expiresAt := i.now().Add(i.lifetime).Unix()
	username := fmt.Sprintf("%d:%s:%s", expiresAt, userID, call.ID)
	mac := hmac.New(sha1.New, i.secret)
	_, _ = mac.Write([]byte(username))
	return application.ICEServer{URLs: i.urls, Username: username, Credential: base64.StdEncoding.EncodeToString(mac.Sum(nil))}, nil
}

var _ application.TURNCredentialIssuer = (*CredentialIssuer)(nil)
