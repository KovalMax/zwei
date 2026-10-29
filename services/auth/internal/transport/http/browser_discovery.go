package httptransport

import (
	"errors"
	"io"
	"net/http"

	"github.com/KovalMax/zwei/services/auth/internal/application"
	"github.com/KovalMax/zwei/services/internal/runtime"
)

// Discovery returns a snapshot of nonsecret selectors, never an authorization
// grant. Subsequent mutations must revalidate the cookie proof under lock.
func (h *Handler) discoverBrowser(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !h.refreshOriginAllowed(w, r) || !h.authHostAllowed(w, r) {
		return
	}
	var one [1]byte
	if n, err := io.ReadFull(r.Body, one[:]); n != 0 || !errors.Is(err, io.EOF) {
		errorJSON(w, http.StatusBadRequest, "invalid discovery request")
		return
	}
	cookies, err := refreshCandidateCookies(r)
	if err != nil {
		errorJSON(w, http.StatusBadRequest, "invalid discovery request")
		return
	}
	if hasSignedOutCookie(r) || len(cookies) == 0 {
		errorJSON(w, http.StatusUnauthorized, "invalid refresh token")
		return
	}
	if h.browserDiscovery == nil {
		errorJSON(w, http.StatusInternalServerError, "discovery unavailable")
		return
	}
	values := make([]string, len(cookies))
	for i, cookie := range cookies {
		values[i] = cookie.Value
	}
	credential, err := application.DiscoverBrowserCredential(r.Context(), h.browserDiscovery, values)
	if errors.Is(err, application.ErrInvalidInput) {
		errorJSON(w, http.StatusBadRequest, "invalid discovery request")
		return
	}
	if errors.Is(err, application.ErrRefreshToken) {
		errorJSON(w, http.StatusUnauthorized, "invalid refresh token")
		return
	}
	if err != nil {
		errorJSON(w, http.StatusInternalServerError, "discovery unavailable")
		return
	}
	runtime.WriteJSON(w, http.StatusOK, struct {
		BrowserID  string `json:"browser_id"`
		Generation string `json:"generation"`
	}{credential.BrowserID.String(), credential.Generation.String()})
}
