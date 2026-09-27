# Group Member Action Controls — Temporary Plan

## Outcome

Make group member cards more compact by replacing persistent, full-width text action buttons with small icon controls. Each action remains understandable through an accessible name and a tooltip on pointer hover/keyboard focus. Preserve the existing role, removal, transfer, confirmation, loading, and authorization behavior.

## Screenshot mapping and acceptance matrix

Both supplied screenshots map to the **selected, populated group with Group settings open**:

- Screenshot 1: dark theme; owner row currently exposes an invalid Remove action and another member row has no available actions. Verify owner-target actions are absent and permitted actions remain compact.
- Screenshot 2: light theme; owner row has no actions and an admin row has three oversized text actions. Verify the row is compact and each action has its own accessible icon/tooltip.

| State | Theme | Viewports | Expected |
| --- | --- | --- | --- |
| Populated group settings; owner/admin/member targets | Light and dark | 2560×1440, 1440×900, 1024×900, 390×844 | Compact cards; correct permission-specific icon controls; no overlap or horizontal overflow; controls/tooltip stay inside the panel/viewport |
| Owner-only group / no actionable members | Light and dark | 1440×900, 390×844 | No empty action row or reserved action height |
| Pointer hover and keyboard focus on each action | Light and dark | 1440×900, 390×844 | Tooltip explains the resulting action; focus ring remains visible |
| Touch-sized action use | Light and dark | 390×844 | Accessible name is sufficient without hover; 44×44 minimum target |

Pre-change baseline was measured in the real rendered Home application at **1440×900, light theme**, with three permitted text actions: member row height **114 CSS px**; action widths **90.70, 108.03, and 68.69 CSS px**; combined action width **267.42 CSS px**. The retained browser state is `e2e/test-results/chat-flow-contains-group-m-77575-quired-viewports-and-themes-chromium/group-settings-light-1440-members-top.png`. Post-change acceptance requires at least **20% less row height** (≤91.2px) and **30% less combined action width** (≤187.2px) for equivalent role/action content.

## Non-goals

- No group membership/role semantics, authorization, confirmation, API, WebSocket protocol, persistence, or migration changes.
- No broad redesign of group settings, empty states, or call UI.

## Architecture and dependency direction

This is a Home-scoped Angular presentation change. The existing `HomeComponent`/`GroupConversation` projection remains the source for row display and permissions; actions continue to call existing Home handlers and typed `ConversationService` methods. Reuse `ZweiIconComponent`, the shared `AppMaterialModule`, and Angular Material tooltip behavior. Do not add a new service, data model, or transport layer.

## Risks and mitigations

- **Permission display:** an admin must not see Remove/role/transfer actions against the owner; self-actions remain hidden. The server remains authoritative.
- **Accessibility:** tooltips are explanatory only; each button retains a persistent meaningful accessible name. Keyboard focus exposes the tooltip and visible focus ring. Touch activation works without hover.
- **Responsive containment:** long names and action controls must wrap/contain without clipping, row overlap, or document/list horizontal overflow.
- **Concurrency/error behavior:** keep current loading/error and confirmation paths; do not optimistically mutate roles or membership.
- **Theme/motion:** both themes must meet contrast expectations; honor reduced-motion and preserve existing focus styling.
- **Compatibility/data:** no protocol, API, schema, migration, or rollback concern is introduced.

## Acceptance criteria

1. At rest, permitted member actions are icon-only compact buttons; button labels are exposed via accessible names and hover/focus tooltips.
2. Each action target is at least 44×44 CSS pixels; tooltips do not escape the panel/viewport at all matrix sizes.
3. Owner-target and self-target controls are absent. Owner/admin/member permissions remain accurate, including owner-only transfer.
4. Role changes, removal confirmation, and failures still invoke the existing handlers without duplicate requests or optimistic authorization.
5. The browser verifies ≥20% row-height and ≥30% action-width reduction from the real rendered pre-change baseline for equivalent rows.
6. Light/dark screenshots and computed geometry/contrast cover the populated, owner-only, hover, keyboard-focus, and touch states at the matrix widths.

## Definition of Done

- Focused Angular tests cover owner, admin, member, owner/self target visibility, accessible labels, and action outputs.
- Playwright covers hover and keyboard tooltip behavior, 390px touch use, list top/end containment, all requested widths/themes, and quantitative compactness against the baseline.
- Rebuilt frontend/E2E Docker images, Angular headless tests/coverage, production build, focused/full Playwright, screenshot inspection, and code/design/QA review pass without weakening assertions.
- The durable acceptance matrix is updated; this temporary plan is retained until the review gate accepts the change.
