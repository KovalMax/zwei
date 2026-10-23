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
}

func (r *repositoryFake) Claim(context.Context, int) ([]Intent, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.events != nil {
		return r.events, nil
	}
	return []Intent{r.event}, nil
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
	online map[uuid.UUID]bool
	err    error
}

func (p presenceFake) Online(context.Context, []uuid.UUID) (map[uuid.UUID]bool, error) {
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

func TestDispatcherTerminalSuppressionAndFailClosedPresence(t *testing.T) {
	recipient := uuid.New()
	for _, tc := range []struct {
		name     string
		eligible bool
		presence presenceFake
	}{
		{name: "membership or alert mode", eligible: false, presence: presenceFake{}},
		{name: "offline uncertainty", eligible: true, presence: presenceFake{err: errors.New("redis")}},
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

func TestDispatcherRemovesOnlyGoneSubscriptionsAndRetriesTransient(t *testing.T) {
	recipient := uuid.New()
	one, gone404, gone410, transient := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	repo := &repositoryFake{event: Intent{RecipientID: recipient}, eligible: true, name: "Sender", subscriptions: []Subscription{{ID: one}, {ID: gone404}, {ID: gone410}, {ID: transient}}}
	sender := &senderFake{statuses: []int{201, 404, 410, 503}, errs: []error{nil, nil, nil, nil}}
	if err := New(repo, presenceFake{online: map[uuid.UUID]bool{}}, sender).Process(context.Background(), 1); err != nil {
		t.Fatal(err)
	}
	if repo.retried != 1 || repo.completed != 0 || len(repo.deleted) != 2 || repo.deleted[0] != gone404 || repo.deleted[1] != gone410 || len(sender.payloads) != 4 {
		t.Fatalf("retry=%d complete=%d deleted=%v attempts=%d", repo.retried, repo.completed, repo.deleted, len(sender.payloads))
	}
}

func TestDispatcherProviderErrorRetriesRecipientIndependently(t *testing.T) {
	firstID, secondID := uuid.New(), uuid.New()
	repo := &repositoryFake{events: []Intent{{ID: firstID, RecipientID: uuid.New()}, {ID: secondID, RecipientID: uuid.New()}}, eligibility: map[uuid.UUID]bool{firstID: true, secondID: false}, subscriptions: []Subscription{{ID: uuid.New()}}}
	failedSender := &senderFake{statuses: []int{0}, errs: []error{errors.New("timeout")}}
	if err := New(repo, presenceFake{}, failedSender).Process(context.Background(), 2); err != nil {
		t.Fatal(err)
	}
	if repo.retried != 1 || repo.completed != 1 || len(failedSender.payloads) != 1 {
		t.Fatalf("recipient isolation failed: retries=%d completed=%d sends=%d", repo.retried, repo.completed, len(failedSender.payloads))
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
