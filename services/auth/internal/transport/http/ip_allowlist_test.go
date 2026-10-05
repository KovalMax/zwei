package httptransport

import (
	"net/http/httptest"
	"testing"
)

func TestIPAllowlistUsesForwardedClientAddress(t *testing.T) {
	allowlist, err := NewIPAllowlist("203.0.113.0/24,127.0.0.1/32", "172.20.0.4/32")
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest("GET", "https://kyc.chat.false.tel/api/admin/users", nil)
	request.RemoteAddr = "172.20.0.4:43122"
	request.Header.Set("X-Forwarded-For", "203.0.113.18")
	if !allowlist.Allow(request) {
		t.Fatal("expected forwarded address to be allowed")
	}

	request.Header.Set("X-Forwarded-For", "198.51.100.18")
	if allowlist.Allow(request) {
		t.Fatal("expected non-allowlisted address to be rejected")
	}
}

func TestIPAllowlistRejectsAllowlistedForwardingFromUntrustedPeer(t *testing.T) {
	allowlist, err := NewIPAllowlist("203.0.113.10/32", "172.20.0.4/32")
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest("GET", "/api/admin/users", nil)
	request.RemoteAddr = "198.51.100.20:43122"
	request.Header.Set("X-Forwarded-For", "203.0.113.10")
	if allowlist.Allow(request) {
		t.Fatal("untrusted peer spoofed an allowlisted forwarded address")
	}
}

func TestIPAllowlistWalksTrustedForwardedChainFromRight(t *testing.T) {
	allowlist, err := NewIPAllowlist("203.0.113.10/32", "172.20.0.0/24")
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest("GET", "/api/admin/users", nil)
	request.RemoteAddr = "172.20.0.4:43122"
	request.Header.Set("X-Forwarded-For", "203.0.113.10, 172.20.0.3")
	if !allowlist.Allow(request) {
		t.Fatal("expected allowlisted client behind trusted proxy chain")
	}
}

func TestIPAllowlistFailsClosedOnMalformedForwardedChain(t *testing.T) {
	allowlist, err := NewIPAllowlist("203.0.113.10/32", "172.20.0.4/32")
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest("GET", "/api/admin/users", nil)
	request.RemoteAddr = "172.20.0.4:43122"
	request.Header.Set("X-Forwarded-For", "203.0.113.10, malformed")
	if allowlist.Allow(request) {
		t.Fatal("malformed forwarded chain was accepted")
	}
}

func TestIPAllowlistRejectsInvalidConfiguration(t *testing.T) {
	if _, err := NewIPAllowlist("not-an-ip", "172.20.0.4/32"); err == nil {
		t.Fatal("expected invalid configuration error")
	}
	if _, err := NewIPAllowlist("203.0.113.0/24", " , "); err == nil {
		t.Fatal("expected empty configuration error")
	}
}

func TestNewIPAllowlistAcceptsPrivateAndLoopbackProxyRanges(t *testing.T) {
	tests := []struct {
		name  string
		cidrs string
	}{
		{name: "IPv4 RFC1918", cidrs: "10.0.0.0/8,172.16.0.0/12,192.168.1.0/24"},
		{name: "IPv6 unique local", cidrs: "fc00::/7,fd12:3456:789a::/48"},
		{name: "IPv4 loopback", cidrs: "127.0.0.1/32,127.0.0.0/8"},
		{name: "IPv6 loopback", cidrs: "::1/128"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := NewIPAllowlist("203.0.113.10/32", tt.cidrs); err != nil {
				t.Fatalf("NewIPAllowlist() error = %v", err)
			}
		})
	}
}

func TestNewIPAllowlistRejectsPublicAndBroadProxyRanges(t *testing.T) {
	tests := []struct {
		name  string
		cidrs string
	}{
		{name: "IPv4 default route", cidrs: "0.0.0.0/0"},
		{name: "IPv6 default route", cidrs: "::/0"},
		{name: "public IPv4", cidrs: "8.8.8.8/32"},
		{name: "public IPv6", cidrs: "2001:4860:4860::8888/128"},
		{name: "private origin but broad range", cidrs: "10.0.0.0/7"},
		{name: "unspecified IPv4", cidrs: "0.0.0.0/32"},
		{name: "unspecified IPv6", cidrs: "::/128"},
		{name: "malformed", cidrs: "10.0.0.1/not-a-prefix"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := NewIPAllowlist("203.0.113.10/32", tt.cidrs); err == nil {
				t.Fatal("expected unsafe trusted proxy configuration to be rejected")
			}
		})
	}
}
