package webpush

import (
	"context"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/base64"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/KovalMax/zwei/services/realtime/internal/application/messagepush"
)

type resolverFake struct {
	ips []net.IP
	err error
}

func (r resolverFake) LookupIP(context.Context, string, string) ([]net.IP, error) {
	return r.ips, r.err
}

type providerFake struct {
	status        int
	err           error
	called, block bool
}

func (p *providerFake) Do(req *http.Request) (*http.Response, error) {
	p.called = true
	if p.block {
		<-req.Context().Done()
		return nil, req.Context().Err()
	}
	if req.URL.Host != "fcm.googleapis.com" {
		return nil, io.ErrUnexpectedEOF
	}
	if req.Header.Get("Authorization") == "" {
		return nil, io.ErrUnexpectedEOF
	}
	if len(req.Header.Get("Topic")) != 32 {
		return nil, io.ErrUnexpectedEOF
	}
	if p.err != nil {
		return nil, p.err
	}
	return &http.Response{StatusCode: p.status, Body: io.NopCloser(strings.NewReader("provider response must stay private")), Header: make(http.Header), Request: req}, nil
}

func vapidKeys(t *testing.T) (string, string) {
	t.Helper()
	d, x, y, err := elliptic.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	private := make([]byte, 32)
	new(big.Int).SetBytes(d).FillBytes(private)
	return base64.RawURLEncoding.EncodeToString(elliptic.Marshal(elliptic.P256(), x, y)), base64.RawURLEncoding.EncodeToString(private)
}

func TestNewValidatesVAPIDPublicPrivatePair(t *testing.T) {
	pub, priv := vapidKeys(t)
	if _, err := New(pub, priv, "mailto:ops@example.test", resolverFake{}); err != nil {
		t.Fatalf("valid VAPID pair rejected: %v", err)
	}
	pub2, _ := vapidKeys(t)
	if _, err := New(pub2, priv, "mailto:ops@example.test", resolverFake{}); err == nil {
		t.Fatal("mismatched VAPID keys accepted")
	}
	if _, err := New(pub, priv, "bad\r\nsubject", resolverFake{}); err == nil {
		t.Fatal("header-injection subject accepted")
	}
}

func TestSenderAcceptsProviderSuccessAndSanitizesErrors(t *testing.T) {
	pub, priv := vapidKeys(t)
	sender, err := New(pub, priv, "mailto:ops@example.test", resolverFake{})
	if err != nil {
		t.Fatal(err)
	}
	provider := &providerFake{status: 201}
	sender.client = provider
	sub := messagepush.Subscription{ID: uuid.New(), Endpoint: "https://fcm.googleapis.com/fcm/send/opaque", P256DH: pub, Auth: base64.RawURLEncoding.EncodeToString(make([]byte, 16)), TTL: 86400}
	payload := []byte(`{"notification":{"tag":"message-11111111-1111-4111-8111-111111111111","title":"Name","data":{"kind":"message","conversation_id":"22222222-2222-4222-8222-222222222222","message_id":"11111111-1111-4111-8111-111111111111"}}}`)
	status, err := sender.Send(context.Background(), payload, sub)
	if err != nil || status != 201 || !provider.called {
		t.Fatalf("accepted provider status=%d err=%v called=%t", status, err, provider.called)
	}
	provider.err = io.ErrUnexpectedEOF
	_, err = sender.Send(context.Background(), payload, sub)
	if err == nil || strings.Contains(err.Error(), "fcm") || strings.Contains(err.Error(), "secret") {
		t.Fatalf("provider error leaked details: %v", err)
	}
}

func TestSenderHonorsContextTimeoutAndRejectsEndpointRedirectSurfaces(t *testing.T) {
	pub, priv := vapidKeys(t)
	sender, err := New(pub, priv, "mailto:ops@example.test", resolverFake{})
	if err != nil {
		t.Fatal(err)
	}
	provider := &providerFake{status: 307}
	sender.client = provider
	sub := messagepush.Subscription{Endpoint: "https://fcm.googleapis.com/send/token", P256DH: pub, Auth: base64.RawURLEncoding.EncodeToString(make([]byte, 16)), TTL: 86400}
	payload := []byte(`{"notification":{"tag":"message-11111111-1111-4111-8111-111111111111","data":{"kind":"message","conversation_id":"22222222-2222-4222-8222-222222222222","message_id":"11111111-1111-4111-8111-111111111111"}}}`)
	status, err := sender.Send(context.Background(), payload, sub)
	if err != nil || status != 307 {
		t.Fatalf("redirect response status=%d err=%v", status, err)
	}
	for _, endpoint := range []string{"http://fcm.googleapis.com/send/x", "https://user@fcm.googleapis.com/send/x", "https://fcm.googleapis.com:444/send/x", "https://fcm.googleapis.com/send/x?token=x", "https://127.0.0.1/send/x", "https://attacker.example/send/x"} {
		sub.Endpoint = endpoint
		if _, err := sender.Send(context.Background(), payload, sub); err == nil {
			t.Errorf("endpoint accepted: %s", endpoint)
		}
	}
	sub.Endpoint = "https://fcm.googleapis.com/send/token"
	provider.block = true
	ctx, cancel := context.WithTimeout(context.Background(), time.Millisecond)
	defer cancel()
	_, err = sender.Send(ctx, payload, sub)
	if err == nil {
		t.Fatal("provider timeout did not fail")
	}
}

func TestSafeDialerRejectsEveryMixedOrMappedPrivateAnswerBeforeDial(t *testing.T) {
	for _, ips := range [][]net.IP{{net.ParseIP("8.8.8.8"), net.ParseIP("10.0.0.1")}, {net.ParseIP("::ffff:127.0.0.1")}, {net.ParseIP("169.254.169.254")}} {
		d := safeDialer{resolver: resolverFake{ips: ips}}
		ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
		_, err := d.DialContext(ctx, "tcp", "fcm.googleapis.com:443")
		cancel()
		if err == nil {
			t.Fatalf("unsafe DNS answers accepted: %v", ips)
		}
	}
	for _, raw := range []string{"0.0.0.0", "127.0.0.1", "10.1.2.3", "100.64.1.2", "169.254.169.254", "192.0.2.1", "198.18.0.1", "::1", "fc00::1", "fe80::1", "2001:db8::1", "2002::1", "::ffff:10.0.0.1"} {
		ip := netip.MustParseAddr(raw)
		if publicAddress(ip) {
			t.Errorf("non-public IP accepted: %s", ip)
		}
	}
}

func TestSafeDialerConnectsToResolvedValidatedLiteralAddress(t *testing.T) {
	var dialed string
	d := safeDialer{resolver: resolverFake{ips: []net.IP{net.ParseIP("8.8.8.8")}}, dial: func(_ context.Context, network, address string) (net.Conn, error) {
		if network != "tcp" {
			t.Fatalf("network=%q", network)
		}
		dialed = address
		client, server := net.Pipe()
		_ = server.Close()
		return client, nil
	}}
	conn, err := d.DialContext(context.Background(), "tcp", "fcm.googleapis.com:443")
	if err != nil {
		t.Fatal(err)
	}
	_ = conn.Close()
	if dialed != "8.8.8.8:443" {
		t.Fatalf("connected address=%q, want validated resolved IP", dialed)
	}
}

func TestNoProxyAndRedirectsOnProductionHTTPClient(t *testing.T) {
	pub, priv := vapidKeys(t)
	s, err := New(pub, priv, "mailto:ops@example.test", resolverFake{})
	if err != nil {
		t.Fatal(err)
	}
	client, ok := s.client.(*http.Client)
	if !ok {
		t.Fatal("production sender lacks bounded HTTP client")
	}
	if client.Timeout == 0 || client.CheckRedirect == nil {
		t.Fatal("HTTP client timeout/redirect policy missing")
	}
	if client.Transport.(*http.Transport).Proxy != nil {
		t.Fatal("environment proxy unexpectedly enabled")
	}
	if err := client.CheckRedirect(&http.Request{}, nil); err != http.ErrUseLastResponse {
		t.Fatalf("redirect policy = %v", err)
	}
}
