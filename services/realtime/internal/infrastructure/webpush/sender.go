package webpush

import (
	"context"
	"crypto/elliptic"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/mail"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"

	"github.com/KovalMax/zwei/services/realtime/internal/application/messagepush"
)

var ErrConfiguration = errors.New("invalid web push configuration")

type Resolver interface {
	LookupIP(context.Context, string, string) ([]net.IP, error)
}
type systemResolver struct{}

func (systemResolver) LookupIP(ctx context.Context, network, host string) ([]net.IP, error) {
	return net.DefaultResolver.LookupIP(ctx, network, host)
}

type Sender struct {
	publicKey, privateKey, subject string
	client                         webpush.HTTPClient
}

func New(publicKey, privateKey, subject string, resolver Resolver) (*Sender, error) {
	if resolver == nil {
		resolver = systemResolver{}
	}
	if !validVAPIDPair(publicKey, privateKey) || !validSubject(subject) {
		return nil, ErrConfiguration
	}
	transport := &http.Transport{
		Proxy:                 nil,
		DialContext:           safeDialer{resolver: resolver}.DialContext,
		TLSClientConfig:       &tls.Config{MinVersion: tls.VersionTLS12},
		TLSHandshakeTimeout:   4 * time.Second,
		ResponseHeaderTimeout: 5 * time.Second,
		DisableKeepAlives:     true,
	}
	return &Sender{publicKey: publicKey, privateKey: privateKey, subject: subject,
		client: &http.Client{Transport: transport, Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}

func validSubject(subject string) bool {
	if subject == "" || len(subject) > 256 || strings.ContainsAny(subject, "\r\n") {
		return false
	}
	if strings.HasPrefix(subject, "mailto:") {
		address := strings.TrimPrefix(subject, "mailto:")
		parsed, err := mail.ParseAddress(address)
		return err == nil && parsed.Address == address
	}
	parsed, err := url.Parse(subject)
	return err == nil && parsed.Scheme == "https" && parsed.Hostname() != "" && parsed.User == nil && parsed.Fragment == ""
}

func (s *Sender) Send(ctx context.Context, payload []byte, subscription messagepush.Subscription) (int, error) {
	if subscription.TTL < 1 {
		return 0, errors.New("push request rejected")
	}
	if subscription.TTL > 86400 {
		subscription.TTL = 86400
	}
	parsed, err := url.Parse(subscription.Endpoint)
	if err != nil || !validEndpoint(parsed) {
		return 0, errors.New("push request rejected")
	}
	topic, err := messageTopic(payload)
	if err != nil {
		return 0, errors.New("push request rejected")
	}
	response, err := webpush.SendNotificationWithContext(ctx, payload, &webpush.Subscription{Endpoint: subscription.Endpoint, Keys: webpush.Keys{P256dh: subscription.P256DH, Auth: subscription.Auth}}, &webpush.Options{
		HTTPClient: s.client, Subscriber: s.subject, VAPIDPublicKey: s.publicKey, VAPIDPrivateKey: s.privateKey,
		TTL: subscription.TTL, Topic: topic, Urgency: webpush.UrgencyNormal,
	})
	if err != nil {
		return 0, errors.New("push provider request failed")
	}
	if response == nil || response.Body == nil {
		return 0, errors.New("push provider request failed")
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 1024))
	return response.StatusCode, nil
}

func messageTopic(payload []byte) (string, error) {
	var envelope struct {
		Notification struct {
			Tag  string `json:"tag"`
			Data struct {
				Kind           string `json:"kind"`
				MessageID      string `json:"message_id"`
				CallID         string `json:"call_id"`
				ConversationID string `json:"conversation_id"`
			} `json:"data"`
		} `json:"notification"`
	}
	if err := json.Unmarshal(payload, &envelope); err != nil || envelope.Notification.Tag == "" {
		return "", errors.New("invalid push payload")
	}
	data := envelope.Notification.Data
	valid := (data.Kind == "message" && data.MessageID != "" && data.ConversationID != "") ||
		(data.Kind == "direct_call" && data.CallID != "" && data.ConversationID != "") ||
		(data.Kind == "group_call" && data.ConversationID != "")
	if !valid {
		return "", errors.New("invalid push payload")
	}
	digest := sha256.Sum256([]byte(envelope.Notification.Tag))
	return base64.RawURLEncoding.EncodeToString(digest[:])[:32], nil
}

func validEndpoint(parsed *url.URL) bool {
	if parsed == nil || parsed.Scheme != "https" || parsed.User != nil || parsed.Fragment != "" || parsed.RawQuery != "" {
		return false
	}
	if parsed.Port() != "" && parsed.Port() != "443" {
		return false
	}
	switch strings.ToLower(parsed.Hostname()) {
	case "fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com":
		return true
	}
	return false
}

func validVAPIDPair(publicEncoded, privateEncoded string) bool {
	public, err1 := base64.RawURLEncoding.DecodeString(publicEncoded)
	private, err2 := base64.RawURLEncoding.DecodeString(privateEncoded)
	if err1 != nil || err2 != nil || len(public) != 65 || public[0] != 4 || len(private) != 32 {
		return false
	}
	x, y := elliptic.Unmarshal(elliptic.P256(), public)
	if x == nil || !elliptic.P256().IsOnCurve(x, y) {
		return false
	}
	d := new(big.Int).SetBytes(private)
	if d.Sign() <= 0 || d.Cmp(elliptic.P256().Params().N) >= 0 {
		return false
	}
	expectedX, expectedY := elliptic.P256().ScalarBaseMult(private)
	return x.Cmp(expectedX) == 0 && y.Cmp(expectedY) == 0
}

type safeDialer struct {
	resolver Resolver
	dial     func(context.Context, string, string) (net.Conn, error)
}

func (d safeDialer) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil || port != "443" || !isAllowedHost(host) {
		return nil, errors.New("push destination rejected")
	}
	ips, err := d.resolver.LookupIP(ctx, "ip", host)
	if err != nil || len(ips) == 0 {
		return nil, errors.New("push destination lookup failed")
	}
	addresses := make([]netip.Addr, 0, len(ips))
	for _, ip := range ips {
		addr, ok := netip.AddrFromSlice(ip)
		if !ok {
			return nil, errors.New("push destination rejected")
		}
		addr = addr.Unmap()
		if !publicAddress(addr) {
			return nil, errors.New("push destination rejected")
		}
		addresses = append(addresses, addr)
	}
	var lastErr error
	for _, addr := range addresses {
		dial := d.dial
		if dial == nil {
			dial = (&net.Dialer{Timeout: 4 * time.Second}).DialContext
		}
		conn, dialErr := dial(ctx, "tcp", net.JoinHostPort(addr.String(), strconv.Itoa(443)))
		if dialErr == nil {
			return conn, nil
		}
		lastErr = dialErr
	}
	if lastErr != nil {
		return nil, errors.New("push destination connection failed")
	}
	return nil, errors.New("push destination connection failed")
}

func isAllowedHost(host string) bool {
	switch strings.ToLower(host) {
	case "fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com":
		return true
	}
	return false
}

func publicAddress(addr netip.Addr) bool {
	if !addr.IsValid() || !addr.IsGlobalUnicast() || addr.IsPrivate() || addr.IsLoopback() || addr.IsLinkLocalUnicast() || addr.IsLinkLocalMulticast() || addr.IsMulticast() || addr.IsUnspecified() {
		return false
	}
	for _, prefix := range []string{
		"0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16",
		"172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "192.168.0.0/16",
		"198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
		"::/96", "2001::/23", "2001:db8::/32", "2002::/16", "3fff::/20", "64:ff9b::/96", "64:ff9b:1::/48", "fec0::/10",
	} {
		if netip.MustParsePrefix(prefix).Contains(addr) {
			return false
		}
	}
	return true
}
