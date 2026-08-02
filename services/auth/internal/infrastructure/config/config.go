package config

import (
	"errors"
	"fmt"
	"os"
	"time"
)

type Config struct {
	DatabaseURL     string
	JWTSecret       []byte
	AccessLifetime  time.Duration
	RefreshLifetime time.Duration
	Port            string
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
	return Config{
		DatabaseURL:     getenv("DATABASE_URL", "postgres://messenger_user:user-password@database:5432/messenger?sslmode=disable"),
		JWTSecret:       []byte(secret),
		AccessLifetime:  access,
		RefreshLifetime: refresh,
		Port:            getenv("AUTH_PORT", "8081"),
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
