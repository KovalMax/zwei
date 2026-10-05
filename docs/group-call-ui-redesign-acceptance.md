# Group-call UI redesign — acceptance

## Outcome and scope

The group-call surface now follows the accepted direct-call presentation language for profile/card treatment, participant grouping, presentation framing, device controls, and primary action hierarchy. Group-specific behavior remains intact: roster, screen presentation, Material device selectors, audio recovery, Join, minimize/restore, Leave, room-wide End, and rejoin/terminal states remain group-aware.

No signaling, media negotiation, authorization, API, WebSocket protocol, persistence, migration, or server behavior changed for this redesign. Home remains the lifecycle owner; `GroupCallSurfaceComponent` remains presentation-only and emits its existing typed intents.

## Accepted visual and behavior criteria

- **End vs Leave:** End remains a red room-wide destructive action with accessible name, title, and hover tooltip “End group call for everyone.” Leave remains a separate outlined “Leave call” action. Ending from minimized presentation now routes through the same typed `{type: 'end'}` Home intent as the full surface; the minimized banner reads “End group call.”
- **Active controls:** round mute/screen-share controls flank a larger red End control. The roster and shared presentation have distinct sections; shared content remains inside the call content scroller, while actions remain reachable below it.
- **Group-only controls:** Join, Material microphone/speaker/presentation-quality selectors, screen presentation, Enable sound recovery, Leave, End, collapse/restore, and terminal/rejoin notices preserve their existing intent/effect. No direct-only quality picker or system-audio checkbox was added.
- **Themes and viewports:** light/dark at 2560×1440, 1440×900, 1024×900, and 390×844. Active and minimized layouts, and screen-presentation containment, are browser-asserted across the matrix. Focus is checked on mute, share, End, Leave, device selectors, minimize, and minimized banner controls. Text/control contrast, no horizontal overflow, target geometry, content scroll bounds, presentation-stage/video containment, and last-selector reachability are verified.
- **Mobile presentation edge:** the roster collapses to a compact inline heading/chip row and the shared preview uses a mobile-sized frame so the first microphone and speaker controls remain fully visible above the action bar. Visible labels/selectors are asserted within the scrollport; the presentation quality selector remains reachable at scroll end. This closes the review finding where a device selector was partially under the action area.
- **Minimized End tooltip:** the explanatory tooltip is positioned below the minimized banner, avoiding overlap with the Home group header; both mobile themes assert its contrast and separation from the restore control.
- **Lifecycle:** browser coverage retains incoming/Join, active, presentation, minimized/restored with remote audio recovery, participant leave/rejoin, End-for-everyone, ended, and permission-error states. Ended/left/error notices do not retain active call controls.
- **Motion/accessibility:** visible keyboard focus and existing reduced-motion behavior are preserved; icon-only controls have meaningful accessible names and at least 44px targets.

## Verification

- Focused `GroupCallSurfaceComponent` Angular spec: **3 passed**.
- Focused `HomeComponent` Angular spec: **92 passed**.
- Full `make -C infrastructure frontend-test`: **273 passed**.
- `make frontend-build`: passed. Existing `home.component.css` style-budget warning remains at **1.59KB over the 30KB warning limit**; the budget was not changed.
- Focused E2E group media lifecycle: **1 passed**.
- Final isolated `make e2e` after rebuilding frontend/E2E images: **25 passed**; `e2e/test-results/.last-run.json` reports passed with no failed tests.
- `git diff --check`: passed.

No Go code, dependency, protocol, or persistence was changed for this feature, so Go/package security scans were not part of this feature’s gates. The existing frontend npm-audit advisory is documented in `docs/group-member-actions-acceptance.md` and remains a separate release/security follow-up.

## Visual artifact review

Passing artifacts in `e2e/test-results/chat-flow-runs-a-determini-9e008-ember-group-media-lifecycle-chromium/` were inspected, including:

- `group-call-{light,dark}-{2560,1440,1024,390}.png`
- `group-call-presentation-{light,dark}-{2560,1440,1024,390}.png`
- `group-call-minimized-{light,dark}-{2560,1440,1024,390}.png`
- `group-call-restored-dark.png`
- `group-call-end-everyone-tooltip-{light,dark}-{2560,1440,1024,390}.png`
- `group-call-leave-focus-{light,dark}-{2560,1440,1024,390}.png` and `group-call-collapse-focus-{light,dark}-{2560,1440,1024,390}.png`
- `group-call-terminal-{dark,owner-light}-{1440,390}-immediate.png` and `group-call-error-light-390.png`

The group-call collapse affordance is distinct from direct-call minimize and has no tooltip by design. The explicit room-wide End tooltip is present on the red End control.

The active 390×844 presentation captures were reinspected after the edge-layout fix: microphone/speaker controls are not obscured by the footer, and the quality selector remains reachable in the end-scroll capture. The minimized 390×844 captures show the End tooltip below the banner without obscuring the group header.

## Review

The scoped code review, security review, QA review, and designer review accepted the group-call redesign with no remaining feature blocker. Previously existing unrelated dirty-worktree changes were preserved and were not changed as part of this presentation-only feature.
