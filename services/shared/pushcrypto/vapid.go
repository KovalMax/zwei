package pushcrypto

import (
	"crypto/elliptic"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
)

// VAPIDFingerprint validates an uncompressed P-256 public point and returns its
// stable SHA-256 key identifier. It contains no secret material.
func VAPIDFingerprint(encoded string) (string, error) {
	point, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(point) != 65 || point[0] != 4 {
		return "", errors.New("invalid VAPID P-256 public key")
	}
	x, y := elliptic.Unmarshal(elliptic.P256(), point)
	if x == nil || y == nil || !elliptic.P256().IsOnCurve(x, y) {
		return "", errors.New("invalid VAPID P-256 public key")
	}
	digest := sha256.Sum256(point)
	return hex.EncodeToString(digest[:]), nil
}
