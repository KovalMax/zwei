package callpush

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/KovalMax/zwei/services/realtime/internal/application/messagepush"
)

type repoFake struct {
	mu            sync.Mutex
	eligible      bool
	eligibility   []bool
	subs          []messagepush.Subscription
	err           error
	calls         int
	deleted       []uuid.UUID
	recipientSubs map[uuid.UUID][]messagepush.Subscription
}

func (r *repoFake) DeleteSubscription(_ context.Context, id uuid.UUID, _ []byte) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.deleted = append(r.deleted, id)
	return nil
}

func (r *repoFake) Resolve(_ context.Context, _ Job, recipient uuid.UUID) (string, []messagepush.Subscription, bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls++
	eligible := r.eligible
	if r.calls <= len(r.eligibility) {
		eligible = r.eligibility[r.calls-1]
	}
	subs := r.subs
	if recipientSubs, ok := r.recipientSubs[recipient]; ok {
		subs = recipientSubs
	}
	return "Caller", subs, eligible, r.err
}

type presenceFake struct {
	mu     sync.Mutex
	online bool
	err    error
	calls  int
}

func (p *presenceFake) Online(_ context.Context, ids []uuid.UUID) (map[uuid.UUID]bool, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.calls++
	if p.err != nil {
		return nil, p.err
	}
	result := make(map[uuid.UUID]bool, len(ids))
	for _, id := range ids {
		result[id] = p.online
	}
	return result, nil
}

type senderFake struct {
	mu            sync.Mutex
	statuses      []int
	errs          []error
	payloads      [][]byte
	subscriptions []messagepush.Subscription
	deadlines     []time.Time
}

func (s *senderFake) Send(ctx context.Context, payload []byte, sub messagepush.Subscription) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.payloads = append(s.payloads, append([]byte(nil), payload...))
	s.subscriptions = append(s.subscriptions, sub)
	deadline, _ := ctx.Deadline()
	s.deadlines = append(s.deadlines, deadline)
	i := len(s.payloads) - 1
	if i < len(s.errs) && s.errs[i] != nil {
		return 0, s.errs[i]
	}
	if i < len(s.statuses) {
		return s.statuses[i], nil
	}
	return http.StatusCreated, nil
}

type fakeCallClock struct {
	now    time.Time
	sleeps []time.Duration
}

func clockedQueue(repo Repository, presence Presence, sender Sender, clock *fakeCallClock) *Queue {
	q := New(repo, presence, sender, 8)
	q.now = func() time.Time { return clock.now }
	q.sleep = func(ctx context.Context, d time.Duration) bool {
		if ctx.Err() != nil {
			return false
		}
		clock.sleeps = append(clock.sleeps, d)
		clock.now = clock.now.Add(d)
		return true
	}
	return q
}

func TestCallQueueEnqueueIsBoundedAndNonblocking(t *testing.T) {
	q := New(nil, nil, nil, 1)
	q.now = func() time.Time { return time.Now() }
	job := Job{CallID: uuid.New(), ExpiresAt: time.Now().Add(time.Minute)}
	if !q.Enqueue(job) {
		t.Fatal("first job rejected")
	}
	if q.Enqueue(Job{CallID: uuid.New(), ExpiresAt: time.Now().Add(time.Minute)}) {
		t.Fatal("full queue admitted another job")
	}
}

func TestCallQueueSendsAllSubscriptionsOnlyForAuthorizedOfflineTargets(t *testing.T) {
	starter, target, other := uuid.New(), uuid.New(), uuid.New()
	repo := &repoFake{eligible: true, subs: []messagepush.Subscription{{ID: uuid.New()}, {ID: uuid.New()}}}
	sender := &senderFake{}
	q := New(repo, &presenceFake{}, sender, 4)
	job := Job{CallID: uuid.New(), ConversationID: uuid.New(), StarterID: starter, Group: true, Recipients: []uuid.UUID{starter, target, other}, ExpiresAt: time.Now().Add(time.Minute)}
	q.process(context.Background(), job)
	if len(sender.payloads) != 4 {
		t.Fatalf("provider attempts=%d, want both subscriptions for two non-starter recipients", len(sender.payloads))
	}
	for _, raw := range sender.payloads {
		var envelope struct {
			Notification struct {
				Title, Body, Tag string
				Data             map[string]any
			} `json:"notification"`
		}
		if err := json.Unmarshal(raw, &envelope); err != nil {
			t.Fatal(err)
		}
		if envelope.Notification.Title != "Caller" || envelope.Notification.Body != "Group call" || envelope.Notification.Tag != "group-call-"+job.ConversationID.String() {
			t.Fatalf("unsafe or unstable notification: %s", raw)
		}
		if _, ok := envelope.Notification.Data["call_id"]; ok {
			t.Fatalf("group notification exposed call ID: %s", raw)
		}
		click, ok := envelope.Notification.Data["onActionClick"].(map[string]any)
		if !ok {
			t.Fatalf("missing action metadata: %s", raw)
		}
		defaultAction := click["default"].(map[string]any)
		if defaultAction["operation"] != "focusLastFocusedOrOpen" || defaultAction["url"] != "/home" {
			t.Fatalf("unexpected click action: %s", raw)
		}
	}
}

func TestDirectCallPayloadContainsOnlyApprovedIdentifiers(t *testing.T) {
	job := Job{CallID: uuid.New(), ConversationID: uuid.New(), StarterID: uuid.New(), Recipients: []uuid.UUID{uuid.New()}, ExpiresAt: time.Now().Add(time.Minute)}
	raw, err := payload(job, "Trusted Caller")
	if err != nil {
		t.Fatal(err)
	}
	var envelope struct {
		Notification struct {
			Title string         `json:"title"`
			Body  string         `json:"body"`
			Tag   string         `json:"tag"`
			Data  map[string]any `json:"data"`
		} `json:"notification"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Notification.Title != "Trusted Caller" || envelope.Notification.Body != "Incoming call" || envelope.Notification.Tag != "call-"+job.CallID.String() {
		t.Fatalf("unexpected direct notification: %s", raw)
	}
	if len(envelope.Notification.Data) != 4 || envelope.Notification.Data["kind"] != "direct_call" || envelope.Notification.Data["call_id"] != job.CallID.String() || envelope.Notification.Data["conversation_id"] != job.ConversationID.String() {
		t.Fatalf("direct click data has unapproved fields: %s", raw)
	}
	click := envelope.Notification.Data["onActionClick"].(map[string]any)
	action := click["default"].(map[string]any)
	if len(action) != 2 || action["operation"] != "focusLastFocusedOrOpen" || action["url"] != "/home" {
		t.Fatalf("invalid fixed NGSW action metadata: %s", raw)
	}
	if strings.Contains(string(raw), "sdp") || strings.Contains(string(raw), "credential") || strings.Contains(string(raw), "https://") {
		t.Fatalf("sensitive or arbitrary data in notification: %s", raw)
	}
}

func TestCallQueueRechecksCurrentStateAndPresenceBeforeSending(t *testing.T) {
	for _, tc := range []struct {
		name        string
		eligible    bool
		presenceErr error
		want        int
	}{{"ended", false, nil, 0}, {"redis uncertain", true, errors.New("redis unavailable"), 0}} {
		t.Run(tc.name, func(t *testing.T) {
			repo := &repoFake{eligible: tc.eligible, subs: []messagepush.Subscription{{ID: uuid.New()}}}
			sender := &senderFake{}
			q := New(repo, &presenceFake{err: tc.presenceErr}, sender, 1)
			q.process(context.Background(), Job{CallID: uuid.New(), StarterID: uuid.New(), Recipients: []uuid.UUID{uuid.New()}, ExpiresAt: time.Now().Add(-time.Second)})
			if len(sender.payloads) != tc.want {
				t.Fatalf("send attempts=%d want=%d", len(sender.payloads), tc.want)
			}
		})
	}
}

func TestCallQueueDoesNotSendAfterCallEndsBetweenResolutionAndAttempt(t *testing.T) {
	repo := &repoFake{eligible: true, eligibility: []bool{true, false}, subs: []messagepush.Subscription{{ID: uuid.New()}}}
	sender := &senderFake{}
	q := New(repo, &presenceFake{}, sender, 1)
	q.process(context.Background(), Job{CallID: uuid.New(), StarterID: uuid.New(), Recipients: []uuid.UUID{uuid.New()}, ExpiresAt: time.Now().Add(time.Minute)})
	if len(sender.payloads) != 0 {
		t.Fatalf("sent after current status ended: attempts=%d", len(sender.payloads))
	}
}

func TestCallQueueSuppressesWhenAnyAccountSocketIsPresent(t *testing.T) {
	repo := &repoFake{eligible: true, subs: []messagepush.Subscription{{ID: uuid.New()}}}
	sender := &senderFake{}
	q := New(repo, &presenceFake{online: true}, sender, 1)
	q.process(context.Background(), Job{CallID: uuid.New(), StarterID: uuid.New(), Recipients: []uuid.UUID{uuid.New()}, ExpiresAt: time.Now().Add(time.Minute)})
	if len(sender.payloads) != 0 {
		t.Fatalf("provider sends while recipient online=%d", len(sender.payloads))
	}
}

func TestCallQueueRetriesProviderErrorsOnlyWithinOriginalRingExpiry(t *testing.T) {
	repo := &repoFake{eligible: true, subs: []messagepush.Subscription{{ID: uuid.New()}}}
	sender := &senderFake{errs: []error{errors.New("temporary")}, statuses: []int{0, http.StatusCreated}}
	clock := &fakeCallClock{now: time.Now()}
	q := clockedQueue(repo, &presenceFake{}, sender, clock)
	job := Job{CallID: uuid.New(), ConversationID: uuid.New(), StarterID: uuid.New(), Recipients: []uuid.UUID{uuid.New()}, ExpiresAt: clock.now.Add(3 * time.Second)}
	q.process(context.Background(), job)
	if len(sender.payloads) != 2 {
		t.Fatalf("provider attempts=%d, want retry after transient failure", len(sender.payloads))
	}
	for _, sub := range sender.subscriptions {
		if sub.TTL <= 0 || sub.TTL > 3 {
			t.Fatalf("provider TTL=%d exceeded original ring", sub.TTL)
		}
	}
}

func TestCallQueueDeletesDefinitivelyGoneSubscriptions(t *testing.T) {
	ids := []uuid.UUID{uuid.New(), uuid.New(), uuid.New()}
	repo := &repoFake{eligible: true, subs: []messagepush.Subscription{{ID: ids[0]}, {ID: ids[1]}, {ID: ids[2]}}}
	sender := &senderFake{statuses: []int{404, 410, http.StatusCreated}}
	clock := &fakeCallClock{now: time.Now()}
	q := clockedQueue(repo, &presenceFake{}, sender, clock)
	job := Job{CallID: uuid.New(), StarterID: uuid.New(), Recipients: []uuid.UUID{uuid.New()}, ExpiresAt: clock.now.Add(time.Minute)}
	q.process(context.Background(), job)
	if len(repo.deleted) != 2 || repo.deleted[0] != ids[0] || repo.deleted[1] != ids[1] {
		t.Fatalf("deleted subscription IDs=%v", repo.deleted)
	}
	if len(sender.subscriptions) != 3 {
		t.Fatalf("provider attempts=%d want 3", len(sender.subscriptions))
	}
}

func TestAcceptedSubscriptionIsNotResentWhileAnotherRetries(t *testing.T) {
	accepted, transient := uuid.New(), uuid.New()
	repo := &repoFake{eligible: true, subs: []messagepush.Subscription{{ID: accepted}, {ID: transient}}}
	sender := &senderFake{statuses: []int{http.StatusCreated, 500, http.StatusCreated}}
	clock := &fakeCallClock{now: time.Now()}
	q := clockedQueue(repo, &presenceFake{}, sender, clock)
	q.process(context.Background(), Job{CallID: uuid.New(), StarterID: uuid.New(), Recipients: []uuid.UUID{uuid.New()}, ExpiresAt: clock.now.Add(time.Minute)})
	got := []uuid.UUID{}
	for _, sub := range sender.subscriptions {
		got = append(got, sub.ID)
	}
	want := []uuid.UUID{accepted, transient, transient}
	if len(got) != len(want) {
		t.Fatalf("attempted IDs=%v want=%v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("attempted IDs=%v want=%v", got, want)
		}
	}
}

func TestTransientRetriesUseCappedBackoffAndAttemptCeiling(t *testing.T) {
	id := uuid.New()
	repo := &repoFake{eligible: true, subs: []messagepush.Subscription{{ID: id}}}
	sender := &senderFake{statuses: []int{500, 500, 500, 500, 500, 500}}
	clock := &fakeCallClock{now: time.Now()}
	q := clockedQueue(repo, &presenceFake{}, sender, clock)
	expiry := clock.now.Add(30 * time.Second)
	q.process(context.Background(), Job{CallID: uuid.New(), StarterID: uuid.New(), Recipients: []uuid.UUID{uuid.New()}, ExpiresAt: expiry})
	if len(sender.subscriptions) != maxCallPushAttempts {
		t.Fatalf("attempts=%d want ceiling=%d", len(sender.subscriptions), maxCallPushAttempts)
	}
	if len(repo.deleted) != 0 {
		t.Fatalf("exhausted retries deleted persisted subscription IDs=%v", repo.deleted)
	}
	want := []time.Duration{250 * time.Millisecond, 500 * time.Millisecond, time.Second, 2 * time.Second}
	if len(clock.sleeps) != len(want) {
		t.Fatalf("backoffs=%v want %v", clock.sleeps, want)
	}
	for i := range want {
		if clock.sleeps[i] != want[i] {
			t.Fatalf("backoffs=%v want %v", clock.sleeps, want)
		}
	}
}

type concurrentCallSender struct {
	started chan uuid.UUID
	active  atomic.Int32
	block   bool
	release <-chan struct{}
}

func (s *concurrentCallSender) Send(ctx context.Context, _ []byte, sub messagepush.Subscription) (int, error) {
	s.active.Add(1)
	s.started <- sub.ID
	defer s.active.Add(-1)
	if s.block {
		select {
		case <-s.release:
		case <-ctx.Done():
			return 0, ctx.Err()
		}
	}
	return http.StatusCreated, nil
}

func TestCallQueueSlowRecipientDoesNotStarveLaterRecipients(t *testing.T) {
	recipients := []uuid.UUID{uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()}
	subs := make(map[uuid.UUID][]messagepush.Subscription, len(recipients))
	for _, recipient := range recipients {
		subs[recipient] = []messagepush.Subscription{{ID: recipient}}
	}
	repo := &repoFake{eligible: true, recipientSubs: subs}
	releaseFirst := make(chan struct{})
	started := make(chan uuid.UUID, len(recipients))
	firstEntered := make(chan struct{})
	sender := &recipientBlockingSender{started: started, first: recipients[0], firstEntered: firstEntered, release: releaseFirst}
	q := New(repo, &presenceFake{}, sender, 1)
	done := make(chan struct{})
	go func() {
		q.process(context.Background(), Job{CallID: uuid.New(), StarterID: uuid.New(), Recipients: recipients, ExpiresAt: time.Now().Add(time.Minute)})
		close(done)
	}()
	select {
	case <-firstEntered:
	case <-time.After(time.Second):
		t.Fatal("first recipient did not start")
	}
	seenLater := make(map[uuid.UUID]bool)
	for len(seenLater) < len(recipients)-1 {
		select {
		case id := <-started:
			if id != recipients[0] {
				seenLater[id] = true
			}
		case <-time.After(time.Second):
			close(releaseFirst)
			t.Fatal("slow first recipient starved a later recipient")
		}
	}
	for _, recipient := range recipients[1:] {
		if !seenLater[recipient] {
			close(releaseFirst)
			t.Fatalf("recipient %s was not attempted while first recipient was blocked", recipient)
		}
	}
	close(releaseFirst)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("queue processing did not finish")
	}
}

type recipientBlockingSender struct {
	started      chan<- uuid.UUID
	first        uuid.UUID
	firstEntered chan<- struct{}
	release      <-chan struct{}
}

func (s *recipientBlockingSender) Send(ctx context.Context, _ []byte, sub messagepush.Subscription) (int, error) {
	s.started <- sub.ID
	if sub.ID == s.first {
		close(s.firstEntered)
		select {
		case <-s.release:
		case <-ctx.Done():
			return 0, ctx.Err()
		}
	}
	return http.StatusCreated, nil
}

func TestCallQueueBoundsRecipientConcurrencyAndStopsOnCancellation(t *testing.T) {
	const recipientCount = 12
	recipients := make([]uuid.UUID, recipientCount)
	subs := make(map[uuid.UUID][]messagepush.Subscription, recipientCount)
	for i := range recipients {
		recipients[i] = uuid.New()
		subs[recipients[i]] = []messagepush.Subscription{{ID: recipients[i]}}
	}
	started := make(chan uuid.UUID, recipientCount)
	ctx, cancel := context.WithCancel(context.Background())
	sender := &concurrentCallSender{started: started, block: true, release: ctx.Done()}
	q := New(&repoFake{eligible: true, recipientSubs: subs}, &presenceFake{}, sender, 1)
	done := make(chan struct{})
	go func() {
		q.process(ctx, Job{CallID: uuid.New(), StarterID: uuid.New(), Recipients: recipients, ExpiresAt: time.Now().Add(time.Minute)})
		close(done)
	}()
	for i := 0; i < callPushRecipientWorkers; i++ {
		select {
		case <-started:
		case <-time.After(time.Second):
			cancel()
			t.Fatal("bounded worker pool failed to start concurrent recipient work")
		}
	}
	if got := sender.active.Load(); got != callPushRecipientWorkers {
		cancel()
		t.Fatalf("active recipient sends=%d want worker bound %d", got, callPushRecipientWorkers)
	}
	select {
	case <-started:
		cancel()
		t.Fatal("recipient work exceeded fixed concurrency bound")
	default:
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("recipient workers did not stop after cancellation")
	}
}

func TestCallQueueProcessesLaterJobsWithFixedOverallWorkerBound(t *testing.T) {
	const jobs = callPushJobWorkers + 1
	const recipientsPerJob = callPushRecipientWorkers
	started := make(chan uuid.UUID, callPushOverallWorkers+jobs)
	firstRecipient := uuid.New()
	laterRecipient := uuid.New()
	allSubs := make(map[uuid.UUID][]messagepush.Subscription)
	firstStarted, laterStarted := make(chan struct{}), make(chan struct{})
	queue := New(&repoFake{eligible: true, recipientSubs: allSubs}, &presenceFake{}, &jobBlockingSender{
		started: started, first: firstRecipient, later: laterRecipient, firstStarted: firstStarted, laterStarted: laterStarted,
	}, jobs)
	now := time.Now()
	for jobIndex := 0; jobIndex < jobs; jobIndex++ {
		recipients := make([]uuid.UUID, recipientsPerJob)
		for recipientIndex := range recipients {
			recipients[recipientIndex] = uuid.New()
			allSubs[recipients[recipientIndex]] = []messagepush.Subscription{{ID: recipients[recipientIndex]}}
		}
		if jobIndex == 0 {
			recipients[0] = firstRecipient
			allSubs[firstRecipient] = []messagepush.Subscription{{ID: firstRecipient}}
		}
		if jobIndex == 1 {
			recipients[0] = laterRecipient
			allSubs[laterRecipient] = []messagepush.Subscription{{ID: laterRecipient}}
		}
		if !queue.Enqueue(Job{CallID: uuid.New(), StarterID: uuid.New(), Recipients: recipients, ExpiresAt: now.Add(time.Minute)}) {
			t.Fatalf("failed to enqueue job %d", jobIndex)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { queue.Run(ctx); close(done) }()
	for _, start := range []<-chan struct{}{firstStarted, laterStarted} {
		select {
		case <-start:
		case <-time.After(time.Second):
			cancel()
			<-done
			t.Fatal("a blocked first or later call job did not start")
		}
	}
	seen := make(map[uuid.UUID]bool)
	for i := 0; i < callPushOverallWorkers; i++ {
		select {
		case id := <-started:
			seen[id] = true
		case <-time.After(time.Second):
			cancel()
			<-done
			t.Fatalf("only %d provider attempts started, want fixed overall bound %d", i, callPushOverallWorkers)
		}
	}
	if !seen[firstRecipient] || !seen[laterRecipient] {
		cancel()
		<-done
		t.Fatalf("expected both an initial blocked job and a later job to start; first=%t later=%t", seen[firstRecipient], seen[laterRecipient])
	}
	select {
	case id := <-started:
		cancel()
		<-done
		t.Fatalf("started provider work beyond overall bound %d (subscription %s)", callPushOverallWorkers, id)
	default:
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("call queue did not stop after cancellation")
	}
}

type jobBlockingSender struct {
	started      chan<- uuid.UUID
	first        uuid.UUID
	later        uuid.UUID
	firstStarted chan struct{}
	laterStarted chan struct{}
}

func (s *jobBlockingSender) Send(ctx context.Context, _ []byte, sub messagepush.Subscription) (int, error) {
	s.started <- sub.ID
	if sub.ID == s.first {
		close(s.firstStarted)
	}
	if sub.ID == s.later {
		close(s.laterStarted)
	}
	<-ctx.Done()
	return 0, ctx.Err()
}

func TestEveryProviderRequestDeadlineIsAtMostOriginalExpiry(t *testing.T) {
	repo := &repoFake{eligible: true, subs: []messagepush.Subscription{{ID: uuid.New()}, {ID: uuid.New()}}}
	sender := &senderFake{}
	clock := &fakeCallClock{now: time.Now()}
	q := clockedQueue(repo, &presenceFake{}, sender, clock)
	expiry := clock.now.Add(time.Minute)
	q.process(context.Background(), Job{CallID: uuid.New(), StarterID: uuid.New(), Recipients: []uuid.UUID{uuid.New()}, ExpiresAt: expiry})
	if len(sender.deadlines) != 2 {
		t.Fatalf("provider deadlines=%v", sender.deadlines)
	}
	for _, deadline := range sender.deadlines {
		if deadline.After(expiry) {
			t.Fatalf("provider deadline %s exceeds expiry %s", deadline, expiry)
		}
	}
}
