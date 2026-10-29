package config

import "testing"

func TestUniqueRefreshCookieIssuanceIsOptIn(t *testing.T) {
	t.Setenv("JWT_SECRET", "0123456789abcdef0123456789abcdef")
	t.Setenv("PUSH_SUBSCRIPTION_ENCRYPTION_KEY_V1", "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")
	t.Setenv("PUSH_SUBSCRIPTION_FINGERPRINT_KEY", "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")
	for _, tc := range []struct {
		value            string
		enabled, invalid bool
	}{{"", false, false}, {"true", true, false}, {"false", false, false}, {"invalid", false, true}} {
		t.Setenv("AUTH_UNIQUE_REFRESH_COOKIES", tc.value)
		cfg, err := Load()
		if (err != nil) != tc.invalid || (!tc.invalid && cfg.UniqueRefreshCookies != tc.enabled) {
			t.Fatalf("flag %q: enabled=%v err=%v", tc.value, cfg.UniqueRefreshCookies, err)
		}
	}
}

func TestLoadDefaultsTrustedProxyToLocalTraefikAddress(t *testing.T) {
	t.Setenv("JWT_SECRET", "0123456789abcdef0123456789abcdef")
	t.Setenv("PUSH_SUBSCRIPTION_ENCRYPTION_KEY_V1", "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")
	t.Setenv("PUSH_SUBSCRIPTION_FINGERPRINT_KEY", "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")
	t.Setenv("TRUSTED_PROXY_CIDRS", "")
	t.Setenv("VAPID_PUBLIC_KEY", "")

	config, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if config.TrustedProxyCIDRs != "172.30.0.250/32" {
		t.Fatalf("TrustedProxyCIDRs = %q, want local Traefik address", config.TrustedProxyCIDRs)
	}
}

func TestLoadPushKeyringCurrentVersionAndOldKey(t *testing.T) {
	t.Setenv("JWT_SECRET", "0123456789abcdef0123456789abcdef")
	t.Setenv("PUSH_SUBSCRIPTION_ENCRYPTION_KEY_V1", "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")
	t.Setenv("PUSH_SUBSCRIPTION_ENCRYPTION_KEY_V2", "101112131415161718191a1b1c1d1e1f000102030405060708090a0b0c0d0e0f")
	t.Setenv("PUSH_SUBSCRIPTION_FINGERPRINT_KEY", "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")
	t.Setenv("PUSH_SUBSCRIPTION_ENCRYPTION_CURRENT_VERSION", "v2")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.PushEncryptionCurrentVersion != "v2" || len(cfg.PushEncryptionKeys) != 2 || len(cfg.PushEncryptionKeys["v1"]) != 32 || len(cfg.PushEncryptionKeys["v2"]) != 32 {
		t.Fatalf("unexpected keyring config: %#v", cfg)
	}
}

func TestLoadRejectsCurrentVersionWithoutKey(t *testing.T) {
	t.Setenv("JWT_SECRET", "0123456789abcdef0123456789abcdef")
	t.Setenv("PUSH_SUBSCRIPTION_ENCRYPTION_KEY_V1", "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")
	t.Setenv("PUSH_SUBSCRIPTION_ENCRYPTION_KEY_V2", "")
	t.Setenv("PUSH_SUBSCRIPTION_ENCRYPTION_CURRENT_VERSION", "v2")
	t.Setenv("PUSH_SUBSCRIPTION_FINGERPRINT_KEY", "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")
	if _, err := Load(); err == nil {
		t.Fatal("accepted missing current key")
	}
}

func TestLoadRejectsV2RotationWithoutV1ReadKey(t *testing.T) {
	t.Setenv("JWT_SECRET", "0123456789abcdef0123456789abcdef")
	t.Setenv("PUSH_SUBSCRIPTION_ENCRYPTION_KEY_V1", "")
	t.Setenv("PUSH_SUBSCRIPTION_ENCRYPTION_KEY_V2", "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")
	t.Setenv("PUSH_SUBSCRIPTION_ENCRYPTION_CURRENT_VERSION", "v2")
	t.Setenv("PUSH_SUBSCRIPTION_FINGERPRINT_KEY", "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")
	if _, err := Load(); err == nil {
		t.Fatal("accepted v2 rotation without the v1 read key")
	}
}

func TestLoadRejectsMissingPushKeys(t *testing.T) {
	t.Setenv("JWT_SECRET", "0123456789abcdef0123456789abcdef")
	valid := "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
	for _, test := range []struct{ name, encryption, fingerprint string }{
		{name: "encryption", fingerprint: valid},
		{name: "fingerprint", encryption: valid},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("PUSH_SUBSCRIPTION_ENCRYPTION_KEY_V1", test.encryption)
			t.Setenv("PUSH_SUBSCRIPTION_FINGERPRINT_KEY", test.fingerprint)
			if _, err := Load(); err == nil {
				t.Fatal("Load() accepted absent push key")
			}
		})
	}
}

func TestLoadRejectsMalformedPushKeys(t *testing.T) {
	t.Setenv("JWT_SECRET", "0123456789abcdef0123456789abcdef")
	for _, test := range []struct{ name, encryption, fingerprint string }{
		{name: "encryption", encryption: "not-hex", fingerprint: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"},
		{name: "fingerprint", encryption: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", fingerprint: "01"},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("PUSH_SUBSCRIPTION_ENCRYPTION_KEY_V1", test.encryption)
			t.Setenv("PUSH_SUBSCRIPTION_FINGERPRINT_KEY", test.fingerprint)
			if _, err := Load(); err == nil {
				t.Fatal("Load() accepted malformed push key")
			}
		})
	}
}

func TestLoadRejectsMalformedVAPIDPublicKey(t *testing.T) {
	t.Setenv("JWT_SECRET", "0123456789abcdef0123456789abcdef")
	t.Setenv("PUSH_SUBSCRIPTION_ENCRYPTION_KEY_V1", "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")
	t.Setenv("PUSH_SUBSCRIPTION_FINGERPRINT_KEY", "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")
	t.Setenv("VAPID_PUBLIC_KEY", "not-a-vapid-key")
	if _, err := Load(); err == nil {
		t.Fatal("Load() accepted malformed VAPID public key")
	}
}

func TestLoadPreservesExplicitTrustedProxyCIDRs(t *testing.T) {
	t.Setenv("JWT_SECRET", "0123456789abcdef0123456789abcdef")
	t.Setenv("PUSH_SUBSCRIPTION_ENCRYPTION_KEY_V1", "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")
	t.Setenv("PUSH_SUBSCRIPTION_FINGERPRINT_KEY", "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")
	configured := "192.168.10.0/24,fd12:3456:789a::/48,127.0.0.1/32,::1/128"
	t.Setenv("TRUSTED_PROXY_CIDRS", configured)

	config, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if config.TrustedProxyCIDRs != configured {
		t.Fatalf("TrustedProxyCIDRs = %q, want explicitly configured ranges", config.TrustedProxyCIDRs)
	}
}

func TestLoadAllowsGiphyAPIKeyToBeUnset(t *testing.T) {
	t.Setenv("JWT_SECRET", "0123456789abcdef0123456789abcdef")
	t.Setenv("PUSH_SUBSCRIPTION_ENCRYPTION_KEY_V1", "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")
	t.Setenv("PUSH_SUBSCRIPTION_FINGERPRINT_KEY", "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")
	t.Setenv("GIPHY_API_KEY", "")

	config, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if config.GiphyAPIKey != "" {
		t.Fatalf("GiphyAPIKey = %q, want empty when feature key is unconfigured", config.GiphyAPIKey)
	}
}
