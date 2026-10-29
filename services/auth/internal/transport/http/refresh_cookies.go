package httptransport

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"

	"github.com/KovalMax/zwei/services/auth/internal/application"
)

const legacyRefreshCookie = "zwei_refresh"
const uniqueRefreshPrefix = "zwei_refresh_"
const signedOutCookie = "zwei_signed_out"
const maxCookieHeaderBytes = 16 * 1024

func uniqueRefreshCookieName(token string) string {
	hash := sha256.Sum256([]byte(token))
	return uniqueRefreshPrefix + hex.EncodeToString(hash[:16])
}

// Only observed, correctly bound names can later be deleted. A conflicting
// duplicate name cannot be safely associated with a particular cookie path.
func refreshCandidateCookies(r *http.Request) ([]*http.Cookie, error) {
	return parseRefreshCandidateCookies(r, application.MaxRefreshCandidates)
}

func v2RefreshCandidateCookies(r *http.Request) ([]*http.Cookie, error) {
	return parseRefreshCandidateCookies(r, application.MaxV2RefreshCandidates)
}

func parseRefreshCandidateCookies(r *http.Request, maxCandidates int) ([]*http.Cookie, error) {
	size := 0
	for _, header := range r.Header.Values("Cookie") {
		size += len(header)
	}
	if size > maxCookieHeaderBytes {
		return nil, errors.New("cookie header too large")
	}
	var result []*http.Cookie
	seen := make(map[string]string)
	count := 0
	for _, cookie := range r.Cookies() {
		if cookie.Name != legacyRefreshCookie && !strings.HasPrefix(cookie.Name, uniqueRefreshPrefix) {
			continue
		}
		count++
		if count > maxCandidates || cookie.Value == "" || len(cookie.Value) > 4096 {
			return nil, errors.New("invalid refresh cookies")
		}
		if cookie.Name != legacyRefreshCookie && cookie.Name != uniqueRefreshCookieName(cookie.Value) {
			return nil, errors.New("invalid refresh cookie binding")
		}
		if old, ok := seen[cookie.Name]; ok {
			if old != cookie.Value {
				return nil, errors.New("conflicting refresh cookie")
			}
			continue
		}
		seen[cookie.Name] = cookie.Value
		result = append(result, cookie)
	}
	return result, nil
}

func writeRefreshCookie(w http.ResponseWriter, name, token string, maxAge int) {
	http.SetCookie(w, &http.Cookie{Name: name, Value: token, Path: "/api/auth", HttpOnly: true, Secure: true, SameSite: http.SameSiteNoneMode, MaxAge: maxAge})
}

func hasSignedOutCookie(r *http.Request) bool {
	for _, cookie := range r.Cookies() {
		if cookie.Name == signedOutCookie {
			return true
		}
	}
	return false
}

func clearObservedSignedOutCookie(w http.ResponseWriter, r *http.Request) {
	if hasSignedOutCookie(r) {
		writeRefreshCookie(w, signedOutCookie, "", -1)
	}
}
