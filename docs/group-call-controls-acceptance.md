# Group-call controls and recovery — acceptance

## Outcome and boundaries

Group settings now keep uniform vertical spacing between member cards regardless of role/action count. Group screen sharing provides an explicit, unchecked-by-default **Share audio** checkbox. The single group header call action discovers an authorized current room and joins it, or starts a room when none exists. Terminal notices are short-lived and scoped to their originating group; dismissing a notice does not discard a still-valid room rejoin capability.

Group conversations support up to 16 active members; an ephemeral group-call room intentionally supports at most four simultaneous participants. An additional join is rejected with a clear room-capacity message; members can continue using the group chat and retry after a participant leaves.

Frontend ownership stays within the Home calling boundary: `HomeComponent` owns selection-aware call orchestration, `GroupCallFacade` owns ephemeral room/media lifecycle, and `DataProviderService` validates the typed protocol. Realtime owns membership-authorized room discovery and existing group commands. Screen/system audio, SDP, ICE, TURN credentials, and socket connection IDs are not persisted or added to the discovery response. No database migration was required.

## Protocol and security

- Added `group.call.discover` and correlated `group.call.discovered` to the active WebSocket v2 contract. The nullable result provides only the selected conversation’s joinable room snapshot, including its generation/revision; it omits ICE servers and participant connection IDs. v1 direct-call compatibility is unchanged.
- Realtime checks current group membership before querying the Redis conversation index, rate-limits discovery, serializes against room/membership operations, and retires stale membership projections conditionally. Redis lookup verifies that the indexed room belongs to the requested conversation.
- The primary action performs discovery before asking for microphone permission. Server room creation remains authoritative if two callers both discover no room. Permission/discovery errors remain retryable.
- Group display audio is explicitly opt-in and defaults off. It uses a separate per-peer sender; no-audio browser results or later audio-track termination leave video sharing available. Capture tracks and senders are fenced by room generation and cleaned up on stop, track end, error, leave, and end. Presentation start/stop/audio/video-ended operations use one serialized queue.
- The short leave notice can survive a realtime disconnect without an expired generation suppressing its dismissal. Rejoinable room state is retained separately until superseded, ended, removed, or no longer authorized. Notices are hidden while another conversation is selected.

## Acceptance criteria

- Member-card gaps are equal within 1 CSS px across role/action combinations and verified at 2560×1440, 1440×900, 1024×900, and 390×844 in both themes.
- The group screen-share audio checkbox has a visible label, keyboard-visible focus, accessible state, and an unchecked default. Tests cover audio capture, unavailable audio, independent audio removal, video continuity, overlapping end/stop, and later share restart.
- The header’s **Join or start group audio call** action joins a discovered active room or starts one when discovery returns none. Rejoining through the same action is covered after leave, notice dismissal, microphone denial, and retry. There is no separate terminal-notice Rejoin action.
- Leave/end/error notices do not leak to an unrelated selected conversation or remain indefinitely after disconnect; valid rejoin state survives dismissal.
- Presentation quality and Share audio controls remain contained and do not overlap the fixed action area at 2560×1440 and 1024×900; quality options are inspectable at 1440×900 and 390×844 in light/dark.
- A genuine browser microphone-permission failure is captured and asserted at exactly 390×844.
- Existing direct-call system-audio behavior, group membership authorization, room generation/revision checks, ephemeral media ownership, and distinct room-wide End versus participant Leave remain intact.

## Verification

The following results are historical for this group-call-controls iteration; current release-gate totals are recorded in `docs/group-call-repair-acceptance.md`.

- Focused Angular coverage passed for group-call facade, Home, group-member list, device controls, group-call surface, and typed transport. Full Angular headless suite: **283 passed**.
- Angular production build passed. Existing `home.component.css` style budget warning remains 1.59 kB over the 30 kB warning limit; the budget was not changed.
- Full isolated Playwright suite: **25 passed, 0 failed**. Focused group handoff, media lifecycle, member-list viewport/theme, and direct-call offline-notice flows passed. The suite asserts no duplicate room start, selected-conversation notice scope, equal member gaps, actual mobile viewport dimensions, and selector/audio-control containment.
- Backend `go test ./services/...` and `go vet ./services/...` passed in the realtime container. Redis discovery-index integration passed using isolated Redis DB 15.
- At that time, `go test -race ./services/...` passed on host Go 1.26.6 with CGO; the runtime image itself had `CGO_ENABLED=0`, so race testing was performed on the host. The current complete Go vet/race integration gate passes as recorded in `docs/group-call-repair-acceptance.md`.
- `git diff --check` passed.

## Browser artifact review

Passing screenshots were retained under `e2e/test-results/2026-10-04T08-49-28-982Z/chat-flow-runs-a-determini-9e008-ember-group-media-lifecycle-chromium/` and inspected:

- Presentation active, top and end, light/dark at 2560×1440 and 1024×900 (`group-call-presentation-{light,dark}-{2560,1024}-{top,end}.png`).
- Open presentation-quality menu with visible **Share audio**, light/dark at 1440×900 and 390×844 (`group-call-quality-open-{light,dark}-{1440,390}.png`).
- Actual permission failure at 390×844 (`group-call-error-light-390.png`).
- Group-call active/error and group-member-list top/end theme/viewport states; the last eligible member row and scroll bounds remain contained.

The inspected screenshots show legible light/dark surfaces, controls above the action row, no relevant horizontal overflow or overlap, visible focus, and correct error viewport size. Artifacts remain ignored test output and are not committed.

## Review

PM scope, TL architecture, QA, security, code review, and designer reviews accepted the feature. The group-call room limit is four simultaneous participants, below the 16-member group-chat limit; a full room returns an explicit capacity reason and remains available for chat. The existing Home CSS warning remains tracked; frontend and E2E high-severity dependency audits pass after the Angular/Vitest update.
