package httptransport

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"

	"github.com/maxkoval/p2p-webchat/services/auth/internal/application"
	"github.com/maxkoval/p2p-webchat/services/internal/runtime"
	sharedauth "github.com/maxkoval/p2p-webchat/services/shared/auth"
)

type Handler struct {
	auth     *application.Service
	sessions *sharedauth.SessionValidator
}

func NewHandler(auth *application.Service, sessions *sharedauth.SessionValidator) *Handler {
	return &Handler{auth: auth, sessions: sessions}
}
func (h *Handler) Register(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/auth/register", h.register)
	mux.HandleFunc("POST /api/auth/login", h.login)
	mux.HandleFunc("POST /api/auth/refresh", h.refresh)
	mux.HandleFunc("POST /api/auth/logout", h.logout)
	mux.HandleFunc("POST /api/auth/ws-ticket", h.websocketTicket)
	mux.HandleFunc("GET /api/auth/me", h.me)
	mux.HandleFunc("PATCH /api/auth/me", h.updateMe)
}

type credentialsRequest struct {
	Email       string `json:"email"`
	Password    string `json:"password"`
	DisplayName string `json:"display_name"`
	DeviceID    string `json:"device_id"`
	DeviceName  string `json:"device_name"`
}
type refreshRequest struct {
	RefreshToken string `json:"refresh_token"`
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
	tokens, err := h.auth.Register(r.Context(), application.Credentials{Email: request.Email, Password: request.Password, DisplayName: request.DisplayName, DeviceID: request.DeviceID, DeviceName: request.DeviceName})
	if errors.Is(err, application.ErrInvalidInput) {
		errorJSON(w, http.StatusBadRequest, "invalid registration request")
		return
	}
	if uniqueViolation(err) {
		errorJSON(w, http.StatusConflict, "email already registered")
		return
	}
	if err != nil {
		errorJSON(w, http.StatusInternalServerError, "could not create user")
		return
	}
	runtime.WriteJSON(w, http.StatusCreated, tokens)
}
func (h *Handler) login(w http.ResponseWriter, r *http.Request) {
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
	if err != nil {
		errorJSON(w, http.StatusInternalServerError, "could not create session")
		return
	}
	runtime.WriteJSON(w, http.StatusOK, tokens)
}
func (h *Handler) refresh(w http.ResponseWriter, r *http.Request) {
	var request refreshRequest
	if !decodeJSON(w, r, &request) {
		errorJSON(w, http.StatusBadRequest, "invalid refresh request")
		return
	}
	tokens, err := h.auth.Refresh(r.Context(), request.RefreshToken)
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
	runtime.WriteJSON(w, http.StatusOK, tokens)
}
func (h *Handler) logout(w http.ResponseWriter, r *http.Request) {
	userID, ok := h.userID(w, r)
	if !ok {
		return
	}
	if err := h.auth.Logout(r.Context(), userID); err != nil {
		errorJSON(w, http.StatusInternalServerError, "could not revoke sessions")
		return
	}
	w.WriteHeader(http.StatusNoContent)
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
func (h *Handler) me(w http.ResponseWriter, r *http.Request) {
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
