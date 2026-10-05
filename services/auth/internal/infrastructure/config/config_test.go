package config

import "testing"

func TestLoadDefaultsTrustedProxyToLocalTraefikAddress(t *testing.T) {
	t.Setenv("JWT_SECRET", "0123456789abcdef0123456789abcdef")
	t.Setenv("TRUSTED_PROXY_CIDRS", "")

	config, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if config.TrustedProxyCIDRs != "172.30.0.250/32" {
		t.Fatalf("TrustedProxyCIDRs = %q, want local Traefik address", config.TrustedProxyCIDRs)
	}
}

func TestLoadPreservesExplicitTrustedProxyCIDRs(t *testing.T) {
	t.Setenv("JWT_SECRET", "0123456789abcdef0123456789abcdef")
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
