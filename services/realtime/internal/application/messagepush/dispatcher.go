package messagepush

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
)

type Intent struct {
	ID, MessageID, ConversationID, SenderID, RecipientID uuid.UUID
	AttemptCount                                         int
	ExpiresAt                                            time.Time
	ClaimToken                                           uuid.UUID
}

type Subscription struct {
	ID                     uuid.UUID
	Endpoint, P256DH, Auth string
	Fingerprint            []byte
	TTL                    int
}

type Repository interface {
	Claim(context.Context, int) ([]Intent, error)
	PurgeProcessed(context.Context, int) error
	Resolve(context.Context, Intent) (string, []Subscription, bool, error)
	DeleteSubscription(context.Context, uuid.UUID, []byte) error
	Complete(context.Context, Intent) error
	Retry(context.Context, Intent) error
}

type Presence interface {
	Online(context.Context, []uuid.UUID) (map[uuid.UUID]bool, error)
}
type Sender interface {
	Send(context.Context, []byte, Subscription) (int, error)
}

// ProviderError is the bounded provider diagnostic contract shared by adapters.
// Code is meaningful only when it is one of the documented Apple values below.
type ProviderError struct{ Code string }

func (e *ProviderError) Error() string { return "push provider rejected request" }

func IsAppleProviderCode(code string) bool {
	switch code {
	case "BadAuthorizationHeader", "BadVapidPublicKey", "VapidPkHashMismatch", "BadJwtToken", "BadWebPushRequest", "BadWebPushTopic", "BadPath", "MethodNotAllowed", "PayloadTooLarge", "IdleTimeout":
		return true
	default:
		return false
	}
}

// DiagnosticError carries only bounded failure metadata suitable for logs.
// It deliberately does not retain the adapter or repository error.
type DiagnosticError struct {
	Reason       string
	HTTPStatus   int
	ProviderCode string
}

func (e *DiagnosticError) Error() string {
	if e.HTTPStatus >= 100 && e.HTTPStatus <= 599 {
		return e.Reason + ": " + strconv.Itoa(e.HTTPStatus)
	}
	return e.Reason
}

type Dispatcher struct {
	repository Repository
	presence   Presence
	sender     Sender
}

const messagePushWorkers = 4
const processedRetentionBatchSize = 100

type notificationPayload struct {
	Notification struct {
		Title string `json:"title"`
		Body  string `json:"body"`
		Tag   string `json:"tag"`
		Data  struct {
			Kind           string    `json:"kind"`
			ConversationID uuid.UUID `json:"conversation_id"`
			MessageID      uuid.UUID `json:"message_id"`
			OnActionClick  struct {
				Default struct {
					Operation string `json:"operation"`
					URL       string `json:"url"`
				} `json:"default"`
			} `json:"onActionClick"`
		} `json:"data"`
	} `json:"notification"`
}

func New(repository Repository, presence Presence, sender Sender) *Dispatcher {
	return &Dispatcher{repository: repository, presence: presence, sender: sender}
}

// Process claims a bounded batch and handles every recipient independently.
// Policy suppression is terminal; provider failures retry only that intent.
func (d *Dispatcher) Process(ctx context.Context, limit int) error {
	events, err := d.repository.Claim(ctx, limit)
	if err != nil {
		return err
	}
	var firstErr error
	if len(events) > 0 {
		workers := min(len(events), messagePushWorkers)
		work := make(chan Intent, len(events))
		for _, event := range events {
			work <- event
		}
		close(work)
		var errMu sync.Mutex
		var wg sync.WaitGroup
		wg.Add(workers)
		for range workers {
			go func() {
				defer wg.Done()
				for event := range work {
					if err := d.processOne(ctx, event); err != nil {
						errMu.Lock()
						if firstErr == nil {
							firstErr = err
						}
						errMu.Unlock()
					}
				}
			}()
		}
		wg.Wait()
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	purgeErr := d.repository.PurgeProcessed(ctx, processedRetentionBatchSize)
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if firstErr != nil {
		return firstErr
	}
	return purgeErr
}

func (d *Dispatcher) processOne(ctx context.Context, event Intent) error {
	_, subscriptions, eligible, err := d.repository.Resolve(ctx, event)
	if err != nil {
		return d.retryWithDiagnostic(ctx, event, &DiagnosticError{Reason: "resolve_failed"})
	}
	if !eligible {
		return d.repository.Complete(ctx, event)
	}
	if len(subscriptions) == 0 {
		return d.repository.Complete(ctx, event)
	}
	// Presence is account-scoped. Check it once before fan-out so a later
	// lookup failure cannot leave a partially sent multi-device notification.
	online, err := d.presence.Online(ctx, []uuid.UUID{event.RecipientID})
	if err != nil {
		return d.retryWithDiagnostic(ctx, event, &DiagnosticError{Reason: "presence_failed"})
	}
	if online[event.RecipientID] {
		return d.repository.Complete(ctx, event)
	}
	failed := false
	var diagnostic *DiagnosticError
	for _, initialSubscription := range subscriptions {
		if ctx.Err() != nil {
			return d.retry(ctx, event)
		}
		// Re-read policy and decrypt the currently-owned endpoint immediately
		// before each provider attempt; the initial list is only the work bound.
		name, currentSubscriptions, eligible, err := d.repository.Resolve(ctx, event)
		if err != nil {
			if ctx.Err() != nil {
				return d.retry(ctx, event)
			}
			failed = true
			if diagnostic == nil {
				diagnostic = &DiagnosticError{Reason: "resolve_failed"}
			}
			continue
		}
		if !eligible {
			return d.repository.Complete(ctx, event)
		}
		ttl := 24 * time.Hour
		if !event.ExpiresAt.IsZero() {
			ttl = time.Until(event.ExpiresAt)
		}
		if ttl <= 0 {
			return d.repository.Complete(ctx, event)
		}
		if ttl > 24*time.Hour {
			ttl = 24 * time.Hour
		}
		ttlSeconds := int(ttl.Seconds())
		if ttlSeconds < 1 {
			return d.repository.Complete(ctx, event)
		}
		subscription, found := findSubscription(currentSubscriptions, initialSubscription.ID)
		if !found {
			continue
		}
		subscription.TTL = ttlSeconds
		var envelope notificationPayload
		envelope.Notification.Title = normalizeDisplayName(name)
		envelope.Notification.Body = "New message"
		envelope.Notification.Tag = "message-" + event.MessageID.String()
		envelope.Notification.Data.Kind = "message"
		envelope.Notification.Data.ConversationID = event.ConversationID
		envelope.Notification.Data.MessageID = event.MessageID
		envelope.Notification.Data.OnActionClick.Default.Operation = "focusLastFocusedOrOpen"
		envelope.Notification.Data.OnActionClick.Default.URL = "/home"
		payload, err := json.Marshal(envelope)
		if err != nil {
			failed = true
			continue
		}
		status, sendErr := d.sender.Send(ctx, payload, subscription)
		if sendErr == nil && status >= 200 && status < 300 {
			continue
		}
		if sendErr == nil && (status == 404 || status == 410) {
			if err := d.repository.DeleteSubscription(ctx, subscription.ID, subscription.Fingerprint); err != nil {
				failed = true
			}
			continue
		}
		failed = true
		if diagnostic == nil {
			diagnostic = &DiagnosticError{Reason: "provider_failed"}
			if status >= 100 && status <= 599 {
				diagnostic.HTTPStatus = status
			}
			var providerError *ProviderError
			if errors.As(sendErr, &providerError) && IsAppleProviderCode(providerError.Code) {
				diagnostic.ProviderCode = providerError.Code
			}
		}
	}
	if failed {
		if diagnostic == nil {
			diagnostic = &DiagnosticError{Reason: "internal"}
		}
		return d.retryWithDiagnostic(ctx, event, diagnostic)
	}
	return d.repository.Complete(ctx, event)
}

func (d *Dispatcher) retry(ctx context.Context, event Intent) error {
	if ctx.Err() == nil {
		return d.repository.Retry(ctx, event)
	}
	retryCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
	defer cancel()
	return d.repository.Retry(retryCtx, event)
}

func (d *Dispatcher) retryWithDiagnostic(ctx context.Context, event Intent, diagnostic *DiagnosticError) error {
	if err := d.retry(ctx, event); err != nil {
		return err
	}
	return diagnostic
}

func findSubscription(subscriptions []Subscription, id uuid.UUID) (Subscription, bool) {
	for _, subscription := range subscriptions {
		if subscription.ID == id {
			return subscription, true
		}
	}
	return Subscription{}, false
}

func normalizeDisplayName(value string) string {
	value = strings.ToValidUTF8(value, "")
	var b strings.Builder
	for _, r := range value {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			continue
		}
		if !unicode.IsPrint(r) {
			continue
		}
		if b.Len()+utf8.RuneLen(r) > 160 {
			break
		}
		b.WriteRune(r)
	}
	result := strings.TrimSpace(b.String())
	if !utf8.ValidString(result) {
		return "Someone"
	}
	if result == "" {
		return "Someone"
	}
	return result
}
