package user

import "github.com/google/uuid"

type Profile struct {
	ID              uuid.UUID `json:"id"`
	Email           string    `json:"email"`
	DisplayName     string    `json:"display_name"`
	RetentionPeriod string    `json:"retention_period"`
}

type ProfileUpdate struct {
	DisplayName     *string `json:"display_name"`
	RetentionPeriod *string `json:"retention_period"`
}

func ValidRetention(value string) bool {
	switch value {
	case "30d", "90d", "1y", "forever":
		return true
	default:
		return false
	}
}

func NormalizeDisplayName(value string) (string, bool) {
	name := normalizeSpace(value)
	return name, name != "" && len(name) <= 100
}

func normalizeSpace(value string) string {
	start := 0
	end := len(value)
	for start < end && value[start] <= ' ' {
		start++
	}
	for end > start && value[end-1] <= ' ' {
		end--
	}
	return value[start:end]
}
