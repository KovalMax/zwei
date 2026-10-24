package messagepush

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

type repositoryFake struct {
	mu                  sync.Mutex
	event               Intent
	events              []Intent
	name                string
	subscriptions       []Subscription
	eligible            bool
	resolvedErr         error
	eligibility         map[uuid.UUID]bool
	completed, retried  int
	deleted             []uuid.UUID
	deletedFingerprints [][]byte
	purgedBatchSize     int
	purgeErr            error
}

func (r *repositoryFake) Claim(context.Context, int) ([]Intent, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.events != nil {
		return r.events, nil
	}
	return []Intent{r.event}, nil
}
func (r *repositoryFake) PurgeProcessed(_ context.Context, limit int) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.purgedBatchSize = limit
	return r.purgeErr
}
func (r *repositoryFake) Resolve(_ context.Context, event Intent) (string, []Subscription, bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	eligible := r.eligible
	if value, ok := r.eligibility[event.ID]; ok {
		eligible = value
	}
	return r.name, r.subscriptions, eligible, r.resolvedErr
}
func (r *repositoryFake) DeleteSubscription(_ context.Context, id uuid.UUID, fingerprint []byte) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.deleted = append(r.deleted, id)
	r.deletedFingerprints = append(r.deletedFingerprints, append([]byte(nil), fingerprint...))
	return nil
}
func (r *repositoryFake) Complete(context.Context, Intent) error {
	r.mu.Lock()
	r.completed++
	r.mu.Unlock()
	return nil
}
func (r *repositoryFake) Retry(context.Context, Intent) error {
	r.mu.Lock()
	r.retried++
	r.mu.Unlock()
	return nil
}

type presenceFake struct {
	online    map[uuid.UUID]bool
	err       error
	responses []presenceResponse
	calls     *int
}

type presenceResponse struct {
	online map[uuid.UUID]bool
	err    error
}

func (p presenceFake) Online(context.Context, []uuid.UUID) (map[uuid.UUID]bool, error) {
	if p.calls != nil {
		index := *p.calls
		*p.calls = index + 1
		if index < len(p.responses) {
			return p.responses[index].online, p.responses[index].err
		}
	}
	return p.online, p.err
}

type senderFake struct {
	mu            sync.Mutex
	statuses      []int
	errs          []error
	payloads      [][]byte
	subscriptions []Subscription
}

func (s *senderFake) Send(_ context.Context, payload []byte, sub Subscription) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	i := len(s.payloads)
	s.payloads = append(s.payloads, append([]byte(nil), payload...))
	s.subscriptions = append(s.subscriptions, sub)
	if i < len(s.statuses) {
		var err error
		if i < len(s.errs) {
			err = s.errs[i]
		}
		return s.statuses[i], err
	}
	return 201, nil
}

func TestDispatcherSendsPrivatePayloadToEverySubscription(t *testing.T) {
	recipient := uuid.New()
	repo := &repositoryFake{event: Intent{MessageID: uuid.New(), ConversationID: uuid.New(), RecipientID: recipient}, name: " Alice\u202e\n", eligible: true, subscriptions: []Subscription{{ID: uuid.New()}, {ID: uuid.New()}}}
	sender := &senderFake{}
	if err := New(repo, presenceFake{online: map[uuid.UUID]bool{recipient: false}}, sender).Process(context.Background(), 1); err != nil {
		t.Fatal(err)
	}
	if len(sender.payloads) != 2 || repo.completed != 1 || repo.retried != 0 {
		t.Fatalf("sends=%d complete=%d retry=%d", len(sender.payloads), repo.completed, repo.retried)
	}
	var payload map[string]any
	if err := json.Unmarshal(sender.payloads[0], &payload); err != nil {
		t.Fatal(err)
	}
	encoded := string(sender.payloads[0])
	if strings.Contains(encoded, "\u202e") || strings.Contains(encoded, "\n") || strings.Contains(encoded, "Alice ") {
		t.Fatalf("unsafe name in payload: %q", encoded)
	}
	if _, ok := payload["body"]; ok {
		t.Fatal("payload has a top-level message body")
	}
	notice := payload["notification"].(map[string]any)
	if notice["title"] != "Alice" || notice["body"] != "New message" {
		t.Fatalf("notification content = %#v", notice)
	}
	if notice["tag"] != "message-"+repo.event.MessageID.String() {
		t.Fatalf("unstable tag %v", notice["tag"])
	}
	data := notice["data"].(map[string]any)
	click := data["onActionClick"].(map[string]any)
	defaultAction := click["default"].(map[string]any)
	if len(defaultAction) != 2 || defaultAction["operation"] != "focusLastFocusedOrOpen" || defaultAction["url"] != "/home" {
		t.Fatalf("invalid fixed NGSW click action: %#v", defaultAction)
	}
}

func TestDispatcherHonorsCancellationBeforeMaintenance(t *testing.T) {
	repo := &repositoryFake{}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := New(repo, presenceFake{}, &senderFake{}).Process(ctx, 1); !errors.Is(err, context.Canceled) {
		t.Fatalf("Process error = %v, want context cancellation", err)
	}
	if repo.purgedBatchSize != 0 {
		t.Fatalf("purge batch size = %d, want cleanup skipped after cancellation", repo.purgedBatchSize)
	}
}

func TestDispatcherProcessesEligibleIntentBeforeReturningPurgeFailure(t *testing.T) {
	wantErr := errors.New("purge failed")
	recipient := uuid.New()
	repo := &repositoryFake{event: Intent{MessageID: uuid.New(), ConversationID: uuid.New(), RecipientID: recipient},
		name: "Sender", eligible: true, subscriptions: []Subscription{{ID: uuid.New()}}, purgeErr: wantErr}
	sender := &senderFake{}
	err := New(repo, presenceFake{online: map[uuid.UUID]bool{}}, sender).Process(context.Background(), 1)
	if !errors.Is(err, wantErr) {
		t.Fatalf("Process error = %v, want %v", err, wantErr)
	}
	if len(sender.payloads) != 1 || repo.completed != 1 {
		t.Fatalf("purge failure blocked work: sends=%d completed=%d", len(sender.payloads), repo.completed)
	}
}

func TestDispatcherPurgesWhenClaimReturnsNoWork(t *testing.T) {
	repo := &repositoryFake{events: []Intent{}}
	if err := New(repo, presenceFake{}, &senderFake{}).Process(context.Background(), 1); err != nil {
		t.Fatal(err)
	}
	if repo.purgedBatchSize != 100 {
		t.Fatalf("purge batch size = %d, want 100", repo.purgedBatchSize)
	}
}

func TestDispatcherProcessingFailureTakesPrecedenceOverPurgeFailure(t *testing.T) {
	recipient := uuid.New()
	repo := &repositoryFake{event: Intent{RecipientID: recipient}, eligible: true,
		subscriptions: []Subscription{{ID: uuid.New()}}, purgeErr: errors.New("purge failed")}
	sender := &senderFake{statuses: []int{503}, errs: []error{nil}}
	err := New(repo, presenceFake{online: map[uuid.UUID]bool{}}, sender).Process(context.Background(), 1)
	var diagnostic *DiagnosticError
	if !errors.As(err, &diagnostic) || diagnostic.Reason != "provider_failed" {
		t.Fatalf("Process error = %v, want processing failure to take precedence", err)
	}
}

func TestDispatcherTerminalSuppressionAndFailClosedPresence(t *testing.T) {
	recipient := uuid.New()
	for _, tc := range []struct {
		name     string
		eligible bool
		presence presenceFake
	}{
		{name: "membership or alert mode", eligible: false, presence: presenceFake{}},
		{name: "socket connected", eligible: true, presence: presenceFake{online: map[uuid.UUID]bool{recipient: true}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repo := &repositoryFake{event: Intent{RecipientID: recipient}, eligible: tc.eligible, subscriptions: []Subscription{{ID: uuid.New()}}}
			sender := &senderFake{}
			_ = New(repo, tc.presence, sender).Process(context.Background(), 1)
			if repo.completed != 1 || len(sender.payloads) != 0 {
				t.Fatalf("complete=%d sends=%d", repo.completed, len(sender.payloads))
			}
		})
	}
}

func TestDispatcherRetriesWhenPresenceUnavailable(t *testing.T) {
	recipient := uuid.New()
	repo := &repositoryFake{event: Intent{RecipientID: recipient}, eligible: true, subscriptions: []Subscription{{ID: uuid.New()}, {ID: uuid.New()}}}
	sender := &senderFake{}
	err := New(repo, presenceFake{err: errors.New("redis")}, sender).Process(context.Background(), 1)
	var diagnostic *DiagnosticError
	if !errors.As(err, &diagnostic) || diagnostic.Reason != "presence_failed" {
		t.Fatalf("Process error = %v, want presence_failed", err)
	}
	if repo.retried != 1 || repo.completed != 0 || len(sender.payloads) != 0 {
		t.Fatalf("presence failure must retry without sending: retries=%d complete=%d sends=%d", repo.retried, repo.completed, len(sender.payloads))
	}
}

func TestDispatcherChecksPresenceBeforeSendingToAnySubscription(t *testing.T) {
	recipient := uuid.New()
	calls := 0
	repo := &repositoryFake{event: Intent{RecipientID: recipient}, eligible: true, subscriptions: []Subscription{{ID: uuid.New()}, {ID: uuid.New()}}}
	sender := &senderFake{}
	presence := presenceFake{calls: &calls, responses: []presenceResponse{
		{online: map[uuid.UUID]bool{recipient: false}},
		{err: errors.New("redis unavailable on a subsequent lookup")},
	}}
	if err := New(repo, presence, sender).Process(context.Background(), 1); err != nil {
		t.Fatalf("Process() error = %v, want success after one confirmed offline lookup", err)
	}
	if calls != 1 || len(sender.payloads) != 2 || repo.completed != 1 || repo.retried != 0 {
		t.Fatalf("presence lookups=%d sends=%d complete=%d retries=%d; want one preflight lookup, both sends, and completion", calls, len(sender.payloads), repo.completed, repo.retried)
	}
}

func TestDispatcherRemovesOnlyGoneSubscriptionsAndRetriesTransient(t *testing.T) {
	recipient := uuid.New()
	one, gone404, gone410, transient := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	repo := &repositoryFake{event: Intent{RecipientID: recipient}, eligible: true, name: "Sender", subscriptions: []Subscription{{ID: one}, {ID: gone404}, {ID: gone410}, {ID: transient}}}
	sender := &senderFake{statuses: []int{201, 404, 410, 503}, errs: []error{nil, nil, nil, nil}}
	err := New(repo, presenceFake{online: map[uuid.UUID]bool{}}, sender).Process(context.Background(), 1)
	var diagnostic *DiagnosticError
	if !errors.As(err, &diagnostic) || diagnostic.Reason != "provider_failed" || diagnostic.HTTPStatus != 503 {
		t.Fatalf("Process error = %v, want bounded provider diagnostic for 503", err)
	}
	if repo.retried != 1 || repo.completed != 0 || len(repo.deleted) != 2 || repo.deleted[0] != gone404 || repo.deleted[1] != gone410 || len(sender.payloads) != 4 {
		t.Fatalf("retry=%d complete=%d deleted=%v attempts=%d", repo.retried, repo.completed, repo.deleted, len(sender.payloads))
	}
}

func TestDispatcherProviderErrorRetriesRecipientIndependently(t *testing.T) {
	firstID, secondID := uuid.New(), uuid.New()
	repo := &repositoryFake{events: []Intent{{ID: firstID, RecipientID: uuid.New()}, {ID: secondID, RecipientID: uuid.New()}}, eligibility: map[uuid.UUID]bool{firstID: true, secondID: false}, subscriptions: []Subscription{{ID: uuid.New()}}}
	failedSender := &senderFake{statuses: []int{0}, errs: []error{errors.New("timeout")}}
	err := New(repo, presenceFake{}, failedSender).Process(context.Background(), 2)
	var diagnostic *DiagnosticError
	if !errors.As(err, &diagnostic) || diagnostic.Reason != "provider_failed" || diagnostic.HTTPStatus != 0 {
		t.Fatalf("Process error = %v, want provider_failed without status", err)
	}
	if repo.retried != 1 || repo.completed != 1 || len(failedSender.payloads) != 1 {
		t.Fatalf("recipient isolation failed: retries=%d completed=%d sends=%d", repo.retried, repo.completed, len(failedSender.payloads))
	}
}

func TestDispatcherReportsBoundedProviderFailureWhenRetryIsScheduled(t *testing.T) {
	recipient := uuid.New()
	repo := &repositoryFake{event: Intent{RecipientID: recipient}, eligible: true, subscriptions: []Subscription{{ID: uuid.New()}}}
	sender := &senderFake{statuses: []int{503}, errs: []error{nil}}
	err := New(repo, presenceFake{online: map[uuid.UUID]bool{}}, sender).Process(context.Background(), 1)
	var diagnostic *DiagnosticError
	if !errors.As(err, &diagnostic) {
		t.Fatalf("Process error = %v, want bounded diagnostic", err)
	}
	if diagnostic.Reason != "provider_failed" || diagnostic.HTTPStatus != 503 {
		t.Fatalf("diagnostic = %#v, want provider_failed with status 503", diagnostic)
	}
	if repo.retried != 1 || repo.completed != 0 {
		t.Fatalf("retry=%d complete=%d, want retry scheduled", repo.retried, repo.completed)
	}
}

func TestDispatcherPreservesOnlyApprovedProviderCodeAndRetries(t *testing.T) {
	for _, tc := range []struct{ code, want string }{
		{"VapidPkHashMismatch", "VapidPkHashMismatch"},
		{"attacker-controlled-value", ""},
	} {
		t.Run(tc.code, func(t *testing.T) {
			repo := &repositoryFake{event: Intent{RecipientID: uuid.New()}, eligible: true, subscriptions: []Subscription{{ID: uuid.New()}}}
			sender := &senderFake{statuses: []int{403}, errs: []error{&ProviderError{Code: tc.code}}}
			err := New(repo, presenceFake{}, sender).Process(context.Background(), 1)
			var diagnostic *DiagnosticError
			if !errors.As(err, &diagnostic) || diagnostic.Reason != "provider_failed" || diagnostic.ProviderCode != tc.want {
				t.Fatalf("diagnostic = %#v, error %v; want provider code %q", diagnostic, err, tc.want)
			}
			if repo.retried != 1 || repo.completed != 0 {
				t.Fatalf("retry=%d complete=%d", repo.retried, repo.completed)
			}
		})
	}
}

func TestDispatcherReportsResolveFailureWithoutExposingCause(t *testing.T) {
	repo := &repositoryFake{eligible: true, resolvedErr: errors.New("private database detail")}
	err := New(repo, presenceFake{}, &senderFake{}).Process(context.Background(), 1)
	var diagnostic *DiagnosticError
	if !errors.As(err, &diagnostic) || diagnostic.Reason != "resolve_failed" {
		t.Fatalf("Process error = %v, want resolve_failed diagnostic", err)
	}
	if strings.Contains(err.Error(), "private database detail") {
		t.Fatalf("diagnostic exposed cause: %v", err)
	}
	if repo.retried != 1 || repo.completed != 0 {
		t.Fatalf("retry=%d complete=%d, want retry scheduled", repo.retried, repo.completed)
	}
}

func TestDispatcherSlowIntentDoesNotBlockLaterClaimedIntent(t *testing.T) {
	firstID, secondID := uuid.New(), uuid.New()
	firstMessage, secondMessage := uuid.New(), uuid.New()
	repo := &repositoryFake{
		events: []Intent{
			{ID: firstID, MessageID: firstMessage, RecipientID: uuid.New()},
			{ID: secondID, MessageID: secondMessage, RecipientID: uuid.New()},
		}, eligibility: map[uuid.UUID]bool{firstID: true, secondID: true},
		name: "Sender", eligible: true, subscriptions: []Subscription{{ID: uuid.New()}},
	}
	sender := &intentBlockingSender{blockedMessage: firstMessage, blocked: make(chan struct{}), release: make(chan struct{}), later: make(chan struct{})}
	done := make(chan error, 1)
	go func() { done <- New(repo, presenceFake{}, sender).Process(context.Background(), 2) }()
	select {
	case <-sender.blocked:
	case <-time.After(time.Second):
		t.Fatal("first intent did not enter its blocked send")
	}
	select {
	case <-sender.later:
	case <-time.After(time.Second):
		close(sender.release)
		t.Fatal("slow first intent blocked the later claimed intent")
	}
	close(sender.release)
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("dispatcher did not finish")
	}
	if repo.completed != 2 || repo.retried != 0 {
		t.Fatalf("claim completion/retry counts=%d/%d, want 2/0", repo.completed, repo.retried)
	}
}

type intentBlockingSender struct {
	blockedMessage uuid.UUID
	blocked        chan struct{}
	release        chan struct{}
	later          chan struct{}
}

func (s *intentBlockingSender) Send(ctx context.Context, payload []byte, _ Subscription) (int, error) {
	if strings.Contains(string(payload), s.blockedMessage.String()) {
		close(s.blocked)
		select {
		case <-s.release:
		case <-ctx.Done():
			return 0, ctx.Err()
		}
	} else {
		close(s.later)
	}
	return 201, nil
}

func TestNormalizeDisplayNameBoundsAndRemovesControls(t *testing.T) {
	got := normalizeDisplayName(strings.Repeat("é", 200) + "\u202e\x00")
	if len(got) > 160 || strings.ContainsAny(got, "\x00") || strings.ContainsRune(got, '\u202e') || !strings.HasPrefix(got, "é") {
		t.Fatalf("normalized display name invalid: bytes=%d", len(got))
	}
	if normalizeDisplayName("\u202e\n") != "Someone" {
		t.Fatal("empty normalized name must use safe fallback")
	}
}
