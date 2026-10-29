package httptransport

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strings"

	"github.com/KovalMax/zwei/services/auth/internal/application"
	"github.com/KovalMax/zwei/services/internal/runtime"
	sharedauth "github.com/KovalMax/zwei/services/shared/auth"
	"github.com/google/uuid"
)

type browserLogin interface {
	AuthenticateBrowserLogin(context.Context, application.Credentials) (application.BrowserSessionTarget, error)
}
type browserSessions interface {
	Create(context.Context, application.CreateBrowserSessionCommand) (application.BrowserSessionResult, error)
	Replace(context.Context, application.ReplaceBrowserSessionCommand) (application.BrowserSessionResult, error)
	Refresh(context.Context, application.RefreshBrowserSessionCommand) (application.BrowserSessionResult, error)
	Logout(context.Context, application.LogoutBrowserSessionCommand) error
}
type browserBearer interface {
	AuthenticateBearer(context.Context, string) (sharedauth.Identity, error)
}
type browserRegistration interface {
	Register(context.Context, application.Credentials, *application.BrowserCredential) (bool, application.BrowserSessionResult, error)
}

// BrowserV2Handler serves the opt-in browser session protocol.
type BrowserV2Handler struct {
	base         *Handler
	login        browserLogin
	discovery    application.BrowserHeadDiscovery
	candidates   application.BrowserCandidateDiscovery
	sessions     browserSessions
	bearer       browserBearer
	registration browserRegistration
}

func (h *BrowserV2Handler) SetRegistration(registration browserRegistration) {
	h.registration = registration
}

func NewBrowserV2Handler(base *Handler, login browserLogin, discovery application.BrowserHeadDiscovery, sessions browserSessions, bearer browserBearer) *BrowserV2Handler {
	return &BrowserV2Handler{base: base, login: login, discovery: discovery, sessions: sessions, bearer: bearer}
}

// SetCandidateDiscovery supplies the multi-head discovery port.
func (h *BrowserV2Handler) SetCandidateDiscovery(discovery application.BrowserCandidateDiscovery) {
	h.candidates = discovery
}

type browserIdentityKey struct{}

// Register installs only v2 routes; legacy routes retain their existing behavior.
func (h *BrowserV2Handler) Register(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/auth/v2/register", h.RegisterAccount)
	mux.HandleFunc("POST /api/auth/v2/login", h.Login)
	mux.HandleFunc("POST /api/auth/v2/refresh", h.Refresh)
	mux.HandleFunc("POST /api/auth/v2/discovery", h.Discover)
	mux.HandleFunc("POST /api/auth/v2/continue", h.Continue)
	mux.Handle("POST /api/auth/v2/logout", h.requireBearer(http.HandlerFunc(h.Logout)))
	mux.HandleFunc("POST /api/auth/v2/logout/retry", h.LogoutRetry)
}

type browserRetryLogout interface {
	LogoutRetry(context.Context, application.LogoutBrowserSessionRetryCommand) error
}

type browserReceiptLogout interface {
	LogoutWithReceipt(context.Context, application.LogoutBrowserSessionCommand, string) error
}

// LogoutRetry uses a cookie proof, not the nonsecret stored selector, as authority.
func (h *BrowserV2Handler) LogoutRetry(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Subject    string  `json:"subject"`
		BrowserID  string  `json:"browser_id"`
		Generation string  `json:"generation"`
		Receipt    *string `json:"receipt"`
	}
	if !h.request(w, r, &req) {
		return
	}
	subject, err := uuid.Parse(req.Subject)
	if err != nil || subject == uuid.Nil {
		h.fail(w, application.ErrInvalidInput)
		return
	}
	sessions, ok := h.sessions.(browserRetryLogout)
	if !ok {
		h.fail(w, errors.New("session unavailable"))
		return
	}
	var receipt string
	if req.Receipt != nil {
		receipt = *req.Receipt
		if receipt == "" {
			h.fail(w, application.ErrInvalidInput)
			return
		}
		browser, e1 := uuid.Parse(req.BrowserID)
		generation, e2 := uuid.Parse(req.Generation)
		if e1 != nil || e2 != nil || browser == uuid.Nil || generation == uuid.Nil {
			h.fail(w, application.ErrInvalidInput)
			return
		}
		err = sessions.LogoutRetry(r.Context(), application.LogoutBrowserSessionRetryCommand{UserID: subject, Current: application.BrowserCredential{BrowserID: browser, Generation: generation}, Receipt: receipt})
		if err == nil {
			if err := h.cleanupReceiptCookies(w, r, subject, browser, generation, receipt); err != nil {
				h.fail(w, err)
				return
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if !errors.Is(err, application.ErrRefreshToken) {
			h.fail(w, err)
			return
		}
	}
	current, cookie, ok := h.selectProof(w, r, browserSelectors{BrowserID: req.BrowserID, Generation: req.Generation})
	if !ok {
		return
	}
	if err := sessions.LogoutRetry(r.Context(), application.LogoutBrowserSessionRetryCommand{UserID: subject, Current: current, Receipt: receipt}); err != nil {
		h.fail(w, err)
		return
	}
	if cookie.Name == legacyRefreshCookie {
		h.fail(w, errors.New("cookie cleanup unconfirmed"))
		return
	}
	writeRefreshCookie(w, cookie.Name, "", -1)
	w.WriteHeader(http.StatusNoContent)
}

// Cleanup is confirmed only after every observed proof has been checked against
// the hash captured atomically by revocation. Never expire a legacy shared name.
func (h *BrowserV2Handler) cleanupReceiptCookies(w http.ResponseWriter, r *http.Request, subject, browser, generation uuid.UUID, receipt string) error {
	for _, header := range r.Header.Values("Cookie") {
		if _, err := http.ParseCookie(header); err != nil {
			return errors.New("cookie cleanup unconfirmed")
		}
	}
	cookies, err := v2RefreshCandidateCookies(r)
	if err != nil {
		return errors.New("cookie cleanup unconfirmed")
	}
	if len(cookies) == 0 {
		return nil
	}
	matcher, ok := h.sessions.(interface {
		ReceiptMatchesRefresh(context.Context, application.LogoutBrowserSessionRetryCommand) (bool, error)
	})
	if !ok {
		return errors.New("cookie cleanup unconfirmed")
	}
	var matched []*http.Cookie
	for _, cookie := range cookies {
		cmd := application.LogoutBrowserSessionRetryCommand{UserID: subject, Current: application.BrowserCredential{BrowserID: browser, Generation: generation, RefreshToken: cookie.Value}, Receipt: receipt}
		matches, err := matcher.ReceiptMatchesRefresh(r.Context(), cmd)
		if err != nil || (matches && cookie.Name == legacyRefreshCookie) {
			return errors.New("cookie cleanup unconfirmed")
		}
		if matches {
			matched = append(matched, cookie)
		}
	}
	for _, cookie := range matched {
		writeRefreshCookie(w, cookie.Name, "", -1)
	}
	return nil
}

func (h *BrowserV2Handler) RegisterAccount(w http.ResponseWriter, r *http.Request) {
	var req credentialsRequest
	if !h.request(w, r, &req) {
		return
	}
	cookies, ok := h.cookies(w, r)
	if !ok {
		return
	}
	if h.registration == nil {
		h.fail(w, errors.New("registration unavailable"))
		return
	}
	var current *application.BrowserCredential
	var old *http.Cookie
	var obsolete []*http.Cookie
	if len(cookies) > 0 && strings.TrimSpace(req.InvitationCode) != "" {
		credential, selected, err := h.discoverProof(r, cookies)
		if errors.Is(err, application.ErrNoLiveBrowserHead) {
			obsolete = cookies
		} else if err != nil {
			h.fail(w, err)
			return
		} else {
			current = &credential
			old = selected
		}
	}
	pending, result, err := h.registration.Register(r.Context(), application.Credentials{Email: req.Email, Password: req.Password, DisplayName: req.DisplayName, DeviceID: req.DeviceID, DeviceName: req.DeviceName, InvitationCode: req.InvitationCode}, current)
	if uniqueViolation(err) {
		errorJSON(w, http.StatusConflict, "email already registered")
		return
	}
	if errors.Is(err, application.ErrInvitationInvalid) {
		errorJSON(w, http.StatusBadRequest, "invalid invitation code")
		return
	}
	if err != nil {
		h.fail(w, err)
		return
	}
	if pending {
		runtime.WriteJSON(w, http.StatusAccepted, map[string]string{"status": "pending"})
		return
	}
	for _, cookie := range obsolete {
		if cookie.Name != legacyRefreshCookie && cookie.Name != uniqueRefreshCookieName(result.Tokens.RefreshToken) {
			writeRefreshCookie(w, cookie.Name, "", -1)
		}
	}
	h.writeStatus(w, result, old, http.StatusCreated)
}

func (h *BrowserV2Handler) requireBearer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if h.bearer == nil {
			errorJSON(w, http.StatusInternalServerError, "session unavailable")
			return
		}
		identity, err := h.bearer.AuthenticateBearer(r.Context(), r.Header.Get("Authorization"))
		if err != nil || identity.UserID == uuid.Nil || identity.BrowserID == uuid.Nil || identity.BrowserGeneration == uuid.Nil {
			errorJSON(w, http.StatusUnauthorized, "invalid access token")
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), browserIdentityKey{}, identity)))
	})
}

type browserSelectors struct {
	BrowserID  string `json:"browser_id"`
	Generation string `json:"generation"`
}

func (h *BrowserV2Handler) request(w http.ResponseWriter, r *http.Request, dst any) bool {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return false
	}
	if !h.base.refreshOriginAllowed(w, r) || !h.base.authHostAllowed(w, r) {
		return false
	}
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		errorJSON(w, http.StatusUnsupportedMediaType, "JSON required")
		return false
	}
	defer r.Body.Close()
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10))
	dec.DisallowUnknownFields()
	if dec.Decode(dst) != nil || dec.Decode(new(any)) != io.EOF {
		errorJSON(w, http.StatusBadRequest, "invalid request")
		return false
	}
	return true
}
func (h *BrowserV2Handler) discoverProof(r *http.Request, cookies []*http.Cookie) (application.BrowserCredential, *http.Cookie, error) {
	if len(cookies) == 0 || h.discovery == nil {
		return application.BrowserCredential{}, nil, application.ErrRefreshToken
	}
	values := make([]string, len(cookies))
	for i, c := range cookies {
		values[i] = c.Value
	}
	credential, err := application.DiscoverBrowserCredential(r.Context(), h.discovery, values)
	if err != nil {
		return application.BrowserCredential{}, nil, err
	}
	var selected *http.Cookie
	for _, c := range cookies {
		if c.Value == credential.RefreshToken {
			if selected != nil {
				return application.BrowserCredential{}, nil, application.ErrInvalidInput
			}
			selected = c
		}
	}
	if selected == nil {
		return application.BrowserCredential{}, nil, application.ErrRefreshToken
	}
	return credential, selected, nil
}
func (h *BrowserV2Handler) proof(w http.ResponseWriter, r *http.Request, cookies []*http.Cookie) (application.BrowserCredential, *http.Cookie, bool) {
	credential, cookie, err := h.discoverProof(r, cookies)
	if err != nil {
		h.fail(w, err)
		return application.BrowserCredential{}, nil, false
	}
	return credential, cookie, true
}
func (h *BrowserV2Handler) cookies(w http.ResponseWriter, r *http.Request) ([]*http.Cookie, bool) {
	cookies, err := v2RefreshCandidateCookies(r)
	if err != nil {
		errorJSON(w, http.StatusBadRequest, "invalid cookies")
		return nil, false
	}
	return cookies, true
}
func (h *BrowserV2Handler) fail(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, application.ErrInvalidInput):
		errorJSON(w, 400, "invalid request")
	case errors.Is(err, application.ErrCredentials), errors.Is(err, application.ErrRefreshToken), errors.Is(err, application.ErrNoLiveBrowserHead):
		errorJSON(w, 401, "invalid credentials")
	case errors.Is(err, application.ErrAccountInactive):
		errorJSON(w, 403, "account is not active")
	default:
		errorJSON(w, 500, "session unavailable")
	}
}

// candidateSnapshot returns selectors only after matching presented HttpOnly
// proofs. It is not an authorization: Continue rotates under repository lock.
func (h *BrowserV2Handler) candidateSnapshot(w http.ResponseWriter, r *http.Request) ([]application.BrowserCandidate, []*http.Cookie, bool) {
	// The legacy fixed-name marker can arrive after a newer login response.
	// It cannot fence v2 proofs; discovery is non-authorizing and Continue
	// requires explicit selection and revalidates the presented proof.
	cookies, ok := h.cookies(w, r)
	if !ok {
		return nil, nil, false
	}
	if len(cookies) == 0 {
		h.fail(w, application.ErrRefreshToken)
		return nil, nil, false
	}
	if h.candidates == nil {
		h.fail(w, errors.New("discovery unavailable"))
		return nil, nil, false
	}
	values := make([]string, len(cookies))
	for i, cookie := range cookies {
		values[i] = cookie.Value
	}
	candidates, err := application.DiscoverBrowserCandidates(r.Context(), h.candidates, values)
	if err != nil {
		h.fail(w, err)
		return nil, nil, false
	}
	return candidates, cookies, true
}

func (h *BrowserV2Handler) Discover(w http.ResponseWriter, r *http.Request) {
	var req struct{}
	if !h.request(w, r, &req) {
		return
	}
	candidates, _, ok := h.candidateSnapshot(w, r)
	if !ok {
		return
	}
	runtime.WriteJSON(w, http.StatusOK, struct {
		Candidates []application.BrowserCandidate `json:"candidates"`
	}{candidates})
}

// Continue selects by nonsecret identifiers only among proofs in this request.
func (h *BrowserV2Handler) Continue(w http.ResponseWriter, r *http.Request) {
	var req browserSelectors
	if !h.request(w, r, &req) {
		return
	}
	browser, e1 := uuid.Parse(req.BrowserID)
	generation, e2 := uuid.Parse(req.Generation)
	if e1 != nil || e2 != nil || browser == uuid.Nil || generation == uuid.Nil {
		h.fail(w, application.ErrInvalidInput)
		return
	}
	candidates, cookies, ok := h.candidateSnapshot(w, r)
	if !ok {
		return
	}
	current, err := application.SelectBrowserCandidate(candidates, browser, generation)
	if err != nil {
		h.fail(w, err)
		return
	}
	var selected *http.Cookie
	for _, cookie := range cookies {
		if cookie.Value == current.RefreshToken {
			if selected != nil {
				h.fail(w, application.ErrInvalidInput)
				return
			}
			selected = cookie
		}
	}
	if selected == nil {
		h.fail(w, application.ErrRefreshToken)
		return
	}
	if h.sessions == nil {
		h.fail(w, errors.New("session unavailable"))
		return
	}
	result, err := h.sessions.Refresh(r.Context(), application.RefreshBrowserSessionCommand{Current: current})
	if err != nil {
		h.fail(w, err)
		return
	}
	h.write(w, result, selected)
}
func (h *BrowserV2Handler) Login(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email      string `json:"email"`
		Password   string `json:"password"`
		DeviceID   string `json:"device_id"`
		DeviceName string `json:"device_name"`
	}
	if !h.request(w, r, &req) {
		return
	}
	cookies, ok := h.cookies(w, r)
	if !ok {
		return
	}
	if h.login == nil || h.sessions == nil {
		errorJSON(w, 500, "session unavailable")
		return
	}
	target, err := h.login.AuthenticateBrowserLogin(r.Context(), application.Credentials{Email: req.Email, Password: req.Password, DeviceID: req.DeviceID, DeviceName: req.DeviceName})
	if err != nil {
		h.fail(w, err)
		return
	}
	var result application.BrowserSessionResult
	var old *http.Cookie
	var obsolete []*http.Cookie
	if len(cookies) == 0 {
		result, err = h.sessions.Create(r.Context(), application.CreateBrowserSessionCommand{Target: target})
	} else {
		var current application.BrowserCredential
		current, old, err = h.discoverProof(r, cookies)
		if errors.Is(err, application.ErrNoLiveBrowserHead) {
			result, err = h.sessions.Create(r.Context(), application.CreateBrowserSessionCommand{Target: target})
			obsolete = cookies
		} else if err != nil {
			h.fail(w, err)
			return
		} else {
			result, err = h.sessions.Replace(r.Context(), application.ReplaceBrowserSessionCommand{Current: current, Target: target})
		}
	}
	if err != nil {
		h.fail(w, err)
		return
	}
	for _, cookie := range obsolete {
		// The legacy name can be reused by another response; only token-bound
		// names are safe to delete from a delayed response.
		if cookie.Name != legacyRefreshCookie && cookie.Name != uniqueRefreshCookieName(result.Tokens.RefreshToken) {
			writeRefreshCookie(w, cookie.Name, "", -1)
		}
	}
	h.write(w, result, old)
}
func (h *BrowserV2Handler) selectProof(w http.ResponseWriter, r *http.Request, req browserSelectors) (application.BrowserCredential, *http.Cookie, bool) {
	browser, e1 := uuid.Parse(req.BrowserID)
	generation, e2 := uuid.Parse(req.Generation)
	if e1 != nil || e2 != nil || browser == uuid.Nil || generation == uuid.Nil {
		errorJSON(w, 400, "invalid selectors")
		return application.BrowserCredential{}, nil, false
	}
	candidates, cookies, ok := h.candidateSnapshot(w, r)
	if !ok {
		return application.BrowserCredential{}, nil, false
	}
	current, err := application.SelectBrowserCandidate(candidates, browser, generation)
	if err != nil {
		h.fail(w, err)
		return application.BrowserCredential{}, nil, false
	}
	var selected *http.Cookie
	for _, cookie := range cookies {
		if cookie.Value == current.RefreshToken {
			if selected != nil {
				h.fail(w, application.ErrInvalidInput)
				return application.BrowserCredential{}, nil, false
			}
			selected = cookie
		}
	}
	if selected == nil {
		h.fail(w, application.ErrRefreshToken)
		return application.BrowserCredential{}, nil, false
	}
	return current, selected, true
}
func (h *BrowserV2Handler) Refresh(w http.ResponseWriter, r *http.Request) {
	var req browserSelectors
	if !h.request(w, r, &req) {
		return
	}
	current, cookie, ok := h.selectProof(w, r, req)
	if !ok {
		return
	}
	if h.sessions == nil {
		errorJSON(w, 500, "session unavailable")
		return
	}
	result, err := h.sessions.Refresh(r.Context(), application.RefreshBrowserSessionCommand{Current: current})
	if err != nil {
		h.fail(w, err)
		return
	}
	h.write(w, result, cookie)
}
func (h *BrowserV2Handler) Logout(w http.ResponseWriter, r *http.Request) {
	var req struct {
		BrowserID  string  `json:"browser_id"`
		Generation string  `json:"generation"`
		Receipt    *string `json:"receipt"`
	}
	if !h.request(w, r, &req) {
		return
	}
	if h.bearer == nil || h.sessions == nil {
		errorJSON(w, 500, "session unavailable")
		return
	}
	identity, authenticated := r.Context().Value(browserIdentityKey{}).(sharedauth.Identity)
	var err error
	if !authenticated {
		identity, err = h.bearer.AuthenticateBearer(r.Context(), r.Header.Get("Authorization"))
	}
	if err != nil || identity.UserID == uuid.Nil || identity.BrowserID == uuid.Nil || identity.BrowserGeneration == uuid.Nil {
		errorJSON(w, 401, "invalid access token")
		return
	}
	browser, e1 := uuid.Parse(req.BrowserID)
	generation, e2 := uuid.Parse(req.Generation)
	if e1 != nil || e2 != nil || browser == uuid.Nil || generation == uuid.Nil {
		errorJSON(w, 400, "invalid selectors")
		return
	}
	if identity.BrowserID != browser || identity.BrowserGeneration != generation {
		errorJSON(w, 401, "invalid access token")
		return
	}
	cmd := application.LogoutBrowserSessionCommand{Current: application.BrowserCredential{BrowserID: browser, Generation: generation}, UserID: identity.UserID, SessionVersion: identity.SessionVersion}
	if req.Receipt != nil {
		if sessions, ok := h.sessions.(browserReceiptLogout); ok {
			err = sessions.LogoutWithReceipt(r.Context(), cmd, *req.Receipt)
		} else {
			err = errors.New("session unavailable")
		}
	} else {
		err = h.sessions.Logout(r.Context(), cmd)
	}
	if err != nil {
		h.fail(w, err)
		return
	}
	if req.Receipt != nil {
		err = h.cleanupReceiptCookies(w, r, identity.UserID, browser, generation, *req.Receipt)
	} else {
		// Without a receipt the revoked hash cannot be compared after a rotation.
		for _, header := range r.Header.Values("Cookie") {
			if _, parseErr := http.ParseCookie(header); parseErr != nil {
				err = errors.New("cookie cleanup unconfirmed")
			}
		}
		cookies, parseErr := v2RefreshCandidateCookies(r)
		if parseErr != nil || len(cookies) != 0 {
			err = errors.New("cookie cleanup unconfirmed")
		}
	}
	if err != nil {
		h.fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
func (h *BrowserV2Handler) write(w http.ResponseWriter, result application.BrowserSessionResult, old *http.Cookie) {
	h.writeStatus(w, result, old, http.StatusOK)
}
func (h *BrowserV2Handler) writeStatus(w http.ResponseWriter, result application.BrowserSessionResult, old *http.Cookie, status int) {
	name := uniqueRefreshCookieName(result.Tokens.RefreshToken)
	if old != nil && old.Name != legacyRefreshCookie && old.Name != name {
		writeRefreshCookie(w, old.Name, "", -1)
	}
	writeRefreshCookie(w, name, result.Tokens.RefreshToken, 30*24*60*60)
	runtime.WriteJSON(w, status, struct {
		BrowserID   string `json:"browser_id"`
		Generation  string `json:"generation"`
		AccessToken string `json:"access_token"`
		TokenType   string `json:"token_type"`
		ExpiresIn   int64  `json:"expires_in"`
	}{result.BrowserID.String(), result.Generation.String(), result.Tokens.AccessToken, result.Tokens.TokenType, result.Tokens.ExpiresIn})
}
