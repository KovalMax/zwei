package messaging

const maxStickerIDLength = 64

var stickerIDs = map[string]struct{}{
	"hello": {}, "heart": {}, "laugh": {}, "wow": {}, "thanks": {}, "sorry": {},
	"yes": {}, "no": {}, "coffee": {}, "cat": {}, "dog": {}, "celebrate": {},
}

// ValidateContent accepts legacy omitted content types as text and validates sticker payloads.
func ValidateContent(contentType, body string, mentions []Mention) bool {
	if contentType == "" || contentType == "text" {
		return true
	}
	if contentType != "sticker" || len(mentions) != 0 || body == "" || len(body) > maxStickerIDLength {
		return false
	}
	_, ok := stickerIDs[body]
	return ok
}
