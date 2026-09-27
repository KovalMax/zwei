# Compact Group Member Actions — Acceptance

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
