package httptransport

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
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
	history       historyStore
	groups        *application.Groups
	limiter       application.RequestLimiter
}

type historyStore interface {
	List(context.Context, uuid.UUID, uuid.UUID, int64, int) ([]conversation.Message, string, error)
}

func NewHandler(sender *messaging.Sender, sessions *sharedauth.SessionValidator, conversations *postgres.Repository, history historyStore, groups *application.Groups, limiter application.RequestLimiter) *Handler {
	return &Handler{sender: sender, sessions: sessions, conversations: conversations, history: history, groups: groups, limiter: limiter}
}

func (h *Handler) Register(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/chat/conversations", h.createConversation)
	mux.HandleFunc("GET /api/chat/conversations", h.listConversations)
	mux.HandleFunc("GET /api/chat/users/search", h.searchUsers)
	mux.HandleFunc("GET /api/chat/conversations/{id}", h.getConversation)
	mux.HandleFunc("POST /api/chat/conversations/{id}/messages", h.sendMessage)
	mux.HandleFunc("GET /api/chat/conversations/{id}/messages", h.historyMessages)
	mux.HandleFunc("POST /api/chat/groups", h.createGroup)
	mux.HandleFunc("GET /api/chat/groups", h.listGroups)
	mux.HandleFunc("GET /api/chat/groups/{id}", h.getGroup)
	mux.HandleFunc("PATCH /api/chat/groups/{id}", h.renameGroup)
	mux.HandleFunc("POST /api/chat/groups/{id}/members", h.addGroupMember)
	mux.HandleFunc("DELETE /api/chat/groups/{id}/members/{userID}", h.removeGroupMember)
	mux.HandleFunc("PATCH /api/chat/groups/{id}/members/{userID}", h.changeGroupRole)
	mux.HandleFunc("POST /api/chat/groups/{id}/ownership", h.transferGroupOwnership)
	mux.HandleFunc("POST /api/chat/groups/{id}/leave", h.leaveGroup)
	mux.HandleFunc("DELETE /api/chat/groups/{id}", h.deleteGroup)
}

func (h *Handler) listGroups(w http.ResponseWriter, r *http.Request) {
	userID, ok := h.userID(w, r)
	if !ok {
		return
	}
	limit, cursor, err := parseGroupPageQuery(r.URL.RawQuery)
	if err != nil {
		errorJSON(w, http.StatusBadRequest, "invalid group page")
		return
	}
	if !h.allow(w, r, userID, application.RateBucketGroupList) {
		return
	}
	page, err := h.groups.ListPage(r.Context(), userID, limit, cursor)
	if err != nil {
		if errors.Is(err, application.ErrInvalidGroupPage) {
			errorJSON(w, http.StatusBadRequest, "invalid group page")
			return
		}
		errorJSON(w, http.StatusInternalServerError, "could not list groups")
		return
	}
	var nextCursor *string
	if page.NextCursor != nil {
		encoded, err := encodeGroupCursor(*page.NextCursor)
		if err != nil {
			errorJSON(w, http.StatusInternalServerError, "could not list groups")
			return
		}
		nextCursor = &encoded
	}
	if page.Items == nil {
		page.Items = make([]conversation.Group, 0)
	}
	runtime.WriteJSON(w, http.StatusOK, struct {
		Items      []conversation.Group `json:"items"`
		NextCursor *string              `json:"next_cursor"`
	}{Items: page.Items, NextCursor: nextCursor})
}

func (h *Handler) createGroup(w http.ResponseWriter, r *http.Request) {
	userID, ok := h.userID(w, r)
	if !ok {
		return
	}
	if !h.allow(w, r, userID, application.RateBucketConversationCreate) {
		return
	}
	var request struct {
		Name      string      `json:"name"`
		MemberIDs []uuid.UUID `json:"member_ids"`
	}
	if !decodeJSON(w, r, &request) {
		errorJSON(w, http.StatusBadRequest, "invalid group")
		return
	}
	group, err := h.groups.Create(r.Context(), userID, request.Name, request.MemberIDs)
	if !h.groupResult(w, err) {
		return
	}
	runtime.WriteJSON(w, http.StatusCreated, group)
}

func (h *Handler) getGroup(w http.ResponseWriter, r *http.Request) {
	userID, ok := h.userID(w, r)
	if !ok {
		return
	}
	if !h.allow(w, r, userID, application.RateBucketGroupGet) {
		return
	}
	groupID, ok := h.groupID(w, r)
	if !ok {
		return
	}
	group, err := h.groups.Get(r.Context(), userID, groupID)
	if !h.groupResult(w, err) {
		return
	}
	runtime.WriteJSON(w, http.StatusOK, group)
}

func (h *Handler) renameGroup(w http.ResponseWriter, r *http.Request) {
	userID, ok := h.userID(w, r)
	if !ok {
		return
	}
	if !h.allowGroupMutation(w, r, userID) {
		return
	}
	groupID, ok := h.groupID(w, r)
	if !ok {
		return
	}
	var request struct {
		Name string `json:"name"`
	}
	if !decodeJSON(w, r, &request) {
		errorJSON(w, http.StatusBadRequest, "invalid group name")
		return
	}
	group, err := h.groups.Rename(r.Context(), userID, groupID, request.Name)
	if !h.groupResult(w, err) {
		return
	}
	runtime.WriteJSON(w, http.StatusOK, group)
}

func (h *Handler) addGroupMember(w http.ResponseWriter, r *http.Request) {
	userID, ok := h.userID(w, r)
	if !ok {
		return
	}
	if !h.allowGroupMutation(w, r, userID) {
		return
	}
	groupID, ok := h.groupID(w, r)
	if !ok {
		return
	}
	var request struct {
		UserID uuid.UUID `json:"user_id"`
	}
	if !decodeJSON(w, r, &request) {
		errorJSON(w, http.StatusBadRequest, "invalid user_id")
		return
	}
	group, err := h.groups.AddMember(r.Context(), userID, groupID, request.UserID)
	if !h.groupResult(w, err) {
		return
	}
	runtime.WriteJSON(w, http.StatusOK, group)
}

func (h *Handler) removeGroupMember(w http.ResponseWriter, r *http.Request) {
	h.memberAction(w, r, false)
}

func (h *Handler) memberAction(w http.ResponseWriter, r *http.Request, role bool) {
	userID, ok := h.userID(w, r)
	if !ok {
		return
	}
	if !h.allowGroupMutation(w, r, userID) {
		return
	}
	groupID, ok := h.groupID(w, r)
	if !ok {
		return
	}
	memberID, err := uuid.Parse(r.PathValue("userID"))
	if err != nil {
		errorJSON(w, http.StatusBadRequest, "invalid user id")
		return
	}
	if role {
		var request struct {
			Role conversation.Role `json:"role"`
		}
		if !decodeJSON(w, r, &request) {
			errorJSON(w, http.StatusBadRequest, "invalid role")
			return
		}
		group, err := h.groups.ChangeRole(r.Context(), userID, groupID, memberID, request.Role)
		if !h.groupResult(w, err) {
			return
		}
		runtime.WriteJSON(w, http.StatusOK, group)
		return
	}
	group, err := h.groups.RemoveMember(r.Context(), userID, groupID, memberID)
	if !h.groupResult(w, err) {
		return
	}
	runtime.WriteJSON(w, http.StatusOK, group)
}

func (h *Handler) changeGroupRole(w http.ResponseWriter, r *http.Request) { h.memberAction(w, r, true) }

func (h *Handler) transferGroupOwnership(w http.ResponseWriter, r *http.Request) {
	userID, ok := h.userID(w, r)
	if !ok {
		return
	}
	if !h.allowGroupMutation(w, r, userID) {
		return
	}
	groupID, ok := h.groupID(w, r)
	if !ok {
		return
	}
	var request struct {
		UserID uuid.UUID `json:"user_id"`
	}
	if !decodeJSON(w, r, &request) {
		errorJSON(w, http.StatusBadRequest, "invalid user_id")
		return
	}
	group, err := h.groups.TransferOwnership(r.Context(), userID, groupID, request.UserID)
	if !h.groupResult(w, err) {
		return
	}
	runtime.WriteJSON(w, http.StatusOK, group)
}

func (h *Handler) leaveGroup(w http.ResponseWriter, r *http.Request) {
	userID, ok := h.userID(w, r)
	if !ok {
		return
	}
	if !h.allowGroupMutation(w, r, userID) {
		return
	}
	groupID, ok := h.groupID(w, r)
	if !ok {
		return
	}
	if !h.groupResult(w, h.groups.Leave(r.Context(), userID, groupID)) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
func (h *Handler) deleteGroup(w http.ResponseWriter, r *http.Request) {
	userID, ok := h.userID(w, r)
	if !ok {
		return
	}
	if !h.allowGroupMutation(w, r, userID) {
		return
	}
	groupID, ok := h.groupID(w, r)
	if !ok {
		return
	}
	if !h.groupResult(w, h.groups.Delete(r.Context(), userID, groupID)) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) groupID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		errorJSON(w, http.StatusBadRequest, "invalid group id")
		return uuid.Nil, false
	}
	return id, true
}

func (h *Handler) groupResult(w http.ResponseWriter, err error) bool {
	if err == nil {
		return true
	}
	switch {
	case errors.Is(err, application.ErrNotFound):
		errorJSON(w, http.StatusNotFound, "group or user not found")
	case errors.Is(err, application.ErrForbidden):
		errorJSON(w, http.StatusForbidden, "group action is not allowed")
	case errors.Is(err, application.ErrSelfOwnershipTransfer):
		errorJSON(w, http.StatusBadRequest, "cannot transfer group ownership to yourself")
	case errors.Is(err, application.ErrMemberExists), errors.Is(err, application.ErrGroupFull), errors.Is(err, conversation.ErrInvalidGroupName), errors.Is(err, conversation.ErrInvalidMembers), errors.Is(err, conversation.ErrInvalidRole):
		errorJSON(w, http.StatusBadRequest, err.Error())
	default:
		errorJSON(w, http.StatusInternalServerError, "could not change group")
	}
	return false
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
	if errors.Is(err, messaging.ErrClientMessageIDConflict) {
		errorJSON(w, http.StatusConflict, "client message id conflict")
		return
	}
	if errors.Is(err, messaging.ErrMessageExpired) {
		errorJSON(w, http.StatusGone, "message expired")
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
	limit, before, err := parseHistoryPageQuery(r.URL.RawQuery)
	if err != nil {
		if errors.Is(err, errInvalidHistoryCursor) {
			errorJSON(w, http.StatusBadRequest, "invalid cursor")
		} else {
			errorJSON(w, http.StatusBadRequest, "invalid limit")
		}
		return
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

var errInvalidHistoryCursor = errors.New("invalid history cursor")
var errInvalidHistoryLimit = errors.New("invalid history limit")

func parseHistoryPageQuery(rawQuery string) (int, int64, error) {
	values, err := url.ParseQuery(rawQuery)
	if err != nil {
		return 0, 0, errInvalidHistoryLimit
	}
	for key, entries := range values {
		if key != "limit" && key != "before" {
			return 0, 0, errInvalidHistoryLimit
		}
		if len(entries) != 1 || entries[0] == "" {
			if key == "before" {
				return 0, 0, errInvalidHistoryCursor
			}
			return 0, 0, errInvalidHistoryLimit
		}
	}

	limit := 20
	if entries, ok := values["limit"]; ok {
		value := entries[0]
		if !isDecimal(value) {
			return 0, 0, errInvalidHistoryLimit
		}
		parsed, err := strconv.ParseInt(value, 10, 32)
		if err != nil || parsed < 1 || parsed > 100 {
			return 0, 0, errInvalidHistoryLimit
		}
		limit = int(parsed)
	}

	var before int64
	if entries, ok := values["before"]; ok {
		value := entries[0]
		if !isDecimal(value) {
			return 0, 0, errInvalidHistoryCursor
		}
		before, err = strconv.ParseInt(value, 10, 64)
		if err != nil || before < 1 {
			return 0, 0, errInvalidHistoryCursor
		}
	}
	return limit, before, nil
}

func isDecimal(value string) bool {
	if value == "" {
		return false
	}
	for _, digit := range value {
		if digit < '0' || digit > '9' {
			return false
		}
	}
	return true
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
		errorJSON(w, http.StatusServiceUnavailable, "request limiter unavailable")
		return false
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

func (h *Handler) allowGroupMutation(w http.ResponseWriter, r *http.Request, userID uuid.UUID) bool {
	return h.allow(w, r, userID, application.RateBucketGroupMutation)
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
