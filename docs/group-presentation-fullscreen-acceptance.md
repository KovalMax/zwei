# Group presentation fullscreen acceptance

Implementation evidence for the PM/TL-approved group-call presentation plan.

## Preserved baseline

Captured from the real HTTPS application before CSS edits:

| Viewport | Group full-call card | Parent gutters | Presentation section | Video |
| --- | --- | --- | --- | --- |
| 1440×900 | 720×715, radius 28px | 12–20px | 650×135 | 648×97 |
| 390×844 | mobile card radius 18px | 12px | 320×79 | 318×41 |

The direct-call reference was approximately 720×696 at 1440×900, with a 720px max width, `clamp(620px, 78vh, 760px)` height, 42px maximum padding, and 28px radius. Group presentation video was limited to 96px desktop / 40px mobile. Baseline reproduced in the real HTTPS app before changes; no temporary baseline logger is retained.

## Implemented contract

- Group-list exhaustion is still driven by the same cursor/pagination state and keeps its one `role="status"` completion announcement. It is visually clipped to the shared `.visually-hidden` utility.
- Browser fullscreen is a local DOM concern of `GroupCallSurfaceComponent`; actual state mirrors `document.fullscreenElement` on `fullscreenchange`. The stage has a labelled fullscreen/exit control, handles Escape and explicit exit, attempts exit on component teardown, hides the control when the Fullscreen API is unavailable, and announces denied requests without changing call state.
- The group and direct full-call cards share the `--zwei-call-card-*` and panel-gutter tokens. Group card content remains internally scrollable and actions remain outside that scrolling region. The presentation is bounded at 280px desktop and 190px mobile with `object-fit: contain`; the stage itself fills the fullscreen viewport and keeps its heading/control visible.
- No Go, protocol, backend, persistence, or migration changes. `GroupCallFacade` remains the media owner; `GroupCallSurfaceComponent` remains presentation-only. The narrowly approved receiver-projection restoration is keyed by peer connection, local generation, room ID, and room generation.

## Acceptance evidence

Browser matrix: exhausted rail and active group presentation were checked in light/dark at 2560, 1440, 1024, and 390×844. Actual browser fullscreen was entered in both themes at all four widths. Every case asserted `document.fullscreenElement` is the stage, stage/video viewport containment, and a visible heading and fullscreen control. Explicit exit and Escape are both exercised throughout the matrix. The deterministic group lifecycle also enters fullscreen before the presenter stops and asserts the stage is removed and fullscreen exits, then verifies same-room restart. Unit tests cover fullscreen API unsupported/denied behavior and call-state preservation.

The deterministic group-media browser flow asserts direct/group card width contracts within 8 CSS px; shared height, padding, and radius tokens; theme surfaces; stage/video containment and size; no horizontal overflow; content scroll extent; visible sticky actions; initial and restarted non-background remote frames; and fullscreen browser state. The latest full isolated suite passed 36/36 tests. Its root run-status marker is `e2e/test-results/.last-run.json` (`passed`); related group/media artifacts are under `e2e/test-results/2026-10-06T22-36-27-576Z/`:

- `e2e/test-results/2026-10-06T22-36-27-576Z/chat-flow-runs-a-determini-9e008-ember-group-media-lifecycle-chromium/group-call-remote-presentation-restarted-dark.png`
- `e2e/test-results/2026-10-06T22-36-27-576Z/chat-flow-runs-a-determini-9e008-ember-group-media-lifecycle-chromium/group-call-presentation-fullscreen-dark-2560.png`
- `e2e/test-results/2026-10-06T22-36-27-576Z/chat-flow-runs-a-determini-9e008-ember-group-media-lifecycle-chromium/group-call-presentation-fullscreen-light-1440.png`
- `e2e/test-results/2026-10-06T22-36-27-576Z/chat-flow-runs-a-determini-9e008-ember-group-media-lifecycle-chromium/group-call-presentation-fullscreen-dark-390.png`
- `e2e/test-results/2026-10-06T22-36-27-576Z/chat-flow-runs-a-determini-9e008-ember-group-media-lifecycle-chromium/group-call-presentation-fullscreen-light-390.png`
- `e2e/test-results/2026-10-06T22-36-27-576Z/chat-flow-runs-a-determini-9e008-ember-group-media-lifecycle-chromium/group-call-presentation-restarted-light-390.png`
- `e2e/test-results/2026-10-06T22-36-27-576Z/group-list-pagination-load-0f248-cross-theme-viewport-matrix-chromium/groups-dark-390x844-end.png`
- `e2e/test-results/2026-10-06T22-36-27-576Z/group-list-pagination-load-0f248-cross-theme-viewport-matrix-chromium/groups-light-390x844-end.png`

Visual review found the stage occupies the intended viewer area, video remains contained, heading/control remain visible in fullscreen, the restarted blue remote frame is visibly active, card/action surfaces have readable contrast in both themes, and the exhausted message is not rendered as a visible rail row. The fullscreen light/dark 390×844 artifacts show the complete stage without clipping; 2560px and 1440px artifacts show contained video and the visible toolbar. The restarted share was also captured after restoration in both themes at all four viewports. The group-call title wraps fully at mobile width; long call content scrolls independently while actions remain available. Pagination top/end screenshots show no row clipping or horizontal overflow.

Restart diagnosis and acceptance: previously, `presenter.stop` removed the visible projection while the browser reused the same video receiver/stream on the next start; without a second `ontrack`, the facade had no event to republish its projection. The facade now retains receiver-owned stream/track state across presenter stop, restores it only for the active matching presenter in the current peer connection/room generation, and discards it on peer removal, ended tracks, generation/room teardown, and close. The browser test proves initial frame → hidden on stop → same-room restart with a live non-background frame and fullscreen stage exit/removal on stop. The focused facade tests additionally cover restart without a second track event, sync-snapshot restoration, peer removal, and terminal cleanup.

## Verification results

- `make frontend-spec SPEC=src/app/home/group-call-facade.service.spec.ts` — 63 passed.
- `make frontend-spec SPEC=src/app/home/call-presentation/group-call-surface.component.spec.ts` — 6 passed.
- `make -C infrastructure frontend-test` — 31 spec files / 367 tests passed.
- `make frontend-build` — production build passed; the final `make e2e` also rebuilt the production bundle successfully.
- `make e2e-one SPEC=tests/chat-flow.spec.ts TEST='runs a deterministic three-member group media lifecycle'` — passed with restart/fullscreen matrix and screenshots above.
- `make e2e-one SPEC=tests/group-list-pagination.spec.ts` — passed.
- Final `make e2e` — 36/36 browser tests passed, no skips. Root run marker: `e2e/test-results/.last-run.json`; latest related group-call artifacts: `e2e/test-results/2026-10-06T22-36-27-576Z/`.

E2E runs were isolated by the repository setup script; development auth/chat/realtime services were recreated afterward. Passing screenshots above were inspected, not only failure artifacts.

## Final review follow-up (2026-10-06)

- The presenter identity-switch regression, fullscreen API absence behavior, initial/end device-control containment, direct/group card-width tolerance, row-alignment checks, and same-room restarted-share matrix were exercised in the final build.
- The latest full E2E run supersedes the historical failing attempt: 36/36 passed with no skips. Its root `.last-run.json` marker reports `passed`; group/call and search artifacts are under `e2e/test-results/2026-10-06T22-36-27-576Z/`, and README demo checkpoints/video under `e2e/test-results/2026-10-06T22-42-01-083Z/`.
- Removed fixed 700ms pagination settle sleeps; the browser flow now waits for the scroller to reach its end before checking row geometry. The focused pagination spec and group media lifecycle both passed on the same source as the final full run.
- After the first PR push, CI exposed timeout risk in account-heavy group visual coverage. Tooltip checks now poll effective rendered contrast instead of `Animation.finished`, preserving contrast/geometry/overlap assertions; an unnecessary direct `scrollTop` evaluation in group deletion setup was also removed while retaining the scroll, viewport, and deletion assertions. A later CI run showed the combined group/search test exceeded its 600-second budget, so the search matrix now runs independently with page-scoped synthetic responses; it retains selected-conversation, theme/viewport, scroll, focus-outline, and Enter activation assertions, and the group visual flow remains separate. The group test passed in 1.0 minute, the focused search matrix in seconds, and the final full local E2E passed 36/36 in 5.9 minutes. The CI E2E job and individual visual fixture retain finite timeouts.
- Final review sign-offs (2026-10-06): PM scope/acceptance, TL architecture/DoD, frontend, backend boundary (no BE changes required), QA, security, code review, and designer all approved. `git diff --check` passed. The accessible completion status is verified in the browser by its single visually hidden `role="status"` element and text; no assistive-technology session was run.
