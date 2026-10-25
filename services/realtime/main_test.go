package main

import (
	"testing"

	"github.com/KovalMax/zwei/services/shared/pushcrypto"
)

const testKeyV1 = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
const testKeyV2 = "101112131415161718191a1b1c1d1e1f000102030405060708090a0b0c0d0e0f"

func TestPushCodecFromEnvironmentUsesCurrentAndRetainsOldKey(t *testing.T) {
	t.Setenv("PUSH_SUBSCRIPTION_ENCRYPTION_KEY_V1", testKeyV1)
	t.Setenv("PUSH_SUBSCRIPTION_ENCRYPTION_KEY_V2", testKeyV2)
	t.Setenv("PUSH_SUBSCRIPTION_ENCRYPTION_CURRENT_VERSION", "v2")
	t.Setenv("PUSH_SUBSCRIPTION_FINGERPRINT_KEY", testKeyV1)
	codec, err := pushCodecFromEnvironment()
	if err != nil {
		t.Fatal(err)
	}
	version, _, _, err := codec.Seal(pushcrypto.Subscription{Endpoint: "https://push.example/endpoint"})
	if err != nil || version != "v2" {
		t.Fatalf("write version=%q err=%v", version, err)
	}
}

func TestPushCodecFromEnvironmentRequiresOldKeyForV2(t *testing.T) {
	t.Setenv("PUSH_SUBSCRIPTION_ENCRYPTION_KEY_V1", "")
	t.Setenv("PUSH_SUBSCRIPTION_ENCRYPTION_KEY_V2", testKeyV2)
	t.Setenv("PUSH_SUBSCRIPTION_ENCRYPTION_CURRENT_VERSION", "v2")
	t.Setenv("PUSH_SUBSCRIPTION_FINGERPRINT_KEY", testKeyV1)
	if _, err := pushCodecFromEnvironment(); err == nil {
		t.Fatal("accepted v2 without old read key")
	}
}
