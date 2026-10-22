package messaging

import "testing"

func TestValidateContent(t *testing.T) {
	tests := []struct {
		name, contentType, body string
		mentions                int
		valid                   bool
	}{
		{"legacy text", "", "hello", 0, true},
		{"text", "text", "hello", 0, true},
		{"sticker", "sticker", "hello", 0, true},
		{"unknown type", "image", "hello", 0, false},
		{"unknown sticker", "sticker", "not-allowed", 0, false},
		{"long sticker id", "sticker", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 0, false},
		{"sticker mentions", "sticker", "hello", 1, false},
		{"empty sticker", "sticker", "", 0, false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			mentions := make([]Mention, test.mentions)
			if got := ValidateContent(test.contentType, test.body, mentions); got != test.valid {
				t.Fatalf("ValidateContent() = %v, want %v", got, test.valid)
			}
		})
	}
}
