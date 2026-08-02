package runtime

import (
	"errors"
	"strings"
)

func ParseOrigins(raw string) (map[string]struct{}, error) {
	result := make(map[string]struct{})
	for _, value := range strings.Split(raw, ",") {
		origin := strings.TrimSpace(value)
		if origin == "" {
			continue
		}
		if origin == "*" {
			return nil, errors.New("wildcard origin is not allowed")
		}
		result[origin] = struct{}{}
	}
	if len(result) == 0 {
		return nil, errors.New("at least one allowed origin is required")
	}
	return result, nil
}
