# Direct Call Controls — Acceptance

## Outcome

Direct-call controls now use a circular mute/share action pair around a larger centered end-call action, a compact screen-audio checkbox beside quality, and the existing minimize interaction styled consistently with the group-call affordance. The custom quality picker and system-audio option are direct-call opt-ins; group calls retain their Material selectors and no audio checkbox.

## Accepted behavior

- The direct-call action row retains existing typed action intents and provides 48px round mute/share controls around a centered end-call action measuring 68px on desktop and 64px on mobile.
- Direct-call quality selection uses the keyboard-operable custom picker; group-call quality remains `mat-select`.
- Screen-audio opt-in is icon-only, keyboard-operable, unchecked by default, labeled “Share audio,” and includes an accessible state/unavailability description plus a native tooltip title. Unsupported capture leaves the control visible and disabled.
- Direct minimize preserves the existing collapse intent and a 44px contained target. Group-call presentation remains unaffected.
- Rendered direct-call geometry is asserted at 2560×1440, 1440×900, 1024×900, and 390×844 in light and dark themes; active-call containment, action placement, mobile bounds, focus, checked state, unsupported state, and minimize affordance are covered.

## Verification and visual review

- Focused component specs: device controls **9 passed**; direct-call surface **3 passed**.
- Full Angular headless suite: **269 passed**.
- `make frontend-build`: passed. Existing warning remains: `home.component.css` is 1.59KB over the 30KB component-style warning budget; budget unchanged.
- Focused Playwright direct-call scenario: passed through `make e2e-one SPEC=tests/chat-flow.spec.ts TEST='direct call offers and answers connect in the browser UI'`.
- Final isolated `make e2e`: **25 passed**. A preceding full-suite attempt timed out in the long group-layout test; its focused rerun passed, and the subsequent full suite passed.
- Inspected passing direct-call screenshots under `e2e/test-results/chat-flow-direct-call-offe-d6505-s-connect-in-the-browser-UI-chromium/`: active light/dark at all four widths; checked light mobile and dark desktop; focus and tooltip in both themes at desktop and mobile; unsupported light mobile and dark desktop. The dark tooltip uses a light surface with dark text and has a contrast assertion after its animation completes.
- Group list top/end and group-call hover/focus captures were also inspected at light/dark, desktop/mobile. The idle search placeholder is hidden immediately when unfocused, avoiding text ghosting over the Search people label.
- E2E artifacts remain ignored under `e2e/test-results/`; no screenshots are release source assets.

## Boundaries

No transport, persistence, protocol, migration, or media ownership change was introduced for the direct-call controls. Captured media and optional system audio remain browser-local and opt-in. Group-call presentation is not restyled.
