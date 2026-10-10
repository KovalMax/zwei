---
name: zwei-angular
description: Use when changing the Angular 22 frontend, TypeScript models, components, forms, services, routing, or browser-facing behavior in Zwei.
---

# Zwei Angular

## Baseline

The frontend is `frontend-app`, uses Angular 22, TypeScript 6, strict compiler settings, Angular Material, RxJS, and the existing NgModule-based application structure. Preserve that structure unless a migration is explicitly requested.

Use the repository's established formatting and import style in touched files. Do not introduce a second state-management, styling, or HTTP abstraction without a concrete feature need.

## TypeScript and Angular

- Keep strict typing enabled. Avoid `any`, non-null assertions, and unchecked casts; model nullable and error states explicitly.
- Use typed reactive forms and narrow API models. Keep wire names such as `device_id` at the API adapter boundary when the backend requires them.
- Keep components focused on presentation and user intent. Put HTTP, token storage, WebSocket, and reusable orchestration in injectable services/facades.
- Keep stateful WebSocket adapters injectable and test them with a factory fake: every reconnect obtains a fresh single-use ticket, uses bounded exponential backoff, filters malformed or incompatible events before state mutation, and does not create a socket after close wins a pending ticket response.
- Prefer `providedIn: 'root'` or the existing module provider convention consistently within a feature.
- Manage Observable lifetimes deliberately. Use `async` pipe or teardown-aware patterns; never leave subscriptions unmanaged.
- Keep templates accessible: labels, keyboard operation, meaningful status text, and correct error association.
- Treat loading, validation, empty, unauthorized, network failure, and retry states as separate UI states.
- At desktop widths, constrain readable content columns rather than spreading message/composer content across the viewport. Verify at least one large desktop viewport and the mobile breakpoint for layout changes.
- Before a visual change, write a state matrix covering the affected phase/state, dark and light themes, and 2560px/1440px/1024px/390x844 viewports. Treat each supplied screenshot as a concrete state to reproduce, including loading, ringing, active, minimized, terminal, empty, and selected-conversation variants.
- Validate the rendered cascade, not only the stylesheet: inspect `getComputedStyle`, bounding boxes, `scrollWidth/clientWidth`, and overlap between adjacent controls. Fixed heights, flex growth, `overflow`, `position:absolute`, and mobile safe-area rules must have an explicit containment assertion.
- Keep visual changes state-local. A terminal status should not retain active-call diagnostics; an action surface must use the same theme surface as its card unless a deliberate divider/background is specified; scroll controls must not sit on the scroll edge when a separate gutter is available.
- Keep route guards/interceptors focused on transport concerns; authorization decisions remain explicit and testable.
- Do not put secrets in source, browser-visible configuration, or local storage without considering XSS and token lifetime risks.
- PWA service-worker integration uses Angular's supported `@angular/service-worker` module and production build configuration. Cache only versioned shell/static assets; API, auth, profile, message, ticket, WebSocket, and TURN data are network-only. Keep install/update behavior in an injected facade, offer installation only after authentication, make updates user-triggered, and show an accessible offline state without retaining private data in browser storage.
- Avoid large components and duplicated subscription/error handling. Extract a focused service or presentational component when a boundary becomes clear.
- WebRTC call state belongs in a Home-scoped injected facade: it owns media tracks, `RTCPeerConnection`, signal exchange, and teardown, while Home renders intent/state. Request caller microphone access before `call.start`, recipient access only after Accept, queue an early offer/candidate until the recipient peer connection exists, stop every track and close the connection on every terminal route, and never persist SDP, ICE candidates, or TURN credentials. Cover permission denial, accepted offer/answer, mute, terminal cleanup, and malformed events with deterministic browser-API mocks.
- Remote WebRTC audio must be attached to an autoplay/inline audio element and explicitly played after its media metadata is available. Treat browser autoplay rejection separately from call transport failure: retain the active call, show an accessible user-gesture “Enable sound” recovery action, and clear the media element on terminal cleanup.
- The Home-scoped call facade owns audio-device enumeration after permission, input switching through `RTCRtpSender.replaceTrack`, and optional Chrome output switching through `HTMLMediaElement.setSinkId`. Keep device selectors keyboard-accessible, disable unsupported output selection without breaking default playback, and show connection, microphone, and speaker state separately from the call phase. While a call is connecting or active, replace message history and composer with the focused call surface; restore chat controls after terminal cleanup. Stack the full call card as contact, connection, device, and action rows with selected-theme surfaces and sign-in-style controls; resolve and select the incoming caller conversation from its authorized conversation ID even when no conversation was selected, including after the conversation list finishes loading.
- On narrow call surfaces, keep primary actions such as mute and end-call in a bottom control bar, make the diagnostics surface scrollable behind it, preserve safe-area padding, and assert that controls fit within the mobile viewport in browser tests. Collapse multi-column diagnostic meters before medium-width content can overflow.
- Keep mobile call actions in normal layout flow below a dedicated scrollable call-content region; avoid reserving artificial bottom padding that creates an empty scroll tail. Explicitly theme the action bar and device controls for light mode.
- For minimized active calls, keep WebRTC ownership in the Home-scoped call facade, keep elapsed duration in the Home presentation state, allow conversation navigation without ending the call, and provide a persistent accessible restore/end indicator wherever the user can browse conversations.
- Keep full-call cards bounded by the available call surface; scroll diagnostics/content inside the card while keeping the action row visible. Prefer a compact accessible icon control at the card edge for collapsing the full call surface instead of adding another large action-grid button.
- Place collapse/expand controls outside the content-scroll gutter and reserve space so they cannot overlap the profile or first content row. Verify their rectangle against the scroll surface and caller profile at the mobile breakpoint.
- Read/unread state is user-scoped across browser devices. Validate `conversation.read` payloads at the WebSocket boundary, use its reader identity to distinguish local global-unread updates from peer read markers, and keep delivery/replay state device-scoped.
- Registration responses contain only the memory-held access token; the refresh token arrives as a credentialed `HttpOnly` cookie. Accept the token through `AuthService`, navigate to Home, and never persist or model the refresh token in Angular JSON types.
- Ordinary KYC registration returns an explicit pending state and must navigate to a waiting/activation explanation without accepting a token. Invitation registration is the only registration path that immediately accepts a token. The `kyc` host should reuse Angular auth/theme infrastructure while the admin guard checks the server-side admin API; frontend route hiding is never the authorization boundary.
- KYC account actions show resend only for active, unverified users. Keep the resend control keyboard-accessible with an explicit label/title, disable it while the request is pending, and surface both delivery success and failure without exposing the activation token. Verify the control in the bounded table's desktop and horizontally scrolled mobile states in both themes.

## Call Presentation and Screen Sharing

- Keep the focused call card task-oriented: peer identity, duration, microphone/speaker selectors, screen-share quality, and primary actions. Do not surface packet counters, jitter, ICE state, or live WebRTC meters in the normal call UI; those belong in diagnostics tooling, not the user flow.
- Screen sharing remains ephemeral browser media owned by the Home-scoped `CallFacade`. Use `getDisplayMedia` with bounded 360p/720p/1080p/2K (2560x1440) constraints, renegotiate through the existing authorized `call.signal` path, stop tracks on user/browser termination and route teardown, and never record, persist, or log captured media. System audio is explicit opt-in: request it only when selected, tolerate browsers returning no audio track, send it through a distinct screen-audio sender, remove and renegotiate that sender independently, and merge separately delivered remote audio tracks into the playback stream.
- Repeated screen-share cycles must serialize local renegotiation, disable the share control during the transition, send explicit start/stop lifecycle markers, and preserve reusable remote receiver-track ownership so a peer's second share renders again. Cover first remote playback, stop cleanup, and a later restart with a browser assertion and screenshot.
- Fence all asynchronous media, device, readiness, and signaling callbacks with a call generation. Queue browser track termination through the same renegotiation chain as user actions, queue ICE until a remote description exists, handle polite offer collisions with a follow-up offer, and bound correlated signal-request bookkeeping.
- For responsive screen-share surfaces, assert document and stage horizontal containment, video rectangle containment, a non-background remote frame after restart, and that the last mobile content control is above the sticky action bar after scrolling to the end. A passing `readyState` alone is not proof that the restarted video is visibly rendering.
- Render the local preview and remote shared video only while a screen track exists. Keep share/stop controls, quality selection, device selectors, timer, and end/mute actions keyboard-visible and contained at desktop, medium, and mobile widths.

## Testing

- Unit-test component behavior through visible inputs/outputs and user actions, not private implementation details.
- Test forms for validation, disabled/loading behavior, success navigation, and expected API failures.
- Test services with deterministic mocks for HTTP, storage, router, and time.
- For every UI fix, add a browser-level assertion for the user-visible invariant and inspect the captured screenshot or trace for the changed state. Prefer deterministic geometry/style assertions over broad snapshots when the repository has no visual-baseline system; do not declare success from unit tests and a production build alone.
- After every Playwright run, retain and inspect screenshots for the affected passing states, not only failure screenshots. Check light and dark theme surfaces/text contrast, visible controls, focus, empty/loading/error states, and responsive containment. For tables/lists, capture the top and scrolled-end states and verify the first and last data/empty elements are visible, the sticky header remains in view, and the scroll container does not clip or overlap neighboring content.
- Exercise state transitions, not just initial rendering: call notifications must cover incoming/ringing/active/minimized/restored/ended/error, and read-state coverage must prove badge visibility, clearing, and peer-marker propagation.
- Run frontend builds and tests through local Docker-backed Make targets; do not require host Node/npm. Focused specs use the already-running frontend container and full tests use that container. GitHub Actions runs npm commands directly on hosted runners.

```sh
make frontend-spec SPEC=src/app/home/home.component.spec.ts
make -C infrastructure frontend-test
make frontend-build
```

- Run browser flows through the isolated Docker E2E setup:

```sh
make e2e
# Focused browser case:
make e2e-one SPEC=tests/kyc-flow.spec.ts TEST='pending registration, admin approval, activation email, and blocked login'
```

If a command differs in the current package scripts, inspect `package.json` and use the available equivalent rather than inventing a script.

- Admin/KYC browser coverage must include unauthenticated and non-admin denial, pending registration, manual activation, activation-email link consumption, invitation success/failure/reuse, blocking, sign-out, light/dark theme, and desktop/mobile containment. Rebuild frontend and E2E images before running the flow because both are copied into Docker images.
- Admin data tables must have an explicitly bounded inner scroll region with sticky headings and contained horizontal overflow; do not let a long account list expand the route shell and hide secondary views. Host-aware shared pages such as Profile must return to the current bounded context (`/admin` on KYC, `/home` on chat).

## Browser Coverage Baseline

Keep Playwright coverage for registration and login happy/error paths, authenticated header/menu visibility, profile navigation, sign-out, conversation empty/selected states, bidirectional live messaging, restored history, and wide desktop layout constraints. Rebuild the `frontend` and `e2e` Docker images before E2E when source is copied into container images.
