package main

import (
	"testing"

	"github.com/google/uuid"

	"github.com/KovalMax/zwei/services/chat/internal/domain/conversation"
	sharedmessage "github.com/KovalMax/zwei/services/shared/message"
)

func TestEncryptMessageRoundTrip(t *testing.T) {
	key := []byte("01234567890123456789012345678901")
	plaintext := []byte("message body")

	ciphertext, nonce, err := sharedmessage.Encrypt(key, plaintext)
	if err != nil {
		t.Fatalf("encryptMessage() error = %v", err)
	}
	if string(ciphertext) == string(plaintext) {
		t.Fatal("ciphertext must not equal plaintext")
	}
	decrypted, err := sharedmessage.Decrypt(key, ciphertext, nonce)
	if err != nil {
		t.Fatalf("decryptMessage() error = %v", err)
	}
	if decrypted != string(plaintext) {
		t.Fatalf("decrypted message = %q, want %q", decrypted, plaintext)
	}
}

func TestDecryptMessageRejectsTampering(t *testing.T) {
	key := []byte("01234567890123456789012345678901")
	ciphertext, nonce, err := sharedmessage.Encrypt(key, []byte("message body"))
	if err != nil {
		t.Fatalf("encryptMessage() error = %v", err)
	}
	ciphertext[0] ^= 1
	if _, err := sharedmessage.Decrypt(key, ciphertext, nonce); err == nil {
		t.Fatal("decryptMessage() accepted tampered ciphertext")
	}
}

func TestOrderedUsersIsSymmetric(t *testing.T) {
	first := uuid.MustParse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
	second := uuid.MustParse("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
	low, high := conversation.OrderedUsers(first, second)
	reverseLow, reverseHigh := conversation.OrderedUsers(second, first)
	if low != reverseLow || high != reverseHigh || low != first || high != second {
		t.Fatalf("ordered users = %s/%s, reverse = %s/%s", low, high, reverseLow, reverseHigh)
	}
}
