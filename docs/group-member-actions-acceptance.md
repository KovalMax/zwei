# Compact Group Member Actions — Acceptance

> This document records the full follow-on group UI/access acceptance as well as the original compact-action work. The current delivery adds call presentation, neutral system-message, and access-quarantine checks; see the matrix and verification update below.

## Scope

Replace persistent group-member text actions with compact, accessible icon buttons. Existing Home handlers, confirmation wording, permission boundaries, and API behavior are preserved. Group mutations now share one in-flight lock: competing mutations are ignored until the current request completes, and visible mutation controls are disabled. No backend, protocol, or migration changes were made for this UI.

## Acceptance matrix

| State | Theme | Viewports | Verified result |
| --- | --- | --- | --- |
| Selected populated group settings; owner, admin, and member targets; top/end of member list | Light and dark | 2560×1440, 1440×900, 1024×900, 390×844 | Correct actions, 44×44 targets, no horizontal overflow; at max scroll the final row/actions are fully visible, and all visible row text and action targets remain inside the scroller. ✓ |
| Owner viewing an admin target (three-action row) | Light | 1440×900 | Dynamic Make member / Transfer owner / Remove labels and tooltips; keyboard focus ring visible; quantitative compactness thresholds pass. ✓ |
| Admin viewing owner, self, and member targets | Dark | 1440×900 | Owner and self have no actions; ordinary member has Make admin and Remove; Transfer owner is absent. ✓ |
| Owner-only group settings | Light and dark | 1440×900, 390×844 | Sole owner row has no action container or buttons; row fits without a reserved action slot; page stays horizontally contained. ✓ |
| Owner-only mobile settings at maximum scroll | Light and dark | 390×844 | Leave/Delete remain visible and fully inside the settings scrollport and viewport; manager/card and document remain horizontally and vertically contained. Captured both end states. ✓ |
| Pointer hover and keyboard-only focus for each of the three permitted actions | Light and dark | 2560×1440, 1440×900, 1024×900, 390×844 | Each action independently shows exactly one correctly named tooltip. Rendered foreground/background contrast is computed and is ≥4.5:1; tooltip bounds stay within the manager/viewport and avoid controls/rows; buttons retain member-specific `aria-label`s. Screenshots wait for the tooltip animation. ✓ |
| Member-list and settings-panel scroll with a tooltip open | Light and dark | 2560×1440, 1440×900, 1024×900, 390×844 | Active/stale tooltips are dismissed when their trigger moves; scrolling from the member list to Group name / Save name leaves no tooltip behind. ✓ |
| Viewport resize with a tooltip open; keyboard recovery without pointer movement | Dark | 1440×900 → 390×844 → 1440×900 | Resize dismisses the tooltip; Tab/Shift+Tab focus navigation reopens it while the pointer stays over the action; a following scroll dismisses it again. ✓ |
| Pending group mutation status and controls | Light and dark | 1440×900 | Member, Add, Rename, Leave, and Delete controls are disabled while a role request is held in flight. Rendered “Saving group settings…” foreground/background contrast is computed and ≥4.5:1; loading screenshots captured in both themes. ✓ |
| Touch action | Dark | 390×844 | Member-specific accessible name is present without hover; 44×44 target responds to tap and updates the role. ✓ |
| Reduced-motion preference | Light and dark | 2560×1440, 1440×900, 1024×900, 390×844 | Action animations are disabled and transition duration is effectively zero; focus remains visible. ✓ |

## Permissions and outputs

- Owner self and any owner target expose no target actions.
- An owner sees Make admin + Transfer owner + Remove for a member, and Make member + Transfer owner + Remove for an admin.
- An admin sees Make admin + Remove for a member and Make member + Remove for another admin. Admins never see Transfer owner; admins see no actions for the owner or themselves.
- A member cannot manage the group.
- Owner-only group is covered in both themes at desktop and mobile widths, including mobile settings-panel end scroll and Leave/Delete containment.
- Existing role/removal/transfer handlers are dispatched from typed action descriptors. Browser coverage performs role changes, confirms removal and transfer, and verifies the resulting role/member state. Unit coverage rejects stale/unauthorized action dispatch.
- Unit coverage holds a role mutation open, rejects every competing mutation/creation entry point without another confirmation or API call, and verifies the shared lock releases after both error and success. A rendered Home template test checks disabled mutation controls and `aria-busy` while busy.
- Tooltip recovery unit coverage calls `hideTooltips()` before focusing and checks synchronous tooltip enablement plus the queued show; browser recovery uses keyboard navigation without moving the pointer off the action.

## Geometry result against the reproduced baseline

Equivalent owner-view admin row, light theme at 1440×900:

| Measure | Baseline | Result | Reduction / limit |
| --- | ---: | ---: | ---: |
| Member row height | 114px | 57px | 50.00% lower; acceptance limit ≤91.2px |
| Combined three-button width | 267.42px | 132px (44px each) | 50.64% lower; acceptance limit ≤187.2px |

Browser assertions also verify member-list `scrollTop`, `scrollHeight`, `clientHeight`, `scrollWidth`, and `clientWidth`; every visible row/action/text rectangle at list end; tooltip rectangles against all `.group-manager` interactive controls and member rows; computed tooltip/loading text contrast; a counted real scroll event before dismissal assertions; settings-panel scroll dismissal; and document horizontal overflow at each matrix viewport/theme. At max scroll, the component measures the first intersecting row and increases the member scroller's height only enough to align that row with the scrollport top; it preserves the actual max-scroll position and keeps the final row visible. The base caps remain 336px desktop / 252px mobile; the representative populated matrix uses 367px desktop / 281px mobile after end alignment.

Rendered contrast inspection caught the loading status using dark-theme muted text in light mode: `rgb(174, 189, 208)` over `rgb(250, 249, 253)` measured **1.82:1**. The light-theme status now uses the existing readable group-settings text color; both theme assertions pass without changing the broader palette.

## Verification

- Full Angular headless suite: **185 passed**.
- Angular production build: **passed** without changing the original budgets: initial 1.1MB warning / 1.2MB error; `anyComponentStyle` 30KB warning / 36KB error. Initial output is **972.62KB**; the lazy Home chunk is **237.90KB**. No Angular budget warnings were emitted.
- Focused group-management Playwright coverage: **2 passed**. It checks the action/loading states and the full group-member/list matrix, including hover and keyboard-focused tooltips for all three actions at all four viewports in both themes, one-visible-tooltip behavior, overlap/containment against all manager controls and rows, list/panel scroll dismissal, permissions, and list edges. Measured result: 57px row, 132px total button width, three 44×44 actions.
- Full Playwright suite: **21 passed**. The run verified group authorization/loading behavior, mutation locking, rendered contrast, owner-only mobile settings at max scroll, the group-member matrix, active call removal, and the deterministic group-call lifecycle, along with the existing auth, messaging, KYC, and README journeys.
- The browser run also surfaced call-surface fit and theme-contrast gaps; the direct-call card now includes its padding in the viewport-constrained height, and direct/group call action surfaces have explicit light-theme colors. The direct end control stays in the 900px viewport and the group-call primary/danger controls meet their contrast assertions.
- Build/test warnings: Docker emits the existing `JSONArgsRecommended` warning for `infrastructure/node/Dockerfile:32`; Playwright warns that its configured E2E TLS environment disables certificate verification. Karma reports existing Manrope font-file 404s in the headless test server; tests still pass. The production Angular build emits no warning.
- Fresh ignored E2E artifacts include keyboard-focus captures for all three action IDs at all matrix themes/viewports: `group-member-action-{make-member|transfer-owner|remove-member}-keyboard-focus-{light|dark}-{2560|1440|1024|390}.png`. Other evidence includes hover captures for each action, `group-member-action-remove-hover-list-end-{light|dark}-{2560|1440|1024|390}.png`, `group-settings-{theme}-{width}-members-end-no-tooltip.png`, `group-settings-{theme}-{width}-name-controls-no-stale-tooltip.png` where the settings panel scrolls, `group-member-actions-reduced-motion-{theme}-{width}.png`, `group-member-actions-loading-disabled-{light|dark}-1440.png`, and `group-settings-owner-only-{light|dark}-390-end.png`. Also captured `group-member-action-remove-keyboard-recovered-after-resize-dark-1440.png`. Inspected the fresh loading, owner-only mobile end, and keyboard-recovery screenshots in both applicable themes. No tooltip overlaps its trigger/peer controls or member rows in the geometry matrix.

## Follow-on call, system-message, and group-access acceptance

| State | Theme / viewport | Verified result |
| --- | --- | --- |
| Group call active, controls at top/end | Light and dark; 2560×1440, 1440×900, 1024×900, 390×844 | Device controls, content card, action row, collapse/avatar geometry and list edges are contained; Leave text and End action have rendered contrast assertions. The newer list/call matrix covers both scroll edges. ✓ |
| Group call terminal | Light and dark; desktop and mobile | Ended/error notices are themed and readable; terminal UI does not retain active controls. Owner/observer terminal captures retained in the feature run. ✓ |
| Direct quality picker | Light and dark; 1440×900 and 390×844 | Connected above trigger, viewport-contained, clears sticky actions; keyboard open/arrow/Enter selection, selected-option state, Escape/Tab and outside dismissal are exercised. ✓ |
| Group system notices (added/admin role changed) | Light and dark; 2560×1440, 1440×900, 1024×900, 390×844 | Actor and recipient render neutral, non-own notices. Body/time meet 4.5:1; first/last notice visibility, history scroll end, composer boundary and horizontal containment are asserted. Top/end artifacts are retained. ✓ |
| Ordinary own-message metadata | Light and dark; 1440×900, 390×844 | Sender and timestamp meet 4.5:1 on rendered own bubbles; peer-read indicator is checked when that specific message carries the marker. Direct-message artifacts inspected in both themes and sizes; group own-message artifacts are captured in both themes and sizes. ✓ |
| Group access while membership is uncertain | Light/dark retryable error; pending light mobile and multiple error sizes | Group private history/actions/draft stay hidden, pending/error surfaces are bounded and padded, retry restores only a verified projection; only the chat API's recognized “group or user not found” 404 confirms removal. Unclassified 404 and partially malformed lists remain failures, not removal evidence. ✓ |
| Three-member call handoff and same-room rejoin | A starts; B and C join; after 2 seconds A ends; B starts; C leaves/rejoins; B ends; C starts and A/B join | 1440×900 for A/B; 390×844 for C; light/dark C terminal states | All participants join the announced room, C leaves without ending the other peers' call, same-room rejoin restores 3-party media, and each terminal transition clears active media/UI. Final C-started room admits A/B. ✓ |
| Rejoin microphone permission denied, then recovered | Light | 390×844 | Denied permission shows an accessible error and keeps the same-room Rejoin action; no active call panel appears. Restoring permission rejoins the existing room rather than starting a second one. Contrast/viewport containment verified; failure screenshot retained and inspected. ✓ |
| Socket loss while participant is left / room updates after leave | Unit lifecycle regression | Facade tests | The locally retained room remains rejoinable through realtime disconnect/reconnect; older same-room snapshots cannot overwrite or invalidate it, while a newer terminal revision clears it. Recoverable rejoin errors preserve retry; explicit not-found/not-allowed rejection clears cached room/TURN state. ✓ |
| Active-call group access uncertainty | Light quarantine/error surfaces; active call before revision change | 1440×900 and 390×844 quarantine surfaces | A server membership revision advance emits the terminal event, clears active media/call UI, and quarantines private group content while the projection lookup is failing. The separate active-member-removal scenario verifies remaining authorized peers retain their call and media. ✓ |
| Login empty/pristine, populated-field and required-error states | Light and dark | 2560×1440, 1440×900, 1024×768, 390×844 | Login text, labels, placeholders, entered values and required errors meet computed contrast thresholds (normal ≥4.5:1; large ≥3:1); dark gradient is subdued and text is light; the supplied light-theme warm gradient is preserved. Empty labels do not collide with placeholders. Page/card/submit stay inside the viewport. ✓ |

Historical follow-on verification at the time of this group-member UI slice: `make -C infrastructure frontend-test` **269 passed**; production build passed with the then-existing 31.59 KB Home component-style warning; isolated E2E **25 passed**. These results and screenshots document that iteration only; the current final-gate totals are recorded in `docs/group-call-repair-acceptance.md`.

The prior frontend audit findings (Angular router, `piscina`, and the Karma/`braces` development-tool path) were addressed by moving Angular to 22.2.1 and migrating the Angular specs to the supported Vitest browser runner. Frontend and E2E `npm audit --audit-level=high` now pass; no advisory was suppressed and the audit threshold is unchanged. HTTP 401 remains subject to the shared authentication interceptor’s logout/navigation handling.

The security follow-up capped TURN REST credential expiry at the corresponding call/room expiry and normalized call-command rejection text at the WebSocket boundary so infrastructure errors do not escape to clients. That iteration's focused checks were followed by the current full `go vet ./services/...` and `go test -race -count=1 ./services/...` gates recorded in `docs/group-call-repair-acceptance.md`.

Three-person handoff/rejoin reliability: the Home-scoped group-call facade retains an eligible departed room only while the room is live and another participant remains. Recoverable microphone/join failures and socket reconnects keep the same-room retry; explicit room authorization/not-found rejection and newer terminal events clear the cached room and TURN credentials. The browser handoff checks A→B→C, a literal two-second first call, C's leave and retry after denied microphone permission, C's successful same-room rejoin, then C→A/B. Active-call access quarantine is exercised while group projection verification fails; the separate active member-removal browser flow verifies other authorized participants retain their call. The mobile rail's last title/subtitle now has an 8px bottom inset at end-of-scroll.

Login dark-theme repair: `/login` retains the screenshot-referenced light warm gradient and uses a low-intensity dark-only gradient, login-specific theme variables, and high-contrast form labels/values/placeholders/errors. The 8-state E2E viewport/theme matrix measures real composited contrast including the page gradient, and verifies empty label/placeholder separation, populated values, validation states and containment. Shared registration/admin auth theme tokens were not altered.

## Screenshot follow-up: repeated group calls, minimize, and dark header

The two active-call screenshots and the subsequent unavailable-call screenshots exposed a cross-room state fence: after a group call ended at revision >1, another member could start a new server room at revision 1, but the former participant's Home discarded its `group.call.started` notification. The unseen ringing room expired after 30 seconds and blocked immediate further starts. `GroupCallFacade` now resets its revision fence when the previous room is retired, accepts the new room even during its terminal notice, and cancels the old notice timer; old room IDs remain fenced. Both parties can now join and end successive rooms without a persistent busy notice.

The hovered minimize arrow and hover circle are measured at the four acceptance widths in both themes: icon, SVG, and Material ripple centers are within 1px of the 44×44 button center. The dark-theme app header matches its dark surface with a light, measured-contrast wordmark; the light header remains white. Passing light/dark mobile and desktop captures, the new incoming light desktop capture, and active dark desktop capture were inspected. Focused Angular group-call tests, the full Angular suite (250/250), production build, and isolated Playwright suite (24/24) passed. No Go or WebSocket contract change was needed.

## Current group-control rejection follow-up — accepted

`group.call.leave` and `group.call.end` retain their request IDs for correlated `call.rejected` handling. A rejection means the optimistic socket enqueue did not establish the server transition; the client reconciles authoritative room state via `group.call.sync` and does not revive destroyed media by changing a phase label. Matching live state preserves a same-room retry that reacquires media; ended/unauthorized state remains terminal. Uncorrelated/stale rejections and stale terminal revisions cannot affect a newer lifecycle. No protocol or persistence change was required.

Historical verification at the time of the group-call-control slice: the frontend suite passed **268 tests**, the production build passed with a 472-byte component-style warning, and isolated E2E passed **25 tests**. Current final gates and review disposition are recorded in `docs/group-call-repair-acceptance.md`; do not treat these iteration totals as the current release totals.

## Tooltip recovery timing and cancellation follow-up — accepted

The repeated group-list E2E failures exposed two distinct timing hazards: a re-enabled `MatTooltip` could receive its next-frame show request before Angular had applied the disabled binding, and scrolling/repositioning the focused action could race keyboard recovery. Hover intent is explicitly re-enabled on real pointer entry; focus/hover shows are scheduled for the next animation frame and fenced by the current intent. Scroll, blur, pointer leave, and component teardown invalidate pending shows while restoring any remaining valid focus/hover intent, even when pointer and keyboard focus are on different actions. The E2E keyboard helper settles target scrolling before focus, and the list-scroll dismiss/recover sequence repeats ten times for each light/dark × 2560×1440, 1440×900, 1024×900, and 390×844 configuration.

Current verification for this follow-up: focused `group-member-list.component.spec.ts` **16/16**, full Angular headless suite **376/376**, production build passed (995.34KB initial total; no budget warning), focused group-list E2E **1/1**, and full isolated Playwright E2E **36/36**. Reviewed passing screenshots cover action hover/focus/recovery and list top/end in both themes; at list end a preceding row may be partially visible, while the final row and its actions remain fully visible. Artifacts include the recovered and scrolled-away tooltip states for both themes and all four required widths. The full-run artifacts are retained in `e2e/test-results/` under the timestamped directory containing `chat-flow-contains-group-m-77575-quired-viewports-and-themes-chromium/`.
