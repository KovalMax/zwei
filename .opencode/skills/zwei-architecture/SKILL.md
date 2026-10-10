---
name: zwei-architecture
description: Use when designing, changing, or reviewing Zwei features, service boundaries, domain models, or package dependencies; enforce clean code, DDD, and hexagonal architecture for the Go services and Angular client.
---

# Zwei Architecture

## Project Context

Zwei is a private, server-mediated direct and small-group messaging application; it is not end-to-end encrypted. Groups support up to 16 active members and group audio calls support up to four participants. The repository contains:

- `services/auth`: registration, login, sessions, profiles, and token issuance.
- `services/chat`: conversations, message history, and chat HTTP APIs.
- `services/realtime`: authenticated WebSocket connections and message fan-out.
- `services/shared`: deliberately small cross-service contracts and infrastructure-neutral helpers.
- `frontend-app`: Angular 22 browser client.
- `e2e`: Playwright browser tests.
- `migrations`: PostgreSQL schema changes.
- `infrastructure`: Docker Compose, Traefik, local TLS, and operational scripts.

No generic worker service exists. Add a background process only for a concrete bounded use case with explicit durable inputs, retry/claim behavior, shutdown ownership, and tests; do not add a periodic no-op process.

Read the relevant service and its tests before editing. Do not infer behavior from a filename alone.

## Dependency Direction

Keep dependencies pointing inward:

1. Transport adapters translate HTTP/WebSocket/framework input into application commands and map errors to protocol responses.
2. Application services orchestrate use cases and depend on ports, not concrete databases, crypto libraries, clocks, or network clients.
3. Domain packages own business invariants, value semantics, domain errors, and aggregate behavior. They must not import transport, SQL, Angular, or infrastructure packages.
4. Infrastructure adapters implement application ports and contain SQL, JWT, bcrypt, WebSocket, filesystem, and external-service details.

The composition root in each service wires concrete adapters into application services. Never make a domain or application package construct its own adapter.

## DDD Rules

- Model behavior and invariants in domain types rather than exposing mutable data bags.
- Name use cases after business intent, such as `Register`, `RotateRefreshToken`, or `SendMessage`.
- Keep aggregate boundaries explicit. Do not load or mutate unrelated aggregates through a single method just for convenience.
- Treat IDs, timestamps, tokens, retention policies, and protocol event types as meaningful concepts when validation or behavior warrants it.
- Keep DTOs at transport boundaries. Do not leak SQL rows or framework request objects into domain code.
- Return typed/sentinel errors for expected business outcomes; preserve unexpected infrastructure errors for observability and correct mapping.

## Clean Code

- Prefer small functions with one reason to change and names that explain intent.
- Keep validation close to the boundary where malformed input enters, and keep business invariants in the domain/application layer.
- Avoid speculative abstractions, generic helpers, global mutable state, and interfaces with only accidental methods.
- Make concurrency ownership and lifecycle explicit. Protect shared state and define shutdown behavior.
- Preserve existing public behavior unless the task explicitly changes it. Add or update tests with every behavior change.

## Frontend Boundaries

Organize new Angular features by business capability rather than by framework primitive. A feature may contain presentation components, typed API/facade services, state, and domain-facing models. Keep HTTP, WebSocket, storage, and router details behind adapters/facades so components focus on UI state and user intent.

Prefer typed request/response models, strict forms, immutable state transitions, and explicit loading/error/empty states. Components must not duplicate authentication, authorization, transport serialization, or domain rules.

## Browser Sessions

- Access tokens are memory-only. Never persist an access or refresh token in `localStorage`, session storage, IndexedDB, or client-visible JSON.
- Auth login and refresh rotation issue the `zwei_refresh` cookie as `HttpOnly`, `Secure`, `SameSite=None`, and path-scoped to `/api/auth`; cross-origin refresh/logout calls require `withCredentials: true` and credentialed CORS.
- Protected-route guards and auth-route resolvers restore the access token through the refresh endpoint. Share and cache the page-lifecycle restore outcome across them so an anonymous redirect cannot rotate or request refresh twice; do not add a competing app-bootstrap refresh request, because refresh rotation is single-use.
- Logout must send the current access token to revoke server sessions, clear local access state, wait for the response that clears the cookie, then navigate.
- Registration creates the initial device session and returns the access token once; set the refresh token only as the restricted `HttpOnly` cookie, omit it entirely from JSON, and route the newly registered browser directly to the authenticated surface without a second login.
- KYC registration is an explicit exception to the automatic-session rule: ordinary registrations create `pending` users and return a pending response without a session; invitation registrations are single-use, email-bound, and create active verified users with the normal initial session. Administrative activation is a user-lifecycle use case in `services/auth`, not a separate generic service.
- The KYC host uses the existing Angular build and auth service. Admin APIs must enforce both persisted administrator authorization and a source-IP allowlist. Behind Traefik, only the private proxy may reach the auth container; forwarded client addresses must never be trusted if the service is directly published.
- Traefik Basic Auth may gate the KYC frontend shell with a VM-owned htpasswd file, but do not blindly apply it to Angular bearer-token API routes: a browser `Authorization: Basic` challenge conflicts with the app's `Authorization: Bearer` header. Keep `/api/auth` and `/api/admin` protected by the application admin/IP controls unless a separate header-forwarding design is introduced.
- Activation links and invitation codes are bearer credentials: persist only cryptographic hashes, bind them to an account/email, expire them, consume them atomically, and never log or return activation tokens after the email response. SMTP is an injected application port, not a domain dependency.
- KYC activation resend remains part of the `services/auth` lifecycle use case: expose it only through the existing admin bearer/IP checks, allow only active and unverified targets, atomically replace the stored hash and expiry, and send a newly generated token through the SMTP port. The old link must fail after rotation, and the API must return no bearer value.
- Browser WebSocket APIs cannot set authorization headers. Use a signed, purpose-bound WebSocket ticket with a 30-second lifetime, consume it atomically through Redis before socket upgrade, and only store a cryptographic hash in Redis. Never log a ticket or its request URL.
- WebSocket transport adapters must be tested through real HTTP upgrade boundaries: reject invalid, expired, and wrong-purpose tickets; enforce the explicit origin allowlist and shared connection budget; release a lease when upgrade fails; and close unsupported, malformed, or oversized frames without leaking ticket values. Client reconnects must request a new ticket for every attempt and stop cleanly during pending ticket requests.
- Edge routes require CSP, anti-framing, MIME-sniffing, referrer, permissions, and cross-origin isolation headers. Keep CSP origins explicit; Angular Material currently needs `style-src 'unsafe-inline'`. Typography is bundled from local npm font packages and application icons are inline SVG through `ZweiIconComponent`; do not reintroduce external font/icon sources or relax CSP for Google Fonts. Scripts must remain self-only. Apply auth/search/chat HTTP request limits at the edge for source-IP protection, and keep authenticated chat limits, realtime command limits, and concurrent WebSocket budgets in Redis for cross-replica enforcement. Fail closed when the shared limiter is unavailable and release/renew socket leases explicitly.

## Ephemeral Realtime State

Presence and typing are ephemeral transport concerns: never persist them in PostgreSQL message tables. Filter all presence and typing events to authorized conversation peers, use explicit typed WebSocket events, rate-limit typing starts, expire remote typing state, and distinguish peer state from local socket health in the client. Redis presence uses TTL heartbeats plus immediate clean-disconnect removal. Presence, typing, conversation-created, and message-created events fan out through Redis; PostgreSQL history/outbox remains the durable recovery source.

`message_delivery` is per recipient device and is the durable recovery source for offline messages. On authenticated socket connection, replay pending rows as normal `message.created` events and mark them delivered only after the socket explicitly accepts the event into its send queue; a full/closed queue must leave the row pending for replay. `delivered_at` means server-side socket enqueue, never user read or a client receipt. Reconnects must obtain a fresh single-use ticket and use bounded exponential backoff.

Read cursors are separate from delivery: `user_read_cursors` records one monotonic highest loaded sequence per user and authorized conversation. Cap reported sequences to persisted messages, never let a client move a cursor backward, and fan the resulting cursor event to every connected device of the reader and peer. If conversation-list unread counts are denormalized on this row, increment them in the same message transaction for the recipient and recompute them when a cursor advances; preserve monotonic cursor and count semantics under concurrent send/read transactions. UI must describe this as conversation-loaded/read state, not a verified user-attention guarantee. `message_delivery` remains per recipient device because server-side socket enqueue and user read state are different guarantees.

Audio calls are an ephemeral realtime capability, not messages or durable call records. WebSocket carries only authorized, versioned call-control and WebRTC signaling events; media never traverses Go services. Keep shared call reservation, first-accept-wins device selection, ring/active expiry, disconnect cleanup, and cross-replica fan-out in Redis through an application port. Signal SDP/ICE and TURN credentials are sensitive: bound their size, route them only to the participating device, and never log or persist them. Coturn uses a deployment-only shared secret and direct UDP relay ports, not Traefik; issue its REST credentials per call/user with a lifetime no longer than the call. The Home-scoped media adapter owns device enumeration, input `replaceTrack`, and optional output `setSinkId`; UI connection labels must distinguish permission, ICE/peer connection, capture, and speaker playback states. Do not add call history, recording, or a generic worker without a separate product decision.

Call reservations are owned by an opaque WebSocket connection as well as the authenticated device. Persist connection ownership only in internal Redis/application state; carry it through internal pub/sub fan-out metadata without exposing it in client call payloads. Route accepted/active signaling to the owning socket, reject same-device sibling sockets from injecting signaling, disconnect presence before recipient ringing cleanup, and deliver local call events before publishing them so a local caller cannot miss `call.ringing` before `call.accepted`.

Screen sharing is the same ephemeral media capability: capture stays browser-local, quality presets are bounded to 360p/720p/1080p/2K (2560x1440), media renegotiation uses the existing authorized call signal port, and browser/user track termination must remove the sender and renegotiate. Each start/stop cycle may also carry a typed lifecycle marker so a peer can clear or restore presentation state without stopping a reusable receiver track. Validate these markers and SDP/ICE shapes at the Go and TypeScript transport boundaries. Do not persist, log, or route captured screen content through Go services.

For call diagnostics, log accepted commands, rejected business outcomes, emitted terminal events, disconnect cleanup, and fan-out failures at the realtime application boundary. Include identifiers and bounded reason categories only; do not log raw adapter errors or signaling contents.

Use shared semantic tokens for new color, focus, motion, radius, spacing, and elevation values rather than adding another hard-coded variant. All interactive controls need visible keyboard-only focus: custom controls use the shared outline, while Angular Material fields retain their native focus/error outline. `prefers-reduced-motion` must suppress repeating animation and nonessential transitions. Keep responsive checks focused on the actual task surface.

Client sends are independently correlated by `request_id` and `client_message_id`. Do not introduce a global composer lock: provisional message UI, acknowledgement timeouts, acceptance, and rejection must each resolve only their matching pending request.

Wire-to-UI conversion belongs in a typed mapper at the transport boundary, not in components. Validate required identifiers and sequences there, filter malformed messages before state mutation, and keep API history and WebSocket message conversion on the same mapping path.

`protocol/websocket/v1.json` is the shared source of truth for WebSocket event names and required fields. Commands and events must include `version: 1`; reject incompatible commands and discard incompatible events at transport boundaries. Introduce a new version through a new contract artifact and explicit compatibility policy.

Angular transport adapters must be injected rather than constructed in components. Scope a stateful socket adapter to the component when its close lifecycle must reset on route exit; use root scope only when state is intentionally shared across features.

For durable cross-service user-visible events, write an outbox record in the same transaction as the source state change. Consumers must claim pending records with locking, mark successful claims, and send a typed client event that causes the recipient to refresh only authorized data. Do not use in-memory calls or best-effort notifications as the source of truth.

## Change Checklist

- Identify the use case and its owning bounded context.
- State the dependency direction before adding a package or import.
- Add or update a port if the use case needs an external capability.
- Implement the adapter separately from the use case.
- Test domain invariants and application orchestration without real infrastructure.
- Test adapter behavior at its boundary and add an E2E test for user-visible flows.
- Check for accidental cross-service imports, leakage of secrets, and backwards-incompatible protocol changes.
