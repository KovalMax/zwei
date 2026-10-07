package httptransport

import (
	"errors"
	"net"
	"net/http"
	"net/netip"
	"strings"
)

type IPAllowlist struct {
	prefixes       []netip.Prefix
	trustedProxies []netip.Prefix
}

func NewIPAllowlist(value, trustedProxyValue string) (*IPAllowlist, error) {
	prefixes, err := parsePrefixes(value, "administrator IP allowlist")
	if err != nil {
		return nil, err
	}
	trustedProxies, err := parsePrefixes(trustedProxyValue, "trusted proxy CIDRs")
	if err != nil {
		return nil, err
	}
	if err := validateTrustedProxyPrefixes(trustedProxies); err != nil {
		return nil, err
	}
	return &IPAllowlist{prefixes: prefixes, trustedProxies: trustedProxies}, nil
}

func validateTrustedProxyPrefixes(prefixes []netip.Prefix) error {
	privateRanges := [...]netip.Prefix{
		netip.MustParsePrefix("10.0.0.0/8"),
		netip.MustParsePrefix("172.16.0.0/12"),
		netip.MustParsePrefix("192.168.0.0/16"),
		netip.MustParsePrefix("fc00::/7"),
	}
	loopbackRanges := [...]netip.Prefix{
		netip.MustParsePrefix("127.0.0.0/8"),
		netip.MustParsePrefix("::1/128"),
	}
	for _, prefix := range prefixes {
		contained := false
		for _, allowed := range privateRanges {
			if prefix.Bits() >= allowed.Bits() && allowed.Contains(prefix.Addr()) {
				contained = true
				break
			}
		}
		if !contained {
			for _, allowed := range loopbackRanges {
				if prefix.Bits() >= allowed.Bits() && allowed.Contains(prefix.Addr()) {
					contained = true
					break
				}
			}
		}
		if !contained {
			return errors.New("trusted proxy CIDRs must be within private or loopback ranges")
		}
	}
	return nil
}

func parsePrefixes(value, label string) ([]netip.Prefix, error) {
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
				return nil, errors.New("invalid " + label)
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
		return nil, errors.New(label + " is empty")
	}
	return prefixes, nil
}

func (a *IPAllowlist) Allow(r *http.Request) bool {
	if a == nil {
		return false
	}
	address := a.forwardedAddress(r)
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

func (a *IPAllowlist) forwardedAddress(r *http.Request) netip.Addr {
	host, _, err := net.SplitHostPort(strings.TrimSpace(r.RemoteAddr))
	if err != nil {
		return netip.Addr{}
	}
	peer, err := netip.ParseAddr(host)
	if err != nil || !containsAddress(a.trustedProxies, peer) {
		return netip.Addr{}
	}

	forwarded := strings.TrimSpace(r.Header.Get("X-Forwarded-For"))
	if forwarded == "" {
		value := strings.TrimSpace(r.Header.Get("X-Real-IP"))
		address, parseErr := netip.ParseAddr(value)
		if value == "" || parseErr != nil {
			return netip.Addr{}
		}
		return address
	}

	chain := strings.Split(forwarded, ",")
	addresses := make([]netip.Addr, 0, len(chain))
	for _, item := range chain {
		address, parseErr := netip.ParseAddr(strings.TrimSpace(item))
		if parseErr != nil {
			return netip.Addr{}
		}
		addresses = append(addresses, address)
	}
	current := peer
	for index := len(addresses) - 1; index >= 0; index-- {
		if !containsAddress(a.trustedProxies, current) {
			return current
		}
		current = addresses[index]
	}
	return current
}

func containsAddress(prefixes []netip.Prefix, address netip.Addr) bool {
	for _, prefix := range prefixes {
		if prefix.Contains(address) {
			return true
		}
	}
	return false
}
