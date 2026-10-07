# Browser UI baseline coverage (bounded visual gate)

## What is enforced today

The baseline now contains **24 Playwright pixel references** under `e2e/visual-baselines/visual-baseline.spec.ts/`:

- Anonymous empty login: light/dark at **1440×900** and **390×844**.
- Authenticated empty Home, open people search, and group-create empty/validation/filled: light/dark at **1440×900** and **390×844**.

`e2e/tests/visual-baseline.spec.ts` compares full viewport pixels with `toHaveScreenshot` and independently checks theme, loaded DM Sans, visible content, computed colors/borders, dimensions, centering, text/icon contrast, keyboard focus, and overflow. The authenticated fixture registers a randomized synthetic owner, searches the seeded `e2e-admin@example.test` account, creates no group, and stores no credentials/private content in references. References are generated and compared in the pinned Docker image; they must be included in the eventual code change for clean-checkout CI enforcement.

The existing browser journey suite also checks visible geometry, theme, contrast, focus, scroll and transitions in `e2e/tests/auth-flow.spec.ts` and `e2e/tests/chat-flow.spec.ts`. The following *new semantic matrices* are now checked in both themes at **2560×1440, 1440×900, 1024×900, and 390×844**:

- Open people-search result before selecting a direct peer: input/results/row and rail bounds, no horizontal overflow/overlap, visible result, rendered text and search-icon contrast, exact theme surface/border, and native keyboard scrolling for long query text. Pixel references at 1440/390 and semantic checks at 2560/1440/1024/390. Diagnostic captures: `search-results-open-{light,dark}-{2560,1440,1024,390}.png`.
- Create group, **empty / whitespace validation / filled**: card/input/buttons/error and focus containment, exact light/dark card/input surfaces and borders, placeholder/error/label/heading/button contrast, reduced motion, and clearing the validation alert after a valid name is entered; no additional group is submitted. Pixel references at 1440/390 and semantic checks at 2560/1440/1024/390. Diagnostic captures: `group-create-{empty,validation,filled}-{light,dark}-{2560,1440,1024,390}.png`.

These diagnostic PNGs are **not** golden image comparisons. The rest of the existing UI has meaningful but non-exhaustive state-specific browser assertions and ignored screenshots; a green run or saved screenshot alone is not a visual baseline.

## Coverage inventory and remaining work

| User-visible surface | Automated evidence | Not yet a baseline / missing states |
| --- | --- | --- |
| Anonymous login | Four reviewed pixel references above; `auth-flow.spec.ts` checks text/field/validation geometry and contrast in both themes at 2560, 1440, 1024×768, 390. The pilot checks disabled Sign in label opacity and contrast against the corrected rendered button colors. | Pixel references do not cover 2560/1024, populated/validation/loading/error/focused-input states; those remain semantic or diagnostic. |
| Home shell and idle search | Empty Home light/dark at 1440/390 is pixel-compared; existing real rendered-text/geometry checks and sign-out/profile/menu tests remain. Mobile empty Home is the rail with zero conversations; desktop also shows the empty-workspace panel. | No Home pixel references at 2560/1024; complete hover/focus/header/rail effects at every viewport remain semantic or uncovered as listed by their existing specs. |
| Open search | Four-width semantic matrix, search icon contrast/non-overlap, long-query internal scroll/caret-at-end and diagnostic captures; stable single-result search pixel references at 1440/390; successful peer selection remains real. | No golden for empty results, HTTP failure, keyboard result selection, or arbitrary long identifiers; error/empty result states still need their own named contracts. |
| Create new group | Four-width, three-state semantic matrix and pixel references at 1440/390. Contrast checks cover placeholder/error; entering a valid name clears the validation alert. Real creation/settings are separately tested. | No golden or full matrix for network failure and every hover/disabled effect; these remain semantic or uncovered. |
| Direct chat | Empty selected conversation has light/dark captures at 2560, 1440, 1024×768, 390; other flows cover sent/received messages, read/unread, replay, composer and mobile containment. | No approved pixel references for stable populated direct chat. Bubble metadata/focus/error and history top/end are not each verified at all themes and sizes. |
| Group chat | Group settings, member-list top/end, rail, attribution, presence, typing and tooltip checks have light/dark and responsive captures; group permission/access behavior is asserted. | No approved pixel references. Every group empty/populated/error/role/hover/focus combination is not yet individually baselined at all widths. |
| Direct call | Active direct call has light/dark 2560/1440/1024×900/390 assertions and captures for device rows, controls, focus and theme; incoming/ringing, sharing/restart, minimized, terminal/error flows are exercised. | Live media/timer and dynamic state are semantic plus diagnostic, **not** approved pixel references; each call phase at every theme/viewport remains incomplete. |
| Group call | Active and presentation/minimized states have light/dark four-width browser geometry, focus, theme, roster, scroll and controls screenshots; group handoff/leave/rejoin/terminal/error scenarios are exercised. | No approved pixel references; incoming/ringing, transition frames, error and restarted-share states lack the complete cross-product of themes and widths. Dynamic frames/timers must not be masked wholesale. |

The 1024px login/direct-chat tests use **1024×768**, while the call/group/search/create matrices use **1024×900**; do not equate those viewports. Colors, borders, widths, heights, positions and effects are asserted *for named elements/phases*, not every DOM node or possible viewport. Direct/group chat and call states remain semantic/diagnostic rather than image-golden baselines because their messages, identities, media frames, timers and realtime transitions are dynamic.

## Reproducing and reviewing the baseline

The pinned `mcr.microsoft.com/playwright:v1.62.1-noble` browser image and locked E2E dependencies generate and compare references. `e2e/.dockerignore` excludes ignored `test-results` but includes reviewed `visual-baselines`. The runner mounts references **read-only** for normal tests; only `make e2e-baseline SPEC=tests/visual-baseline.spec.ts` can regenerate them with a writable mount. Review all changed images before including them in version control. Never use a passing diagnostic or failure screenshot as an approved reference without review. `PLAYWRIGHT_RUN_ID` is restricted to one safe directory component because Playwright clears its output directory on startup.

```sh
# Before running tests for copied frontend/E2E source, rebuild both images,
# recreate frontend, and wait for Angular compilation/HTTPS readiness.
make e2e-one SPEC=tests/visual-baseline.spec.ts
make e2e
# Only when intentionally changing the approved reference set:
make e2e-baseline SPEC=tests/visual-baseline.spec.ts
```

During implementation an intentionally red **test-only** `.auth-card` background produced a screenshot comparison failure: 154,698 differing pixels at 390×844, with actual/diff/expected artifacts retained under `e2e/test-results/2026-10-04T17-07-12-770Z/`. The perturbation was removed and the expanded reference set regenerated. The normal compare-only baseline spec passed **5/5**, Angular tests passed **285/285**, the production build completed, and the rebuilt full isolated E2E suite passed **31/31** in **5.2 minutes**. I inspected the 24 reference images plus passing full-run captures for login, Home, search and group create; representative search, validation, focused/filled, and mobile views showed no clipping, overlap, stale validation, or unreadable changed text. The search golden uses the seeded synthetic `e2e-admin@example.test` account, so no dynamic email mask is needed. Passing full-run artifacts, including existing chat/call transitions and the baseline captures, are under `e2e/test-results/2026-10-04T20-44-00-710Z/`. The E2E runner restored development auth/chat/realtime after the run.

## Security, CI and next coverage slice

Only the 24 reviewed login/Home/search/group-create references are candidates for version control. Keep `test-results` ignored: chat/registration/admin artifacts and failure traces can contain synthetic identifiers or credentials; CI uploads them on failure or success with a **7-day retention** limit. Never commit token-bearing URLs, real private messages, invitation codes, raw media, or unreviewed failure images. CI's normal `make e2e` path **compares but never updates** references.

**Status: bounded baseline complete.** PM, TL, frontend, QA, security, code, and designer reviews found no blocker in this scoped baseline. The stable-state image set is generated and visually reviewed; dynamic direct/group chat and call coverage remains state-specific semantic assertions and diagnostic captures, not pixel references. Remaining untested cross-products and error/empty states are listed above and are intentionally not claimed as complete visual coverage. The 24 reference files are in the current worktree but remain untracked; include them with the eventual change so a clean-checkout CI run can enforce the comparisons. Normal CI compares and never updates the references. Do not approve broad masks or auto-update goldens to make a failing test pass.
