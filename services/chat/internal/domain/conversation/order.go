package conversation

import (
	"strings"

	"github.com/google/uuid"
)

func OrderedUsers(first, second uuid.UUID) (uuid.UUID, uuid.UUID) {
	if strings.Compare(first.String(), second.String()) < 0 {
		return first, second
	}
	return second, first
}
