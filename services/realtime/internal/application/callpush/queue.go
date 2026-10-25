package callpush

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/KovalMax/zwei/services/realtime/internal/application/messagepush"
)

type Job struct {
	CallID, ConversationID, StarterID uuid.UUID
	Group                             bool
	Recipients                        []uuid.UUID
	ExpiresAt                         time.Time
}

type Repository interface {
	Resolve(context.Context, Job, uuid.UUID) (string, []messagepush.Subscription, bool, error)
	DeleteSubscription(context.Context, uuid.UUID, []byte) error
}
type Presence interface {
	Online(context.Context, []uuid.UUID) (map[uuid.UUID]bool, error)
}
type Sender interface {
	Send(context.Context, []byte, messagepush.Subscription) (int, error)
}

// Enqueuer is deliberately nonblocking; calls never depend on push capacity.
type Enqueuer interface{ Enqueue(Job) bool }

type Queue struct {
	jobs       chan Job
	repository Repository
	presence   Presence
	sender     Sender
	now        func() time.Time
	sleep      func(context.Context, time.Duration) bool
}

const (
	maxCallPushAttempts      = 5
	callPushRecipientWorkers = 4
	callPushJobWorkers       = 4
	callPushOverallWorkers   = callPushRecipientWorkers * callPushJobWorkers
	callPushInitialBackoff   = 250 * time.Millisecond
	callPushMaxBackoff       = 2 * time.Second
)

func New(repository Repository, presence Presence, sender Sender, capacity int) *Queue {
	if capacity < 1 {
		capacity = 1
	}
	q := &Queue{jobs: make(chan Job, capacity), repository: repository, presence: presence, sender: sender, now: time.Now}
	q.sleep = q.sleepContext
	return q
}

func (q *Queue) Enqueue(job Job) bool {
	if q == nil || job.CallID == uuid.Nil || !job.ExpiresAt.After(q.now()) {
		return false
	}
	job.Recipients = append([]uuid.UUID(nil), job.Recipients...)
	select {
	case q.jobs <- job:
		return true
	default:
		return false
	}
}

// Run owns a fixed number of job consumers; each job retains its bounded
// recipient pool, so total recipient work is bounded by callPushOverallWorkers.
func (q *Queue) Run(ctx context.Context) {
	workers := callPushJobWorkers
	var wg sync.WaitGroup
	wg.Add(workers)
	for range workers {
		go func() {
			defer wg.Done()
			for {
				select {
				case <-ctx.Done():
					return
				case job := <-q.jobs:
					q.process(ctx, job)
				}
			}
		}()
	}
	<-ctx.Done()
	wg.Wait()
}

func (q *Queue) process(ctx context.Context, job Job) {
	workerCount := min(len(job.Recipients), callPushRecipientWorkers)
	if workerCount == 0 {
		return
	}
	var nextRecipient int
	var mu sync.Mutex
	var workers sync.WaitGroup
	workers.Add(workerCount)
	for range workerCount {
		go func() {
			defer workers.Done()
			for ctx.Err() == nil {
				mu.Lock()
				if nextRecipient >= len(job.Recipients) {
					mu.Unlock()
					return
				}
				recipient := job.Recipients[nextRecipient]
				nextRecipient++
				mu.Unlock()
				if recipient != job.StarterID {
					q.processRecipient(ctx, job, recipient)
				}
			}
		}()
	}
	workers.Wait()
}

type subscriptionOutcome uint8

const (
	subscriptionPending subscriptionOutcome = iota
	subscriptionAccepted
	subscriptionDeleted
	subscriptionExhausted
)

func (q *Queue) processRecipient(ctx context.Context, job Job, recipient uuid.UUID) {
	outcomes := make(map[uuid.UUID]subscriptionOutcome)
	attempts := make(map[uuid.UUID]int)
	nextAttempt := make(map[uuid.UUID]time.Time)
	stateFailures := 0
	for q.now().Before(job.ExpiresAt) && ctx.Err() == nil {
		stateCtx, stateCancel := context.WithDeadline(ctx, job.ExpiresAt)
		_, subscriptions, eligible, err := q.repository.Resolve(stateCtx, job, recipient)
		stateCancel()
		if err != nil {
			stateFailures++
			if stateFailures >= maxCallPushAttempts || !q.wait(ctx, job.ExpiresAt, retryBackoff(stateFailures)) {
				return
			}
			continue
		}
		if !eligible {
			return
		}
		stateCtx, stateCancel = context.WithDeadline(ctx, job.ExpiresAt)
		presence, err := q.presence.Online(stateCtx, []uuid.UUID{recipient})
		stateCancel()
		if err != nil {
			stateFailures++
			if stateFailures >= maxCallPushAttempts || !q.wait(ctx, job.ExpiresAt, retryBackoff(stateFailures)) {
				return
			}
			continue
		}
		if presence[recipient] {
			return
		}
		stateFailures = 0
		currentIDs := make(map[uuid.UUID]struct{}, len(subscriptions))
		for _, subscription := range subscriptions {
			currentIDs[subscription.ID] = struct{}{}
			if _, exists := outcomes[subscription.ID]; !exists {
				outcomes[subscription.ID] = subscriptionPending
			}
		}
		for id, outcome := range outcomes {
			if outcome == subscriptionPending {
				if _, exists := currentIDs[id]; !exists {
					outcomes[id] = subscriptionDeleted
				}
			}
		}
		pending := false
		for _, subscription := range subscriptions {
			if outcomes[subscription.ID] != subscriptionPending {
				continue
			}
			pending = true
			if q.now().Before(nextAttempt[subscription.ID]) {
				continue
			}
			// Resolve status, membership, account mode, and VAPID-key subscriptions
			// immediately before every provider request.
			stateCtx, stateCancel = context.WithDeadline(ctx, job.ExpiresAt)
			currentName, current, eligible, err := q.repository.Resolve(stateCtx, job, recipient)
			stateCancel()
			if err != nil {
				attempts[subscription.ID]++
				nextAttempt[subscription.ID] = q.now().Add(retryBackoff(attempts[subscription.ID]))
				continue
			}
			if !eligible {
				return
			}
			stateCtx, stateCancel = context.WithDeadline(ctx, job.ExpiresAt)
			presence, err = q.presence.Online(stateCtx, []uuid.UUID{recipient})
			stateCancel()
			if err != nil {
				attempts[subscription.ID]++
				nextAttempt[subscription.ID] = q.now().Add(retryBackoff(attempts[subscription.ID]))
				continue
			}
			if presence[recipient] {
				return
			}
			currentSub, found := findCallSubscription(current, subscription.ID)
			if !found {
				outcomes[subscription.ID] = subscriptionDeleted
				continue
			}
			if attempts[subscription.ID] >= maxCallPushAttempts {
				outcomes[subscription.ID] = subscriptionExhausted
				continue
			}
			remaining := job.ExpiresAt.Sub(q.now())
			currentSub.TTL = int(remaining / time.Second)
			if currentSub.TTL < 1 {
				return
			}
			body, err := payload(job, currentName)
			if err != nil {
				return
			}
			attemptCtx, cancel := context.WithDeadline(ctx, job.ExpiresAt)
			status, sendErr := q.sender.Send(attemptCtx, body, currentSub)
			cancel()
			if sendErr == nil && status >= 200 && status < 300 {
				outcomes[subscription.ID] = subscriptionAccepted
				continue
			}
			if sendErr == nil && (status == 404 || status == 410) {
				// Provider invalidation is definitive even if best-effort local deletion
				// encounters a transient storage failure: do not retry this endpoint.
				deleteCtx, deleteCancel := context.WithDeadline(ctx, job.ExpiresAt)
				_ = q.repository.DeleteSubscription(deleteCtx, subscription.ID, currentSub.Fingerprint)
				deleteCancel()
				outcomes[subscription.ID] = subscriptionDeleted
				continue
			}
			attempts[subscription.ID]++
			if attempts[subscription.ID] >= maxCallPushAttempts {
				outcomes[subscription.ID] = subscriptionExhausted
			} else {
				nextAttempt[subscription.ID] = q.now().Add(retryBackoff(attempts[subscription.ID]))
			}
		}
		pending = false
		var wakeAt time.Time
		for id, outcome := range outcomes {
			if outcome != subscriptionPending {
				continue
			}
			pending = true
			if wakeAt.IsZero() || nextAttempt[id].Before(wakeAt) {
				wakeAt = nextAttempt[id]
			}
		}
		if !pending {
			return
		}
		if wakeAt.IsZero() {
			continue
		}
		if !q.wait(ctx, job.ExpiresAt, wakeAt.Sub(q.now())) {
			return
		}
	}
}

func findCallSubscription(subscriptions []messagepush.Subscription, id uuid.UUID) (messagepush.Subscription, bool) {
	for _, subscription := range subscriptions {
		if subscription.ID == id {
			return subscription, true
		}
	}
	return messagepush.Subscription{}, false
}

func retryBackoff(attempt int) time.Duration {
	delay := callPushInitialBackoff
	for n := 1; n < attempt && delay < callPushMaxBackoff; n++ {
		delay *= 2
	}
	if delay > callPushMaxBackoff {
		return callPushMaxBackoff
	}
	return delay
}

func (q *Queue) wait(ctx context.Context, expiry time.Time, interval time.Duration) bool {
	remaining := expiry.Sub(q.now())
	if remaining <= 0 {
		return false
	}
	if interval <= 0 {
		interval = callPushInitialBackoff
	}
	if interval > remaining {
		interval = remaining
	}
	return q.sleep(ctx, interval) && ctx.Err() == nil && q.now().Before(expiry)
}

func (q *Queue) sleepContext(ctx context.Context, interval time.Duration) bool {
	timer := time.NewTimer(interval)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return ctx.Err() == nil
	}
}

func payload(job Job, name string) ([]byte, error) {
	tag, body := "call-"+job.CallID.String(), "Incoming call"
	data := map[string]any{"kind": "direct_call", "call_id": job.CallID, "conversation_id": job.ConversationID}
	if job.Group {
		tag, body = "group-call-"+job.ConversationID.String(), "Group call"
		data = map[string]any{"kind": "group_call", "conversation_id": job.ConversationID}
	}
	data["onActionClick"] = map[string]any{"default": map[string]string{"operation": "focusLastFocusedOrOpen", "url": "/home"}}
	return json.Marshal(map[string]any{"notification": map[string]any{"title": cleanName(name), "body": body, "tag": tag, "data": data}})
}

func cleanName(value string) string {
	value = strings.ToValidUTF8(value, "")
	var b strings.Builder
	for _, r := range value {
		if !unicode.IsControl(r) && !unicode.Is(unicode.Cf, r) && unicode.IsPrint(r) && b.Len()+utf8.RuneLen(r) <= 160 {
			b.WriteRune(r)
		}
	}
	if name := strings.TrimSpace(b.String()); name != "" {
		return name
	}
	return "Someone"
}
