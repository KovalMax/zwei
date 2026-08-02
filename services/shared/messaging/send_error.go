package messaging

import "errors"

var (
	ErrInvalidMessage       = errors.New("invalid message")
	ErrConversationNotFound = errors.New("conversation not found")
	ErrUnavailable          = errors.New("message store unavailable")
	ErrPersistence          = errors.New("could not persist message")
)
