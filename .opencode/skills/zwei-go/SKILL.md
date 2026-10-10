---
name: zwei-go
description: Use when writing, refactoring, testing, or reviewing Go code in Zwei services; apply idiomatic Go 1.26 practices, concurrency safety, error handling, and maintainable service layering.
---

# Zwei Go

## Repository Conventions

- Module: `github.com/KovalMax/zwei`.
- Go source lives below `services/`; use the existing `internal/domain`, `internal/application`, `internal/infrastructure`, and `internal/transport` structure.
- Run `gofmt` on changed Go files. Keep imports gofmt/goimports-compatible and use standard library packages before module imports.
- Follow existing constructor injection and small application interfaces. Ports belong with the consuming application layer.

## Implementation Rules

- Pass `context.Context` as the first parameter for I/O and potentially long-running operations. Honor cancellation and deadlines.
- Configure bounded HTTP request/response timeouts at composition roots; WebSocket upgrade servers may bound only the handshake and must not apply finite write deadlines to hijacked sockets.
- Wrap errors with operation context using `%w` when callers need the cause. Compare expected errors with `errors.Is` or `errors.As`.
- Do not expose passwords, raw refresh tokens, JWT secrets, message plaintext, or connection details in logs or errors.
- Realtime call lifecycle logs may include call/user/device/request identifiers, command/event names, status, source, and a bounded business-error reason. Never log SDP/ICE payloads, TURN credentials, ticket values, or raw infrastructure errors; classify unexpected adapter failures as `internal`.
- Realtime call reservations must bind cleanup and signaling authorization to the opaque socket connection, not only the shared device ID. Disconnect presence before ending a ringing recipient reservation, and keep connection-owner fields out of client JSON while preserving them in internal pub/sub envelopes.
- Realtime call-signal validation must reject unknown shapes before routing. Accept only non-empty SDP for offers/answers, object-shaped ICE candidates, and payload-free screen-share lifecycle markers; never log or persist any signal value.
- Validate untrusted HTTP/WebSocket input before invoking a use case. Normalize once at a defined boundary.
- Use `time.Time` and injected clocks for behavior that must be deterministic in tests.
- Avoid `panic` in request paths. Return errors and let the composition root decide fatal startup behavior.
- Make ownership of goroutines, channels, maps, and connections explicit. Use mutexes or channel ownership consistently; never rely on a race-free appearance.
- Treat realtime socket enqueue as an explicit outcome: delivery adapters must report queue admission, and `message_delivery.delivered_at` may advance only after admission succeeds. Retain pending rows when a socket is full, closed, or cannot marshal the event.
- Close response bodies, rows, transactions, sockets, and other resources on every path.
- Prefer concrete types internally; introduce interfaces at I/O boundaries or where tests need substitution.
- Keep JSON tags and wire event names stable. Treat protocol changes as compatibility-sensitive.
- Account lifecycle controls must revoke session versions when blocking users. Admin IP allowlists must fail closed, parse CIDRs with `net/netip`, and only trust forwarded client addresses behind a private, controlled proxy. CLI password prompts must avoid process arguments and hide terminal input when possible.
- Bearer activation/invitation values must be generated with `crypto/rand`, stored only as hashes, consumed atomically in PostgreSQL, and excluded from logs/errors. External email delivery belongs behind an application port with bounded context cancellation and an infrastructure adapter.
- Activation resend is an auth application use case: rotate the hash and expiry in one repository update only for an active, unverified account, send the fresh raw token through `EmailSender`, and return no token from the HTTP handler. Test that the old token no longer verifies and the injected-clock expiry is renewed.

## Tests

- Table-test domain validation and edge cases.
- Unit-test application services with fakes for ports; verify calls, arguments, and error propagation.
- Test repository and transport adapters against their actual boundary where practical.
- Include cancellation, duplicate/idempotent requests, authorization, malformed input, and concurrent access cases where relevant.
- For durable realtime delivery, test queue rejection and partial replay batches so only successfully enqueued messages are marked delivered; add an integration test for atomic single-use WebSocket ticket consumption.
- Exercise the WebSocket adapter over `httptest` plus a real Gorilla client for invalid/expired/purpose tickets, origin denial, budget overflow and lease release, unsupported/bad/oversized frames, and bounded upgrade behavior. Protect the socket queue admission/close boundary with explicit synchronization so a concurrent close cannot mark an event delivered after it was rejected.
- Run race detection for concurrency-sensitive code: `go test -race ./services/...`.

## Quality Commands

Use the Docker-backed Make targets for local work; do not require a host Go installation. Run the full commands through a container:

```sh
make format
make lint
make test
make exec auth sh -lc 'go test -race ./services/...'
```

GitHub-hosted CI runs Go formatting, vet, and race tests directly on runners with PostgreSQL/Redis supplied by Compose. The security workflow runs `go mod verify` and the pinned `govulncheck`. Do not add a tool to the repository merely to silence a finding; fix the design or document a justified suppression.
