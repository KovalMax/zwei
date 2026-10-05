# Call device-control alignment and Share audio focus — acceptance

## Outcome and boundaries

Fixed the two supplied call-control screenshots in **both direct and group calls**:

- The checked or unchecked keyboard-focused Share audio control now retains its complete focus outline, including the bottom edge.
- The combined Screen share quality + Share audio row now spans the same width as the microphone/speaker device row.

The shared `CallDeviceControlsComponent` owns these presentation rules. Direct/group call surfaces still own call state and typed intents. Media ownership, opt-in semantics, permissions, selectors, APIs, WebSocket protocol, persistence, and dependencies are unchanged.

## Acceptance

- Direct and group device layouts have matching row spans within **1 CSS pixel** at **2560×1440, 1440×900, 1024×900, and 390×844**, in light/dark themes. Microphone and speaker selectors remain equal-width; the visible quality/audio controls fill the same row span.
- Share audio stays **118px minimum**, 48px high, checked/unchecked states remain distinguishable, and disabled behavior is unchanged.
- The checked and unchecked keyboard-focus ring remains a single 3px visible outline with no outline on the nested checkbox. Browser assertions measure outline width/offset and all four ring bounds against actual clipping ancestors and the viewport without scrolling to rescue the focus state.
- Group call retains horizontal containment while its device-control wrapper no longer creates a vertical clip that cuts off the focus outline.
- No row/control overlap or horizontal overflow is introduced. Existing incoming/ringing/active/screen-share/stopped/restarted/minimized/restored/ended/error call flows remain covered by the full browser suite.

## Rendered diagnosis and fix

Before the fix, direct-call controls had a **634px** device host but a **624px** quality/audio visible-control span; at 390px those spans were **324px** and **314px**. The nested row’s 5px inline padding caused the mismatch. Group call had the same nested inset.

For checked, keyboard-focused group Share audio at 390px, the toggle bottom was **537px**, the focus ring extended to **542px**, and `.group-call-devices` clipped at **537px** because `overflow-x: hidden` computed `overflow-y: auto`. The wrapper now uses horizontal clipping with vertical overflow visible; the outer group content remains the clip boundary. At that viewport its bottom is **668px**, so the entire ring remains visible. The shared grid provides a 5px inline gutter and the nested quality/audio row no longer adds a second inset. Rendered direct/group row spans now match (for example, group desktop **640px** and mobile **310px** inside the 5px gutter).

## Verification

- Focused direct-call browser flow: passed.
- Focused deterministic group-call media flow: passed.
- Full Angular headless suite: **285 passed**.
- Production Angular build: passed. The pre-existing Home component stylesheet warning remains **31.66KB**, 1.66KB over the 30KB warning budget; no budget was changed.
- Full isolated Playwright suite: **26 passed, 0 failed**.
- `git diff --check`: passed.
- Scoped code, security, QA, and designer reviews: accepted; no API, protocol, persistence, or security changes were introduced by this follow-up.

## Screenshot review

Passing full-suite artifacts were retained and inspected under `e2e/test-results/2026-10-04T16-01-54-036Z/`:

- Direct calls: `chat-flow-direct-call-offe-d6505-s-connect-in-the-browser-UI-chromium/direct-call-active-{light,dark}-{2560,1440,1024,390}.png`, `direct-call-audio-option-keyboard-focus.png`, and `direct-call-audio-focus-{light,dark}-390.png`.
- Group calls: `chat-flow-runs-a-determini-9e008-ember-group-media-lifecycle-chromium/group-call-share-audio-checked-focus-{light,dark}-{2560,1440,1024,390}.png` and matching unchecked `group-call-share-audio-focus-{light,dark}-{2560,1440,1024,390}.png` captures.

Focused checked-state artifacts were also retained and inspected under `e2e/test-results/2026-10-04T15-40-29-410Z/`. Artifacts remain ignored test output and are not committed.
