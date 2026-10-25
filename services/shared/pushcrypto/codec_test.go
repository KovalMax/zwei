package pushcrypto

import (
	"bytes"
	"testing"
)

func TestSealEncryptsSubscriptionAndFingerprintsEndpoint(t *testing.T) {
	codec, err := New(bytes.Repeat([]byte{0x31}, 32), bytes.Repeat([]byte{0x72}, 32))
	if err != nil {
		t.Fatal(err)
	}
	want := Subscription{Endpoint: "https://fcm.googleapis.com/fcm/send/secret-token", P256DH: "public-key-value", Auth: "auth-secret"}
	version, ciphertext, fingerprint, err := codec.Seal(want)
	if err != nil {
		t.Fatal(err)
	}
	if version != CurrentVersion {
		t.Fatalf("version = %q, want %q", version, CurrentVersion)
	}
	for _, secret := range []string{want.Endpoint, want.P256DH, want.Auth} {
		if bytes.Contains(ciphertext, []byte(secret)) {
			t.Fatalf("ciphertext contains plaintext secret %q", secret)
		}
	}
	if !bytes.Equal(fingerprint, codec.Fingerprint(want.Endpoint)) {
		t.Fatal("fingerprint changed for the same endpoint")
	}
	opened, err := codec.Open(version, ciphertext)
	if err != nil || opened != want {
		t.Fatalf("Open() = %#v, %v; want %#v", opened, err, want)
	}
	other, err := New(bytes.Repeat([]byte{0x31}, 32), bytes.Repeat([]byte{0x73}, 32))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(fingerprint, other.Fingerprint(want.Endpoint)) {
		t.Fatal("fingerprint was not keyed")
	}
}

func TestOpenRejectsUnknownVersion(t *testing.T) {
	codec, err := New(bytes.Repeat([]byte{0x31}, 32), bytes.Repeat([]byte{0x72}, 32))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := codec.Open("v2", []byte("ciphertext")); err == nil {
		t.Fatal("Open() accepted an unknown encryption version")
	}
}

func TestKeyringReadsV1AndWritesV2(t *testing.T) {
	indexKey := bytes.Repeat([]byte{0x72}, 32)
	old, err := NewKeyring(map[string][]byte{"v1": bytes.Repeat([]byte{1}, 32)}, "v1", indexKey)
	if err != nil {
		t.Fatal(err)
	}
	want := Subscription{Endpoint: "https://push.example/secret", P256DH: "p", Auth: "a"}
	v1, encrypted, _, err := old.Seal(want)
	if err != nil {
		t.Fatal(err)
	}
	rotated, err := NewKeyring(map[string][]byte{"v1": bytes.Repeat([]byte{1}, 32), "v2": bytes.Repeat([]byte{2}, 32)}, "v2", indexKey)
	if err != nil {
		t.Fatal(err)
	}
	got, err := rotated.Open(v1, encrypted)
	if err != nil || got != want {
		t.Fatalf("read v1 = %#v, %v", got, err)
	}
	version, ciphertext, _, err := rotated.Seal(want)
	if err != nil {
		t.Fatal(err)
	}
	if version != "v2" {
		t.Fatalf("write version = %q", version)
	}
	got, err = rotated.Open(version, ciphertext)
	if err != nil || got != want {
		t.Fatalf("read v2 = %#v, %v", got, err)
	}
}

func TestFingerprintKeyIDIsDeterministicAndDomainSeparated(t *testing.T) {
	key := bytes.Repeat([]byte{0x72}, 32)
	codec, err := New(bytes.Repeat([]byte{0x31}, 32), key)
	if err != nil {
		t.Fatal(err)
	}
	other, err := New(bytes.Repeat([]byte{0x31}, 32), key)
	if err != nil {
		t.Fatal(err)
	}
	want := [32]byte{0x00} // Independently computed HMAC-SHA256 known value.
	if got := codec.FingerprintKeyID(); got != other.FingerprintKeyID() {
		t.Fatal("same key produced different identities")
	} else if got == want {
		t.Fatal("key identity unexpectedly has the zero value")
	}
	changedKey, err := New(bytes.Repeat([]byte{0x31}, 32), bytes.Repeat([]byte{0x73}, 32))
	if err != nil {
		t.Fatal(err)
	}
	if codec.FingerprintKeyID() == changedKey.FingerprintKeyID() {
		t.Fatal("different keys produced the same identity")
	}
	endpointDerived := codec.Fingerprint("zwei/push/fingerprint-key-id/v1")
	keyID := codec.FingerprintKeyID()
	if bytes.Equal(keyID[:], endpointDerived) {
		t.Fatal("key identity reused the endpoint fingerprint domain")
	}
}
