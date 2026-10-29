package config

import (
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"strconv"
	"time"

	"github.com/KovalMax/zwei/services/shared/pushcrypto"
)

type Config struct {
	DatabaseURL                  string
	JWTSecret                    []byte
	GiphyAPIKey                  string
	AccessLifetime               time.Duration
	RefreshLifetime              time.Duration
	UniqueRefreshCookies         bool
	Port                         string
	SMTPHost                     string
	SMTPPort                     string
	SMTPFrom                     string
	SMTPUsername                 string
	SMTPPassword                 string
	ActivationURL                string
	InvitationURL                string
	AdminAllowedIPs              string
	TrustedProxyCIDRs            string
	PushEncryptionKey            []byte
	PushEncryptionKeys           map[string][]byte
	PushEncryptionCurrentVersion string
	PushFingerprintKey           []byte
	VAPIDPublicKey               string
	VAPIDKeyID                   string
}

func Load() (Config, error) {
	secret := os.Getenv("JWT_SECRET")
	if len(secret) < 32 {
		return Config{}, errors.New("JWT_SECRET must contain at least 32 bytes")
	}
	access, err := durationEnv("ACCESS_TOKEN_LIFETIME", 15*time.Minute)
	if err != nil {
		return Config{}, err
	}
	refresh, err := durationEnv("REFRESH_TOKEN_LIFETIME", 30*24*time.Hour)
	if err != nil {
		return Config{}, err
	}
	uniqueCookies, err := strconv.ParseBool(getenv("AUTH_UNIQUE_REFRESH_COOKIES", "false"))
	if err != nil {
		return Config{}, errors.New("AUTH_UNIQUE_REFRESH_COOKIES must be a boolean")
	}
	keys := map[string][]byte{}
	for version, name := range map[string]string{"v1": "PUSH_SUBSCRIPTION_ENCRYPTION_KEY_V1", "v2": "PUSH_SUBSCRIPTION_ENCRYPTION_KEY_V2"} {
		value := os.Getenv(name)
		if value == "" {
			continue
		}
		key, decodeErr := hex.DecodeString(value)
		if decodeErr != nil || len(key) != 32 {
			return Config{}, fmt.Errorf("%s must be 32 bytes encoded as hex", name)
		}
		keys[version] = key
	}
	currentVersion := getenv("PUSH_SUBSCRIPTION_ENCRYPTION_CURRENT_VERSION", "v1")
	if _, ok := keys[currentVersion]; !ok || (currentVersion != "v1" && currentVersion != "v2") {
		return Config{}, errors.New("current push encryption version must name a configured v1 or v2 key")
	}
	if currentVersion == "v2" && len(keys["v1"]) != 32 {
		return Config{}, errors.New("v2 rotation requires retaining PUSH_SUBSCRIPTION_ENCRYPTION_KEY_V1 for old rows")
	}
	fingerprintKey, err := hex.DecodeString(os.Getenv("PUSH_SUBSCRIPTION_FINGERPRINT_KEY"))
	if err != nil || len(fingerprintKey) < 32 {
		return Config{}, errors.New("PUSH_SUBSCRIPTION_FINGERPRINT_KEY must be at least 32 bytes encoded as hex")
	}
	vapidPublicKey := os.Getenv("VAPID_PUBLIC_KEY")
	vapidKeyID := ""
	if vapidPublicKey != "" {
		vapidKeyID, err = pushcrypto.VAPIDFingerprint(vapidPublicKey)
		if err != nil {
			return Config{}, err
		}
	}
	return Config{
		DatabaseURL:                  getenv("DATABASE_URL", "postgres://messenger_user:user-password@database:5432/messenger?sslmode=disable"),
		JWTSecret:                    []byte(secret),
		GiphyAPIKey:                  os.Getenv("GIPHY_API_KEY"),
		AccessLifetime:               access,
		RefreshLifetime:              refresh,
		UniqueRefreshCookies:         uniqueCookies,
		Port:                         getenv("AUTH_PORT", "8081"),
		SMTPHost:                     getenv("SMTP_HOST", "mailpit"),
		SMTPPort:                     getenv("SMTP_PORT", "1025"),
		SMTPFrom:                     getenv("SMTP_FROM", "noreply@chat.localhost"),
		SMTPUsername:                 os.Getenv("SMTP_USERNAME"),
		SMTPPassword:                 os.Getenv("SMTP_PASSWORD"),
		ActivationURL:                getenv("ACTIVATION_URL", "https://chat.localhost/activate"),
		InvitationURL:                getenv("INVITATION_URL", "https://chat.localhost/sign-up"),
		AdminAllowedIPs:              getenv("ADMIN_ALLOWED_IPS", "172.16.0.0/12,127.0.0.1/32,::1/128"),
		TrustedProxyCIDRs:            getenv("TRUSTED_PROXY_CIDRS", "172.30.0.250/32"),
		PushEncryptionKey:            keys[currentVersion],
		PushEncryptionKeys:           keys,
		PushEncryptionCurrentVersion: currentVersion,
		PushFingerprintKey:           fingerprintKey,
		VAPIDPublicKey:               vapidPublicKey,
		VAPIDKeyID:                   vapidKeyID,
	}, nil
}

func getenv(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func durationEnv(key string, fallback time.Duration) (time.Duration, error) {
	value := getenv(key, fallback.String())
	parsed, err := time.ParseDuration(value)
	if err != nil {
		return 0, fmt.Errorf("%s: %w", key, err)
	}
	return parsed, nil
}
