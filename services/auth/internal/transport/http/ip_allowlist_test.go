package httptransport

import (
	"net/http/httptest"
	"testing"
)

func TestIPAllowlistUsesForwardedClientAddress(t *testing.T) {
	allowlist, err := NewIPAllowlist("203.0.113.0/24,127.0.0.1/32")
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest("GET", "https://kyc.chat.false.tel/api/admin/users", nil)
	request.RemoteAddr = "172.20.0.4:43122"
	request.Header.Set("X-Forwarded-For", "203.0.113.18, 172.20.0.2")
	if !allowlist.Allow(request) {
		t.Fatal("expected forwarded address to be allowed")
	}

	request.Header.Set("X-Forwarded-For", "198.51.100.18, 172.20.0.2")
	if allowlist.Allow(request) {
		t.Fatal("expected non-allowlisted address to be rejected")
	}
}

func TestIPAllowlistRejectsInvalidConfiguration(t *testing.T) {
	if _, err := NewIPAllowlist("not-an-ip"); err == nil {
		t.Fatal("expected invalid configuration error")
	}
	if _, err := NewIPAllowlist(" , "); err == nil {
		t.Fatal("expected empty configuration error")
	}
}
