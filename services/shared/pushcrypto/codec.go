package pushcrypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

const CurrentVersion = "v2"

var ErrInvalidKey = errors.New("invalid push subscription key")

type Subscription struct {
	Endpoint string `json:"endpoint"`
	P256DH   string `json:"p256dh"`
	Auth     string `json:"auth"`
}

type Codec struct {
	aeads          map[string]cipher.AEAD
	currentVersion string
	fingerprintKey []byte
}

func New(encryptionKey, fingerprintKey []byte) (*Codec, error) {
	return NewKeyring(map[string][]byte{CurrentVersion: encryptionKey}, CurrentVersion, fingerprintKey)
}

// NewKeyring retains decrypt-only keys while writing with currentVersion.
func NewKeyring(encryptionKeys map[string][]byte, currentVersion string, fingerprintKey []byte) (*Codec, error) {
	if len(encryptionKeys) == 0 || len(encryptionKeys[currentVersion]) != 32 || len(fingerprintKey) < 32 {
		return nil, ErrInvalidKey
	}
	aeads := make(map[string]cipher.AEAD, len(encryptionKeys))
	for version, key := range encryptionKeys {
		if version == "" || len(key) != 32 {
			return nil, ErrInvalidKey
		}
		block, err := aes.NewCipher(key)
		if err != nil {
			return nil, ErrInvalidKey
		}
		aead, err := cipher.NewGCM(block)
		if err != nil {
			return nil, ErrInvalidKey
		}
		aeads[version] = aead
	}
	return &Codec{aeads: aeads, currentVersion: currentVersion, fingerprintKey: append([]byte(nil), fingerprintKey...)}, nil
}

func (c *Codec) Seal(subscription Subscription) (version string, ciphertext, fingerprint []byte, err error) {
	plaintext, err := json.Marshal(subscription)
	if err != nil {
		return "", nil, nil, err
	}
	aead := c.aeads[c.currentVersion]
	nonce := make([]byte, aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", nil, nil, fmt.Errorf("generate push encryption nonce: %w", err)
	}
	ciphertext = aead.Seal(nonce, nonce, plaintext, []byte(c.currentVersion))
	mac := hmac.New(sha256.New, c.fingerprintKey)
	_, _ = mac.Write([]byte(subscription.Endpoint))
	return c.currentVersion, ciphertext, mac.Sum(nil), nil
}

func (c *Codec) Open(version string, ciphertext []byte) (Subscription, error) {
	aead, ok := c.aeads[version]
	if !ok || len(ciphertext) < aead.NonceSize() {
		return Subscription{}, errors.New("unsupported push subscription encryption")
	}
	nonce := ciphertext[:aead.NonceSize()]
	plaintext, err := aead.Open(nil, nonce, ciphertext[aead.NonceSize():], []byte(version))
	if err != nil {
		return Subscription{}, errors.New("could not decrypt push subscription")
	}
	var subscription Subscription
	if err := json.Unmarshal(plaintext, &subscription); err != nil {
		return Subscription{}, errors.New("invalid encrypted push subscription")
	}
	return subscription, nil
}

func (c *Codec) Fingerprint(endpoint string) []byte {
	mac := hmac.New(sha256.New, c.fingerprintKey)
	_, _ = mac.Write([]byte(endpoint))
	return mac.Sum(nil)
}

// FingerprintKeyID returns a stable, domain-separated identifier for the
// endpoint fingerprint key. It is safe to persist as key identity metadata;
// it does not expose the key itself.
func (c *Codec) FingerprintKeyID() [sha256.Size]byte {
	derive := hmac.New(sha256.New, c.fingerprintKey)
	_, _ = derive.Write([]byte("zwei/push/fingerprint-key-id/v1"))
	key := derive.Sum(nil)
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte("identity"))
	var id [sha256.Size]byte
	copy(id[:], mac.Sum(nil))
	return id
}
