# Screenshot Visual Fixes — Acceptance

This document records the historical visual-fix iteration. Current release-gate results and later group-projection hardening are recorded in `docs/group-call-repair-acceptance.md`.

## Outcome

Resolved the nine reported visual issues in direct-call controls, group-member rows, and Home chat-header actions without changing call behavior or membership permissions. The real rendered state matrix covered both themes and 2560×1440, 1440×900, 1024×900, and 390×844 viewports where applicable.

## Accepted results

- The direct-call minimize affordance has an intentional surface and border; hover tooltips are readable and contained in both themes at desktop and mobile widths. Browser assertions wait for the tooltip animation, measure contrast (≥4.5:1), and check bounds.
- Share-audio focus remains visible and contained at the call-card edge. The focused mobile layout and rendered scroll metrics are asserted.
- Group-member rows have distinct borders/surfaces in both themes. Top and end states assert visible row/action containment, no horizontal overflow, and end-of-scroll behavior across the viewport matrix.
- Group-call and back-to-chats header controls have explicit surfaces/borders, visible focus, hover surface change, and focus-ring viewport bounds. Light-theme call hover received a specific surface rule because the stronger theme selector previously suppressed the generic hover style.
- A related empty-Home capture exposed placeholder ghosting during blur. Search placeholder opacity is now set immediately to zero when unfocused; browser coverage verifies the idle state after resize/blur, and refreshed screenshots no longer show overlapped label text.
- At this iteration, malformed group-list entries were filtered without hiding valid group or direct conversations. Later group-access hardening changed this behavior: malformed group projections now reject the whole list so it cannot be mistaken for authoritative membership removal.
- Dark-theme Material tooltips use a light surface with dark text for legibility.

The group-call collapse icon is a separate control and intentionally has no tooltip; the tooltip criterion applies to the direct-call minimize control. Screenshot 7 maps to the “Start group audio call” header action.

## Verification

- `make -C infrastructure frontend-test`: **269 passed**.
- `make frontend-build`: passed. Existing `home.component.css` warning is **31.59KB**, 1.59KB above the existing 30KB style warning budget; the budget was not changed.
- `go test -race ./...` and `go vet ./...` in a Go 1.26.6 container: passed.
- Focused tests passed for conversation service mapping, direct-call profile, group member list, direct-call browser flow, group-list/header browser matrix, and empty-Home text/contrast flow.
- Final isolated `make e2e`: **25 passed** after rebuilding the frontend/E2E images. One earlier full run timed out in the long group-layout case; the focused rerun passed and the subsequent full suite passed.
- `git diff --check`: passed.

## Visual artifact review

Inspected retained passing artifacts in `e2e/test-results/` after the final E2E run:

- Direct call: active light/dark at 2560, 1440, 1024, and 390 widths; minimize tooltip and keyboard focus at desktop/mobile in both themes; screen-audio focus at mobile.
- Group UI: header-call hover/focus and back-button focus in both themes; member-list top/end states in light/dark across 2560, 1440, 1024, and 390 widths; group-action focus/hover and reduced-motion captures.
- Empty Home: light/dark desktop and mobile; “Search people” is no longer doubled by an in-flight placeholder fade.

The screenshots and traces remain ignored test artifacts and are not release source assets.

## Boundaries

No API, WebSocket protocol, persistence, migration, permission, or media-ownership change was made for the visual repairs. The later group-list mapping behavior is fail-closed against partial authorization projections; server-side authorization remains authoritative.
