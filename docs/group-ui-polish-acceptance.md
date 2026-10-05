# Group UI polish — acceptance

## Outcome and boundaries

Completed the requested screenshot fixes:

- Halved the vertical space between member cards in both responsive modes, for owner and admin managers. The desktop list uses its outer space to keep complete rows visible at the end; the mobile margin remains 10px so action tooltips stay clear of member names.
- Centered the arrow in the direct-call minimize circle.
- Removed the extra focus outline from the group-call Share audio checkbox while retaining one visible keyboard focus ring.
- Named every active group typer and made each group member’s typing state independent.
- Kept the full and minimized group-call End tooltips readable in dark mode without changing call actions.

All changes are presentation/Home UI only. Existing call intents, audio opt-in semantics, group membership permissions, typing WebSocket events, server authorization, and persistence are unchanged.

## Acceptance

- Group list CSS uses a **14.5px** default card gap (half of 29px) and an **18px** narrow-screen gap at widths ≤760px (half of 36px). Rendered browser row bounds verify those values within 1px for mixed action/no-action owner, admin, and member rows. Card internal spacing, 44×44 action buttons, scroll caps, and top/end list visibility remain intact. At the desktop end position, the test permits an alignment correction only when the clipped top row is within the list’s intentional bottom-padding allowance, then verifies that the final row/actions are fully inside the viewport and that scroll remains at the end.
- While an action tooltip is visible, its compact feature-scoped Material surface preserves legibility and does not cover member text or action controls. Existing pointer/keyboard tooltip behavior, focus recovery, resize/scroll dismissal, and tooltip contrast checks remain enabled.
- The direct-call minimize icon center is within 2px of the center of its 44×44 control at all four widths and both themes; minimize intent and focus remain unchanged.
- Group Share audio hover does not render the keyboard ring. Keyboard focus renders a single 3px outline on the toggle surface and no outline on the nested checkbox. Unchecked, checked, and presentation-disabled states remain distinguishable and contained.
- Group typing resolves every active remote name from the selected authorized group projection. One typer displays “Alice is typing…”, two displays “Alice and Bob are typing…”, and three or more list all names (for example “Alice, Bob, and Carol are typing…”). A stop removes only that typer. Self, unknown, departed, and other-conversation user IDs are ignored. Home tests cover independent expiry and cleanup on conversation change, realtime recovery, and component destruction. Direct-chat copy remains “Name is typing…”. Light-theme typing text has rendered contrast of at least 4.5:1.
- Full and minimized group-call End tooltips render readable surfaces and text in dark/light themes with contrast checks and screenshots.

## Verification

- Full Angular headless suite: **285 passed**.
- Production Angular build: passed. The existing Home component style budget warning is **31.66KB**, 1.66KB over the 30KB warning threshold; the budget was not changed.
- Full isolated Playwright E2E suite: **26 passed, 0 failed**.
- `git diff --check`: passed.
- No Go, protocol, persistence, or dependency changes were made for this UI work.

## Screenshot review

Passing browser artifacts were retained and inspected under `e2e/test-results/2026-10-04T14-39-21-733Z/`:

- Owner group settings top/end, both themes at 2560×1440, 1440×900, 1024×900, and 390×844; admin manager top/end, both themes at 1440×900 and 390×844. Examples: `chat-flow-contains-group-m-77575-quired-viewports-and-themes-chromium/group-settings-admin-{light,dark}-{1440,390}-members-{top,end}.png` and `group-settings-{light,dark}-390-members-{top,end-no-tooltip}.png`. In both desktop themes the admin end captures show the last row and its actions wholly inside the list.
- Hover/focus action-tooltip captures show the reduced resting gap, compact readable tooltips, and visible focus without obscuring card text/action controls.
- Direct-call active/minimize focus captures cover light/dark at the acceptance widths; `chat-flow-direct-call-offe-d6505-s-connect-in-the-browser-UI-chromium/direct-call-active-{light,dark}-{390,1440}.png`.
- Group Share audio focus and presentation states in `chat-flow-runs-a-determini-9e008-ember-group-media-lifecycle-chromium/`, including `group-call-share-audio-focus-{light,dark}-{390,1440}.png`.
- Named multi-typer group states in `chat-flow-shows-group-memb-9496d-s-each-member-independently-chromium/group-typing-{light,dark}-{390,1024,1440,2560}.png`.
- Readable full/minimized group End tooltip states in both themes, including `chat-flow-runs-a-determini-9e008-ember-group-media-lifecycle-chromium/group-call-end-everyone-tooltip-{light,dark}-390.png` and `group-call-minimized-end-tooltip-{light,dark}-390.png`.

The reviewed screenshots show the requested tighter spacing, complete member rows and contained controls, a centered direct-call arrow, one Share audio focus ring, readable named typing status in both themes, and no observed horizontal overflow or clipping in the reviewed states. Test artifacts remain ignored and uncommitted.

## Review

PM scope, TL design, code review, QA, and designer review accepted this frontend-only change. Existing unrelated dirty-worktree changes were preserved. The temporary feature plan is removed after this durable acceptance record.
