package httptransport

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/google/uuid"

	"github.com/KovalMax/zwei/services/chat/internal/application"
	"github.com/KovalMax/zwei/services/chat/internal/domain/conversation"
	"github.com/KovalMax/zwei/services/chat/internal/persistence/postgres"
	"github.com/KovalMax/zwei/services/internal/runtime"
	sharedauth "github.com/KovalMax/zwei/services/shared/auth"
	"github.com/KovalMax/zwei/services/shared/messaging"
)

type Handler struct {
	sender        *messaging.Sender
	sessions      *sharedauth.SessionValidator
	conversations *postgres.Repository
	history       *postgres.HistoryRepository
	limiter       application.RequestLimiter
}

func NewHandler(sender *messaging.Sender, sessions *sharedauth.SessionValidator, conversations *postgres.Repository, history *postgres.HistoryRepository, limiter application.RequestLimiter) *Handler {
	return &Handler{sender: sender, sessions: sessions, conversations: conversations, history: history, limiter: limiter}
}

func (h *Handler) Register(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/chat/conversations", h.createConversation)
	mux.HandleFunc("GET /api/chat/conversations", h.listConversations)
	mux.HandleFunc("GET /api/chat/users/search", h.searchUsers)
	mux.HandleFunc("GET /api/chat/conversations/{id}", h.getConversation)
	mux.HandleFunc("POST /api/chat/conversations/{id}/messages", h.sendMessage)
	mux.HandleFunc("GET /api/chat/conversations/{id}/messages", h.historyMessages)
}

func (h *Handler) searchUsers(w http.ResponseWriter, r *http.Request) {
	userID, ok := h.userID(w, r)
	if !ok {
		return
	}
	if !h.allow(w, r, userID, application.RateBucketSearch) {
		return
	}
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if len(query) < 2 || len(query) > 100 {
		errorJSON(w, http.StatusBadRequest, "search query must be 2-100 characters")
		return
	}
	users, err := h.conversations.SearchUsers(r.Context(), userID, query)
	if err != nil {
		errorJSON(w, http.StatusInternalServerError, "could not search users")
		return
	}
	runtime.WriteJSON(w, http.StatusOK, users)
}

func (h *Handler) createConversation(w http.ResponseWriter, r *http.Request) {
	userID, ok := h.userID(w, r)
	if !ok {
		return
	}
	if !h.allow(w, r, userID, application.RateBucketConversationCreate) {
		return
	}
	var request struct {
		OtherUserID uuid.UUID `json:"other_user_id"`
	}
	if !decodeJSON(w, r, &request) || request.OtherUserID == uuid.Nil || request.OtherUserID == userID {
		errorJSON(w, http.StatusBadRequest, "invalid other_user_id")
		return
	}
	item, err := h.conversations.Create(r.Context(), userID, request.OtherUserID)
	if errors.Is(err, postgres.ErrNotFound) {
		errorJSON(w, http.StatusNotFound, "user not found")
		return
	}
	if err != nil {
		errorJSON(w, http.StatusInternalServerError, "could not create conversation")
		return
	}
	runtime.WriteJSON(w, http.StatusCreated, item)
}

func (h *Handler) listConversations(w http.ResponseWriter, r *http.Request) {
	userID, ok := h.userID(w, r)
	if !ok {
		return
	}
	if !h.allow(w, r, userID, application.RateBucketConversationList) {
		return
	}
	items, err := h.conversations.List(r.Context(), userID)
	if err != nil {
		errorJSON(w, http.StatusInternalServerError, "could not load conversations")
		return
	}
	runtime.WriteJSON(w, http.StatusOK, items)
}

func (h *Handler) getConversation(w http.ResponseWriter, r *http.Request) {
	userID, ok := h.userID(w, r)
	if !ok {
		return
	}
	if !h.allow(w, r, userID, application.RateBucketConversationGet) {
		return
	}
	conversationID, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		errorJSON(w, http.StatusBadRequest, "invalid conversation id")
		return
	}
	item, err := h.conversations.Get(r.Context(), userID, conversationID)
	if errors.Is(err, postgres.ErrNotFound) {
		errorJSON(w, http.StatusNotFound, "conversation not found")
		return
	}
	if err != nil {
		errorJSON(w, http.StatusInternalServerError, "could not load conversation")
		return
	}
	runtime.WriteJSON(w, http.StatusOK, item)
}

func (h *Handler) sendMessage(w http.ResponseWriter, r *http.Request) {
	userID, ok := h.userID(w, r)
	if !ok {
		return
	}
	if !h.allow(w, r, userID, application.RateBucketMessage) {
		return
	}
	conversationID, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		errorJSON(w, http.StatusBadRequest, "invalid conversation id")
		return
	}
	var request struct {
		ClientMessageID string `json:"client_message_id"`
		Body            string `json:"body"`
	}
	if !decodeJSON(w, r, &request) {
		errorJSON(w, http.StatusBadRequest, "invalid message")
		return
	}
	message, created, err := h.sender.Send(r.Context(), messaging.SendRequest{SenderID: userID, ConversationID: conversationID, ClientMessageID: request.ClientMessageID, Body: request.Body})
	if errors.Is(err, messaging.ErrConversationNotFound) {
		errorJSON(w, http.StatusNotFound, err.Error())
		return
	}
	if errors.Is(err, messaging.ErrInvalidMessage) {
		errorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	if err != nil {
		errorJSON(w, http.StatusInternalServerError, err.Error())
		return
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	runtime.WriteJSON(w, status, message)
}

func (h *Handler) historyMessages(w http.ResponseWriter, r *http.Request) {
	userID, ok := h.userID(w, r)
	if !ok {
		return
	}
	if !h.allow(w, r, userID, application.RateBucketHistory) {
		return
	}
	conversationID, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		errorJSON(w, http.StatusBadRequest, "invalid conversation id")
		return
	}
	limit, before := 20, int64(0)
	if value := r.URL.Query().Get("limit"); value != "" {
		if _, err := fmt.Sscanf(value, "%d", &limit); err != nil || limit < 1 || limit > 100 {
			errorJSON(w, http.StatusBadRequest, "invalid limit")
			return
		}
	}
	if value := r.URL.Query().Get("before"); value != "" {
		if _, err := fmt.Sscanf(value, "%d", &before); err != nil || before < 1 {
			errorJSON(w, http.StatusBadRequest, "invalid cursor")
			return
		}
	}
	messages, cursor, err := h.history.List(r.Context(), userID, conversationID, before, limit)
	if errors.Is(err, postgres.ErrNotFound) {
		errorJSON(w, http.StatusNotFound, "conversation not found")
		return
	}
	if err != nil {
		errorJSON(w, http.StatusInternalServerError, "could not load history")
		return
	}
	runtime.WriteJSON(w, http.StatusOK, struct {
		Messages   []conversation.Message `json:"messages"`
		NextCursor string                 `json:"next_cursor,omitempty"`
	}{Messages: messages, NextCursor: cursor})
}

func (h *Handler) userID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	identity, ok := h.identity(w, r)
	if !ok {
		return uuid.Nil, false
	}
	return identity.UserID, true
}

func (h *Handler) identity(w http.ResponseWriter, r *http.Request) (sharedauth.Identity, bool) {
	identity, err := h.sessions.AuthenticateBearer(r.Context(), r.Header.Get("Authorization"))
	if err != nil {
		errorJSON(w, http.StatusUnauthorized, "invalid access token")
		return sharedauth.Identity{}, false
	}
	return identity, true
}

func (h *Handler) allow(w http.ResponseWriter, r *http.Request, userID uuid.UUID, bucket string) bool {
	if h.limiter == nil {
		return true
	}
	allowed, err := h.limiter.Allow(r.Context(), userID, bucket)
	if err != nil {
		errorJSON(w, http.StatusServiceUnavailable, "request limiter unavailable")
		return false
	}
	if !allowed {
		w.Header().Set("Retry-After", "60")
		errorJSON(w, http.StatusTooManyRequests, "request rate limit exceeded")
		return false
	}
	return true
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
