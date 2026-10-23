package pushcrypto

import (
	"crypto/elliptic"
	"crypto/rand"
	"encoding/base64"
	"testing"
)

func TestVAPIDFingerprintValidatesCurvePoint(t *testing.T) {
	_, x, y, err := elliptic.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	encoded := base64.RawURLEncoding.EncodeToString(elliptic.Marshal(elliptic.P256(), x, y))
	if id, err := VAPIDFingerprint(encoded); err != nil || len(id) != 64 {
		t.Fatalf("valid key id=%q err=%v", id, err)
	}
	bad := base64.RawURLEncoding.EncodeToString(append([]byte{4}, make([]byte, 64)...))
	if _, err := VAPIDFingerprint(bad); err == nil {
		t.Fatal("accepted point not on P-256")
	}
}
