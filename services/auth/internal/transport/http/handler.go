package httptransport

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/KovalMax/zwei/services/auth/internal/application"
	"github.com/KovalMax/zwei/services/internal/runtime"
	sharedauth "github.com/KovalMax/zwei/services/shared/auth"
)

type Handler struct {
	auth     *application.Service
	admins   *application.AdminService
	sessions *sharedauth.SessionValidator
	adminIPs *IPAllowlist
}

func NewHandler(auth *application.Service, admins *application.AdminService, sessions *sharedauth.SessionValidator, adminIPs *IPAllowlist) *Handler {
	return &Handler{auth: auth, admins: admins, sessions: sessions, adminIPs: adminIPs}
}
func (h *Handler) Register(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/auth/register", h.register)
	mux.HandleFunc("POST /api/auth/login", h.login)
	mux.HandleFunc("POST /api/auth/refresh", h.refresh)
	mux.HandleFunc("POST /api/auth/logout", h.logout)
	mux.HandleFunc("POST /api/auth/ws-ticket", h.websocketTicket)
	mux.HandleFunc("POST /api/auth/activate", h.activate)
	mux.HandleFunc("GET /api/auth/me", h.me)
	mux.HandleFunc("PATCH /api/auth/me", h.updateMe)
	mux.HandleFunc("GET /api/admin/users", h.adminUsers)
	mux.HandleFunc("GET /api/admin/me", h.adminMe)
	mux.HandleFunc("POST /api/admin/users/{id}/activate", h.activateUser)
	mux.HandleFunc("POST /api/admin/users/{id}/block", h.blockUser)
	mux.HandleFunc("GET /api/admin/invitations", h.adminInvitations)
	mux.HandleFunc("POST /api/admin/invitations", h.createInvitation)
	mux.HandleFunc("POST /api/admin/invitations/{id}/revoke", h.revokeInvitation)
}

type credentialsRequest struct {
	Email          string `json:"email"`
	Password       string `json:"password"`
	DisplayName    string `json:"display_name"`
	DeviceID       string `json:"device_id"`
	DeviceName     string `json:"device_name"`
	InvitationCode string `json:"invitation_code"`
}
type profileUpdateRequest struct {
	DisplayName     *string `json:"display_name"`
	RetentionPeriod *string `json:"retention_period"`
}

func (h *Handler) register(w http.ResponseWriter, r *http.Request) {
	var request credentialsRequest
	if !decodeJSON(w, r, &request) {
		errorJSON(w, http.StatusBadRequest, "invalid registration request")
		return
	}
	result, err := h.auth.Register(r.Context(), application.Credentials{Email: request.Email, Password: request.Password, DisplayName: request.DisplayName, DeviceID: request.DeviceID, DeviceName: request.DeviceName, InvitationCode: request.InvitationCode})
	if errors.Is(err, application.ErrInvalidInput) {
		errorJSON(w, http.StatusBadRequest, "invalid registration request")
		return
	}
	if uniqueViolation(err) {
		errorJSON(w, http.StatusConflict, "email already registered")
		return
	}
	if errors.Is(err, application.ErrInvitationInvalid) {
		errorJSON(w, http.StatusBadRequest, "invalid invitation code")
		return
	}
	if err != nil {
		errorJSON(w, http.StatusInternalServerError, "could not create user")
		return
	}
	if result.Pending {
		runtime.WriteJSON(w, http.StatusAccepted, map[string]string{"status": "pending"})
		return
	}
	h.writeTokens(w, http.StatusCreated, result.Tokens)
}
func (h *Handler) login(w http.ResponseWriter, r *http.Request) {
	if !h.authHostAllowed(w, r) {
		return
	}
	var request credentialsRequest
	if !decodeJSON(w, r, &request) {
		errorJSON(w, http.StatusBadRequest, "invalid login request")
		return
	}
	tokens, err := h.auth.Login(r.Context(), application.Credentials{Email: request.Email, Password: request.Password, DeviceID: request.DeviceID, DeviceName: request.DeviceName})
	if errors.Is(err, application.ErrInvalidInput) {
		errorJSON(w, http.StatusBadRequest, "invalid login request")
		return
	}
	if errors.Is(err, application.ErrCredentials) {
		errorJSON(w, http.StatusUnauthorized, "invalid credentials")
		return
	}
	if errors.Is(err, application.ErrAccountInactive) {
		errorJSON(w, http.StatusForbidden, "account is not active")
		return
	}
	if err != nil {
		errorJSON(w, http.StatusInternalServerError, "could not create session")
		return
	}
	h.writeTokens(w, http.StatusOK, tokens)
}
func (h *Handler) refresh(w http.ResponseWriter, r *http.Request) {
	if !h.authHostAllowed(w, r) {
		return
	}
	refreshToken := refreshTokenFromCookie(r)
	if refreshToken == "" {
		errorJSON(w, http.StatusUnauthorized, "invalid refresh token")
		return
	}
	tokens, err := h.auth.Refresh(r.Context(), refreshToken)
	if errors.Is(err, application.ErrInvalidInput) {
		errorJSON(w, http.StatusBadRequest, "invalid refresh request")
		return
	}
	if errors.Is(err, application.ErrRefreshToken) {
		errorJSON(w, http.StatusUnauthorized, "invalid refresh token")
		return
	}
	if err != nil {
		errorJSON(w, http.StatusInternalServerError, "could not rotate refresh token")
		return
	}
	h.writeTokens(w, http.StatusOK, tokens)
}
func (h *Handler) logout(w http.ResponseWriter, r *http.Request) {
	if !h.authHostAllowed(w, r) {
		return
	}
	userID, ok := h.userID(w, r)
	if !ok {
		return
	}
	if err := h.auth.Logout(r.Context(), userID); err != nil {
		errorJSON(w, http.StatusInternalServerError, "could not revoke sessions")
		return
	}
	clearRefreshCookie(w)
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) writeTokens(w http.ResponseWriter, status int, tokens application.Tokens) {
	setRefreshCookie(w, tokens.RefreshToken)
	tokens.RefreshToken = ""
	runtime.WriteJSON(w, status, tokens)
}

func refreshTokenFromCookie(r *http.Request) string {
	cookie, err := r.Cookie("zwei_refresh")
	if err != nil {
		return ""
	}
	return cookie.Value
}

func setRefreshCookie(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{Name: "zwei_refresh", Value: token, Path: "/api/auth", HttpOnly: true, Secure: true, SameSite: http.SameSiteNoneMode, MaxAge: 30 * 24 * 60 * 60})
}

func clearRefreshCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{Name: "zwei_refresh", Value: "", Path: "/api/auth", HttpOnly: true, Secure: true, SameSite: http.SameSiteNoneMode, MaxAge: -1})
}
func (h *Handler) websocketTicket(w http.ResponseWriter, r *http.Request) {
	identity, err := h.sessions.AuthenticateBearer(r.Context(), r.Header.Get("Authorization"))
	if err != nil || identity.DeviceID == "" {
		errorJSON(w, http.StatusUnauthorized, "session revoked")
		return
	}
	ticket, err := h.auth.WebSocketTicket(identity)
	if err != nil {
		errorJSON(w, http.StatusInternalServerError, "could not create websocket ticket")
		return
	}
	runtime.WriteJSON(w, http.StatusOK, map[string]string{"ticket": ticket})
}

func (h *Handler) activate(w http.ResponseWriter, r *http.Request) {
	if h.admins == nil || r.URL.Query().Get("token") == "" {
		errorJSON(w, http.StatusBadRequest, "invalid activation link")
		return
	}
	if err := h.admins.VerifyActivation(r.Context(), r.URL.Query().Get("token")); err != nil {
		errorJSON(w, http.StatusBadRequest, "invalid or expired activation link")
		return
	}
	runtime.WriteJSON(w, http.StatusOK, map[string]string{"status": "activated"})
}
func (h *Handler) me(w http.ResponseWriter, r *http.Request) {
	if !h.authHostAllowed(w, r) {
		return
	}
	userID, ok := h.userID(w, r)
	if !ok {
		return
	}
	profile, err := h.auth.Profile(r.Context(), userID)
	if err != nil {
		errorJSON(w, http.StatusInternalServerError, "could not load profile")
		return
	}
	runtime.WriteJSON(w, http.StatusOK, profile)
}
func (h *Handler) updateMe(w http.ResponseWriter, r *http.Request) {
	if !h.authHostAllowed(w, r) {
		return
	}
	userID, ok := h.userID(w, r)
	if !ok {
		return
	}
	var request profileUpdateRequest
	if !decodeJSON(w, r, &request) {
		errorJSON(w, http.StatusBadRequest, "profile update is empty")
		return
	}
	profile, err := h.auth.UpdateProfile(r.Context(), userID, request.DisplayName, request.RetentionPeriod)
	if errors.Is(err, application.ErrInvalidInput) {
		errorJSON(w, http.StatusBadRequest, "invalid profile update")
		return
	}
	if err != nil {
		errorJSON(w, http.StatusInternalServerError, "could not update profile")
		return
	}
	runtime.WriteJSON(w, http.StatusOK, profile)
}
func (h *Handler) userID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	identity, err := h.sessions.AuthenticateBearer(r.Context(), r.Header.Get("Authorization"))
	if err != nil {
		errorJSON(w, http.StatusUnauthorized, "invalid access token")
		return uuid.Nil, false
	}
	return identity.UserID, true
}

func (h *Handler) adminID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	if h.admins == nil || h.adminIPs == nil || !h.adminIPs.Allow(r) {
		errorJSON(w, http.StatusForbidden, "admin access denied")
		return uuid.Nil, false
	}
	identity, err := h.sessions.AuthenticateBearer(r.Context(), r.Header.Get("Authorization"))
	if err != nil {
		errorJSON(w, http.StatusUnauthorized, "invalid access token")
		return uuid.Nil, false
	}
	isAdmin, err := h.admins.IsAdmin(r.Context(), identity.UserID)
	if err != nil || !isAdmin {
		errorJSON(w, http.StatusForbidden, "admin access denied")
		return uuid.Nil, false
	}
	return identity.UserID, true
}

func (h *Handler) authHostAllowed(w http.ResponseWriter, r *http.Request) bool {
	host := strings.Split(r.Host, ":")[0]
	if host != "kyc.localhost" && host != "kyc.chat.false.tel" {
		return true
	}
	if h.adminIPs != nil && h.adminIPs.Allow(r) {
		return true
	}
	errorJSON(w, http.StatusForbidden, "admin access denied")
	return false
}

func (h *Handler) adminUsers(w http.ResponseWriter, r *http.Request) {
	adminID, ok := h.adminID(w, r)
	if !ok {
		return
	}
	users, err := h.admins.ListUsers(r.Context(), adminID)
	if err != nil {
		errorJSON(w, http.StatusInternalServerError, "could not list users")
		return
	}
	runtime.WriteJSON(w, http.StatusOK, users)
}

func (h *Handler) adminMe(w http.ResponseWriter, r *http.Request) {
	adminID, ok := h.adminID(w, r)
	if !ok {
		return
	}
	runtime.WriteJSON(w, http.StatusOK, map[string]any{"id": adminID, "admin": true})
}

func (h *Handler) activateUser(w http.ResponseWriter, r *http.Request) {
	adminID, ok := h.adminID(w, r)
	if !ok {
		return
	}
	targetID, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		errorJSON(w, http.StatusBadRequest, "invalid user id")
		return
	}
	if err := h.admins.ActivateUser(r.Context(), adminID, targetID); err != nil {
		h.adminError(w, err, "could not activate user")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) blockUser(w http.ResponseWriter, r *http.Request) {
	adminID, ok := h.adminID(w, r)
	if !ok {
		return
	}
	targetID, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		errorJSON(w, http.StatusBadRequest, "invalid user id")
		return
	}
	if err := h.admins.BlockUser(r.Context(), adminID, targetID); err != nil {
		h.adminError(w, err, "could not block user")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type invitationRequest struct {
	Email string `json:"email"`
}

func (h *Handler) adminInvitations(w http.ResponseWriter, r *http.Request) {
	adminID, ok := h.adminID(w, r)
	if !ok {
		return
	}
	invitations, err := h.admins.ListInvitations(r.Context(), adminID)
	if err != nil {
		errorJSON(w, http.StatusInternalServerError, "could not list invitations")
		return
	}
	runtime.WriteJSON(w, http.StatusOK, invitations)
}

func (h *Handler) createInvitation(w http.ResponseWriter, r *http.Request) {
	adminID, ok := h.adminID(w, r)
	if !ok {
		return
	}
	var request invitationRequest
	if !decodeJSON(w, r, &request) {
		errorJSON(w, http.StatusBadRequest, "invalid invitation request")
		return
	}
	code, invitation, err := h.admins.CreateInvitation(r.Context(), adminID, request.Email)
	if errors.Is(err, application.ErrInvalidInput) {
		errorJSON(w, http.StatusBadRequest, "invalid invitation request")
		return
	}
	if err != nil {
		errorJSON(w, http.StatusInternalServerError, "could not create invitation")
		return
	}
	runtime.WriteJSON(w, http.StatusCreated, map[string]any{"invitation": invitation, "code": code})
}

func (h *Handler) revokeInvitation(w http.ResponseWriter, r *http.Request) {
	adminID, ok := h.adminID(w, r)
	if !ok {
		return
	}
	invitationID, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		errorJSON(w, http.StatusBadRequest, "invalid invitation id")
		return
	}
	if err := h.admins.RevokeInvitation(r.Context(), adminID, invitationID); err != nil {
		h.adminError(w, err, "could not revoke invitation")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) adminError(w http.ResponseWriter, err error, fallback string) {
	if errors.Is(err, application.ErrNotAdmin) || errors.Is(err, application.ErrAdminTarget) {
		errorJSON(w, http.StatusForbidden, "admin access denied")
		return
	}
	if errors.Is(err, pgx.ErrNoRows) {
		errorJSON(w, http.StatusNotFound, "not found")
		return
	}
	errorJSON(w, http.StatusInternalServerError, fallback)
}
func decodeJSON(w http.ResponseWriter, r *http.Request, value any) bool {
	defer r.Body.Close()
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10))
	decoder.DisallowUnknownFields()
	return decoder.Decode(value) == nil
}
func errorJSON(w http.ResponseWriter, status int, message string) {
	runtime.WriteJSON(w, status, map[string]string{"error": message})
}
func uniqueViolation(err error) bool {
	return err != nil && strings.Contains(err.Error(), "duplicate key value violates unique constraint")
}
