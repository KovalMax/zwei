package messaging

// ValidateContent only permits explicitly typed text writes. Historical sticker reads remain supported.
func ValidateContent(contentType, _ string, _ []Mention) bool {
	return contentType == "text"
}
