package httptransport

import (
	"errors"
	"net"
	"net/http"
	"net/netip"
	"strings"
)

type IPAllowlist struct {
	prefixes []netip.Prefix
}

func NewIPAllowlist(value string) (*IPAllowlist, error) {
	var prefixes []netip.Prefix
	for _, item := range strings.Split(value, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		prefix, err := netip.ParsePrefix(item)
		if err != nil {
			address, addressErr := netip.ParseAddr(item)
			if addressErr != nil {
				return nil, errors.New("invalid administrator IP allowlist")
			}
			bits := 128
			if address.Is4() {
				bits = 32
			}
			prefix = netip.PrefixFrom(address, bits)
		}
		prefixes = append(prefixes, prefix)
	}
	if len(prefixes) == 0 {
		return nil, errors.New("administrator IP allowlist is empty")
	}
	return &IPAllowlist{prefixes: prefixes}, nil
}

func (a *IPAllowlist) Allow(r *http.Request) bool {
	if a == nil {
		return false
	}
	address := forwardedAddress(r)
	if address == (netip.Addr{}) {
		return false
	}
	for _, prefix := range a.prefixes {
		if prefix.Contains(address) {
			return true
		}
	}
	return false
}

func forwardedAddress(r *http.Request) netip.Addr {
	value := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-For"), ",")[0])
	if value == "" {
		value = strings.TrimSpace(r.Header.Get("X-Real-IP"))
	}
	if value != "" {
		if address, err := netip.ParseAddr(value); err == nil {
			return address
		}
	}
	host, _, err := net.SplitHostPort(strings.TrimSpace(r.RemoteAddr))
	if err != nil {
		return netip.Addr{}
	}
	address, _ := netip.ParseAddr(host)
	return address
}
