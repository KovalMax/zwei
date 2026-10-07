# Direct Call Controls — Acceptance

## Outcome

Direct-call controls now use a circular mute/share action pair around a larger centered end-call action, a compact screen-audio checkbox beside quality, and the existing minimize interaction styled consistently with the group-call affordance. The custom quality picker and system-audio option are direct-call opt-ins; group calls retain their Material selectors and no audio checkbox.

## Accepted behavior

- The direct-call action row retains existing typed action intents and provides 48px round mute/share controls around a centered end-call action measuring 68px on desktop and 64px on mobile.
- Direct-call quality selection uses the keyboard-operable custom picker; group-call quality remains `mat-select`.
- Screen-audio opt-in is icon-only, keyboard-operable, unchecked by default, labeled “Share audio,” and includes an accessible state/unavailability description plus a native tooltip title. Unsupported capture leaves the control visible and disabled.
- Direct minimize preserves the existing collapse intent and a 44px contained target. Group-call presentation remains unaffected.
- Rendered direct-call geometry is asserted at 2560×1440, 1440×900, 1024×900, and 390×844 in light and dark themes; active-call containment, action placement, mobile bounds, focus, checked state, unsupported state, and minimize affordance are covered.
- Pre-active incoming/outgoing notifications match the adjacent chat header's outer rendered height, using the shared `--chat-header-row-min-height` and `--chat-header-gutter-x` tokens (26px desktop / 12px mobile); vertical padding is zero. Host, card, and actions share the same light (`#fff`) or dark (`--chat-surface`) surface; the only divider is the bottom rule matched to the header. At 390px the profile and right-aligned actions remain on one row, with long profile text ellipsized.
- The compact notification CSS is scoped to `:not(.call-panel-full)`; active/connecting full-call presentation, chat history/composer visibility before acceptance, call actions, and lifecycle remain unchanged.

## Verification and visual review

- Focused component specs: device controls **9 passed**; direct-call surface **4 passed**.
- Full Angular headless suite: **367/367 passed** across 31 spec files with coverage.
- `make frontend-build`: passed without a component-style budget warning.
- Focused notification matrix passed through `make e2e-one SPEC=tests/chat-flow.spec.ts TEST='register, create conversation, and deliver a message'`; it covers incoming/outgoing light/dark at 2560, 1440, 1024, and 390px, exact header/panel outer-height parity, token gutter parity, surface/border/shadow geometry, long-name truncation, focus, and messaging while ringing.
- Final isolated `make e2e`: **36/36 passed**, no skips.
- Inspected all 16 incoming/outgoing notification screenshots under `e2e/test-results/2026-10-07T11-15-57-711Z/chat-flow-register-create-conversation-and-deliver-a-message-chromium/`. The direct-call active matrix also asserts existing full-surface `justify-content` and responsive panel padding; the active-mobile screenshot is pixel-identical to the pre-change focused artifact (`08-24-40-149Z`, SHA-256 `85fb52e8a490e1762c07a5e1d08898267ea160b4590d78944b3ee1d3db67114a`). The suspected sticky-footer overlap is not reproduced by the current screenshots and is unaffected by compact-row selectors.
- Group list top/end and group-call hover/focus captures were also inspected at light/dark, desktop/mobile. The idle search placeholder is hidden immediately when unfocused, avoiding text ghosting over the Search people label.
- E2E artifacts remain ignored under `e2e/test-results/`; no screenshots are release source assets.

## Boundaries

No transport, persistence, protocol, migration, or media ownership change was introduced for the direct-call controls. Captured media and optional system audio remain browser-local and opt-in. Group-call presentation is not restyled.

## Separate follow-up

When the active-call screen-share quality picker is open on mobile, its overlay can cover the microphone/speaker labels beneath it. This is pre-existing active/full-call picker behavior, outside the compact notification change; the full-call screenshot is pixel-identical to the pre-change run. Track the mobile picker visibility/usability separately if those underlying labels must remain visible while the listbox is open. Evidence: `e2e/test-results/2026-10-07T11-15-57-711Z/chat-flow-register-create-conversation-and-deliver-a-message-chromium/call-select-open-light-mobile-contained.png`.
