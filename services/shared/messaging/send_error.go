package messaging

import "errors"

var (
	ErrInvalidMessage          = errors.New("invalid message")
	ErrConversationNotFound    = errors.New("conversation not found")
	ErrClientMessageIDConflict = errors.New("client message id belongs to another conversation")
	ErrMessageExpired          = errors.New("message has expired")
	ErrUnavailable             = errors.New("message store unavailable")
	ErrPersistence             = errors.New("could not persist message")
)
