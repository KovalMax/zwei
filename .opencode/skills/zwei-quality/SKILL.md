---
name: zwei-quality
description: Use when verifying a Zwei change, reviewing maintainability, preparing a pull request, or deciding which tests and static-analysis tools to run across Go, Angular, infrastructure, and Playwright.
---

# Zwei Quality

## Workspace Path Safety

- Treat the shell's current `pwd` as the only authoritative workspace location.
- Prefer relative paths and omit an explicit `workdir` when the command can run from the current workspace.
- Never copy an absolute repository path from stale tool output, screenshots, prior sessions, or another machine. If it differs from `pwd`, treat it as invalid rather than probing or requesting external-directory access.

## Angular Test Setup

Angular 22 discovers `src/**/*.spec.ts` directly. The Karma target loads `src/polyfills.ts` and `zone.js/testing`; do not restore the removed Webpack `require.context` bootstrap. Component smoke tests import `AppModule` to obtain the production provider graph, but feature work must add focused behavior tests with deterministic mocks.

For frontend/E2E source copied into Docker images, rebuild `frontend` and `e2e`, recreate the frontend service, and wait for Angular compilation before `make e2e`. The isolated E2E Compose overlay uses PostgreSQL `messenger_test` and Redis DB 1; `e2e.sh` clears only DB 1 before each suite so persisted development rate-limit/ticket keys cannot make a subsequent run flaky.

## Verification Order

1. Inspect the diff and changed dependency boundaries.
2. Format changed Go and TypeScript files using repository tooling.
3. Run focused unit tests for the changed package.
4. Run Go static checks and all Go tests.
5. Run the Angular production build and frontend tests for frontend changes.
6. Run Playwright E2E when the change crosses HTTP, WebSocket, persistence, authentication, or visible user behavior.
7. Review logs, error mapping, security exposure, migration compatibility, and shutdown behavior.

For realtime transport changes, run the focused Go WebSocket upgrade tests and focused Angular transport tests before the broad suites. The focused checks must cover ticket purpose/expiry/single-use, origin and connection-budget outcomes, frame-size/type errors, fresh-ticket reconnects, bounded backoff, malformed-event filtering, and close-before-ticket-response lifecycle behavior.

For KYC/admin changes, verify migration reruns are safe in both local and production migration paths, prove pending versus invitation registration through HTTPS Playwright flows, retrieve the activation email from the local test SMTP sink, and assert one-time activation, admin/non-admin authorization, source-IP rejection, blocking/session revocation, sign-out, theme, and mobile containment. Keep the user-facing activation page URL separate from the auth-service verification API URL, and add a release probe for the auth-host activation route. When Traefik Basic Auth is added, assert an unauthenticated KYC shell request returns `401` and keep bearer-token API verification separate. Run the pinned Go vulnerability scan after adding SMTP/terminal dependencies.

For KYC activation resend, assert through the application test that the stored hash and expiry rotate, and through HTTPS/Mailpit that the old link fails, the new link activates once, and the resend control is limited to active/unverified accounts. Capture and inspect dark/light desktop and mobile action states, including the table's top/end and horizontal-scroll containment.

For browser-visible changes, add a visual verification pass before broad checks. Reproduce each reported screenshot at its theme, call/message phase, and viewport; inspect the rendered screenshot/trace plus computed geometry. Assert containment and state transitions directly instead of assuming a passing interaction proves layout quality. At minimum, check no horizontal overflow, no overlap between controls/content, correct light/dark surfaces and text, mobile viewport containment, terminal-state copy, and keyboard-visible focus.

For screen-share lifecycle changes, assert the remote video is active on the first share, disappears after stop, and becomes active again after a later start. Use a readiness poll for browser frame state, retain the restart screenshot, and inspect it together with the active dark/light and mobile call artifacts.

For realtime call reliability changes, also cover recipient disconnect cleanup, caller/recipient socket ownership across same-device tabs, stale readiness/call events after reconnect, queued ICE, signaling failure cleanup, late display-stream resolution/rejection, and local call-event ordering. When full E2E is repeated against the shared local edge, allow the configured auth rate-limit window to expire before rerunning; do not weaken the browser assertions to hide a 429 setup failure.

## Post-E2E Screenshot Review

- Playwright runs must retain screenshots for passing browser-visible flows as well as failures. Review the saved image artifacts after the run; do not treat a green test result as proof that CSS, theme, or responsive layout is correct. Use the repository's configured `test-results` artifact location or explicit `page.screenshot({path})` files, and do not commit generated screenshots.
- For each changed visual surface, review at least one light-theme and one dark-theme screenshot at the relevant desktop and mobile viewports. Confirm that the page/card surface, text, borders, controls, focus state, empty/loading/error state, and responsive content are visible and have sufficient contrast without clipping or overlap.
- For every table or long list, capture and inspect both the initial/top state and the scrolled-to-end state. Assert the first data row (or empty state) is visible before scrolling, the last data row is visible after scrolling to the end, the sticky heading remains visible, and the table's vertical/horizontal scroll region stays inside the viewport. Include the scroll container's `scrollTop`, `scrollHeight`, `clientHeight`, `scrollWidth`, and `clientWidth` in the browser assertion when the list is relevant.
- Record which screenshot artifacts were inspected and any visual defect or limitation in the iteration/verification summary.

For rate-limit or edge changes, include a running HTTPS verification that asserts the expected status and `Retry-After` behavior; local middleware or Compose validation alone does not prove the deployed route is enforcing the control.

## Local Docker commands and hosted CI

Use Docker-backed Make targets for all local application, build, and test commands; do not require host Go or Node/npm. `make format`, `make lint`, `make test`, `make frontend-spec`, `make -C infrastructure frontend-test`, `make frontend-build`, `make e2e`, and `make e2e-one` run through the local Compose services. Use `make exec <service> <command...>` for checks without a dedicated target. Preserve the isolated E2E database/Redis setup and service teardown behavior.

The following are commands run by GitHub-hosted workflows, not the supported host-local workflow:

```sh
# Go CI/security
go fmt ./services/...
go vet ./services/...
go test -race ./services/...
go mod verify
GOTOOLCHAIN=go1.26.9 go run golang.org/x/vuln/cmd/govulncheck@v1.1.4 ./services/...

# Angular CI (Node 24)
cd frontend-app && npm run build -- --configuration production
cd frontend-app && npm test -- --coverage

# npm security audits on a GitHub-hosted runner (frontend-app and e2e lockfiles)
cd frontend-app && npm audit --audit-level=high
cd e2e && npm audit --audit-level=high

# Playwright is executed against the Compose stack
make e2e
```

## Security CI

`.github/workflows/security.yml` runs checksum verification, a pinned Go vulnerability scan, and npm audits on pull requests and pushes to `main`. `.github/workflows/ci.yml` runs Go formatting/vet/race tests with migrated PostgreSQL/Redis integration dependencies, Angular headless coverage tests and production build, then Playwright E2E with failure artifacts. Angular coverage is enabled in `angular.json`; CI must fail if the artifact is absent. Keep the scanner version/toolchain explicit and update it deliberately; scan `./services/...` so frontend dependency fixtures are not treated as Go packages.

`.github/workflows/release.yml` runs on published GitHub Releases, builds/publishes ARM64 images to GHCR, and deploys through strict-host-key SSH to a VM using the separate `infrastructure/production/` Compose setup. Preserve the distinction between local Compose and production Compose and never document secret values.

When npm advisories affect transitive build tooling, prefer a reviewed `overrides` entry pinned to a patched release and regenerate the lockfile. Do not suppress an advisory or lower `--audit-level=high`; document when an upstream package has no patched release and remove the vulnerable dependency path where possible.

For production browser permissions and security headers, verify the public HTTPS response after deployment. The release gate must require `Permissions-Policy: geolocation=(), microphone=(self), camera=()` and reject stale CSP origins such as removed external font hosts; local configuration tests alone do not prove the deployed edge was synchronized.

## Review Gates

- No behavior change without a regression test or a clear reason testing is not possible.
- No UI change without a state-specific browser check or documented reason a browser check cannot be run. A unit test, TypeScript compile, or production build does not validate CSS layout, responsive flow, theme cascade, or stale terminal content.
- No domain/application import of infrastructure or transport.
- No ignored errors, leaked credentials, sensitive logs, or unsafe protocol parsing.
- No unbounded goroutine, subscription, queue, or WebSocket lifecycle.
- No durable delivery cursor may advance on a rejected socket enqueue; verify this with queue-failure and partial-replay tests rather than only a happy-path browser flow.
- No flaky time, random, network, or browser dependency in a unit test.
- Migrations are forward-compatible with the deployed application and have a rollback/data-risk assessment.
- CI remains reproducible and uses the same meaningful checks as local development.
- When a visual E2E fails intermittently during container startup, rerun the focused scenario and then the full suite once; record the flake rather than weakening or deleting the visual assertion.

## Maintainability Review

Prefer removing duplication and clarifying ownership over adding abstractions. Flag functions with mixed transport/business/persistence responsibilities, interfaces that are too broad, domain objects that are passive bags when invariants exist, and tests that assert implementation details instead of behavior.
