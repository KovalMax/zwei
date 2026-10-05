# Group list pagination acceptance matrix

Browser-visible rail states are exercised by `e2e/tests/group-list-pagination.spec.ts`.

| Theme | Viewport | First-page top | First-page end + Load more | Loaded-list top | Loaded-list end |
| --- | ---: | --- | --- | --- | --- |
| Dark | 2560 × 1440 | first row + document/list overflow | last page-1 row + button in viewport | first row + overflow | final row bounds inside rail |
| Dark | 1440 × 900 | first row + document/list overflow | last page-1 row + button in viewport | first row + overflow | final row bounds inside rail |
| Dark | 1024 × 900 | first row + document/list overflow | last page-1 row + button in viewport | first row + overflow | final row bounds inside rail |
| Dark | 390 × 844 | first row + document/list overflow | last page-1 row + button in viewport | first row + overflow | final row bounds inside rail |
| Light | 2560 × 1440 | first row + document/list overflow | last page-1 row + button in viewport | first row + overflow | final row bounds inside rail |
| Light | 1440 × 900 | first row + document/list overflow | last page-1 row + button in viewport | first row + overflow | final row bounds inside rail |
| Light | 1024 × 900 | first row + document/list overflow | last page-1 row + button in viewport | first row + overflow | final row bounds inside rail |
| Light | 390 × 844 | first row + document/list overflow | last page-1 row + button in viewport | first row + overflow | final row bounds inside rail |

## Cursor-page error visual acceptance

| Theme | Viewport | Alert/control acceptance | Preserved artifact |
| --- | ---: | --- | --- |
| Dark | 1440 × 844 | Contained semantic danger alert; alert and retry text contrast ≥4.5:1; retry ≥44px with visible 3px keyboard focus; no rail/document horizontal overflow | `groups-second-page-error-dark-1440.png` |
| Light | 1440 × 844 | Same computed-style, contrast, focus, and containment assertions | `groups-second-page-error-light-1440.png` |
| Dark | 390 × 844 | Same assertions at mobile width; alert/control remain inside the rail without horizontal overflow | `groups-second-page-error-dark-390.png` |
| Light | 390 × 844 | Same assertions at mobile width; alert/control remain inside the rail without horizontal overflow | `groups-second-page-error-light-390.png` |

In each state the browser test verifies the alert stays visible and retryable before retrying the same cursor; the existing page-failure checks still assert the first 25 IDs are unchanged and the retry returns all 26 groups.

## Composer layout acceptance

The selected Home layout is the empty-chat state (no conversation selected) while the group pagination failure alert is visible in the rail. At each desktop viewport/theme combination, the real browser measures computed element rectangles and asserts the composer and send button fit inside both the viewport and `.app-content`; the send button stays within the composer; neither composer nor send button overlaps the chat header; and the document has no horizontal overflow.

| Theme | Viewport | Expected layout and preserved artifact |
| --- | ---: | --- |
| Dark | 1440 × 844 | Composer and send control fully within viewport/app content; no header overlap or horizontal overflow; `groups-second-page-error-dark-1440.png` |
| Light | 1440 × 844 | Same geometric assertions; `groups-second-page-error-light-1440.png` |
| Dark | 1024 × 900 | Same geometric assertions; `groups-second-page-error-dark-1024.png` |
| Light | 1024 × 900 | Same geometric assertions; `groups-second-page-error-light-1024.png` |

The first-page and loaded-list top/end matrix uses representative viewport pairs 2560×1440, 1440×900, 1024×900, and 390×844 in both themes. Separately, the deliberate short-height 1440×844 cursor-page error state remains to exercise the desktop composer fix. The E2E provisioning path registers two distinct group owners and one shared target, then has each owner create 13 groups containing the target. This keeps group creation user-scoped while yielding 26 distinct target-visible IDs. It asserts exactly 25 row IDs before pagination, keyboard-activates **Load more**, injects one 503 for the cursor page, verifies the 25 prior IDs and accessible retry state remain, then retries the same cursor against the real HTTPS backend. It compares all 26 unique rendered IDs and names with the created projections, asserts the exhausted control is absent, and preserves top/end plus error screenshots under `e2e/test-results/`.

## Refresh, privacy, and malformed-page behavior

- `home.component.spec.ts` verifies that a first-page refresh omitting a loaded later-page group replaces its private projection and cached messages with only the generic **Group access needs verification** row; a failed detail lookup keeps that row retryable, while successful authorization keeps the selected group/call/navigation state and reloads its history.
- The omission state remains a rail row rather than implying deletion. The row exposes only the generic label, group ID needed for later lookup, and zeroed/empty projection fields; it has no cached name, member, unread, history, or timestamp data.
- Soft omission never aborts an active/rejoinable group call. A recognized detail 404 or authoritative `group.membership.changed` deletion removes the row and aborts only the matching call.
- Browser-visible acceptance matrix for the verification row (at each theme/viewport above):

| State | Rail row | Selected/history state | Group-call state | Result |
| --- | --- | --- | --- | --- |
| Page one omits a previously loaded group | Generic verification label; no stale details | Private history/actions cleared | Active/rejoinable call retained | Page absence is not removal |
| Authorized detail lookup fails temporarily | Same generic row remains available for retry | No stale selection/history restored | Call retained | Retryable access uncertainty |
| Authorized GET or later page returns the group | Authorized name/member projection replaces placeholder | Prior selected conversation/history restored only if navigation intent still matches | Existing call and minimized/nav state retained | Authorization restores projection |
| Detail GET returns recognized 404 or server deletion event arrives | Placeholder removed | Selection/history cleared | Matching call aborted; unrelated calls untouched | Definitive removal |
- `wire.mapper.spec.ts` and `conversation.service.spec.ts` reject a page with more than 25 items or an encoded cursor longer than the backend's 512-character limit atomically.
- **Backend rollback compatibility:** the chat backend's paginated endpoint remains envelope-only. The Angular typed transport mapper also accepts the prior bare `GroupWire[]` response as a complete list (`nextCursor: null`), allowing a cached/new PWA client to operate if the backend is rolled back to the branch's prior response. Empty arrays map to a complete empty page; any malformed array member rejects the entire page. `wire.mapper.spec.ts` and `conversation.service.spec.ts` cover both shapes. Before release, confirm no deployed/cached/out-of-repository older branch client depends on the unreleased bare-array endpoint; if any exists, do not change its response contract without an additive/versioned route.
- Group-page failure coverage preserves all existing IDs and cursor before retry; page absence alone never becomes removal evidence.

## PostgreSQL query-plan and index evidence

Benchmark was run against PostgreSQL **18.4**, `work_mem=4MB`, in transaction-scoped synthetic data that was rolled back. No benchmark groups remain in `messenger_test`.

| Workload | Index | First-page plan | Cursor-page plan | Warm latency (50 runs) |
| --- | --- | --- | --- | --- |
| 10,000 groups for the caller among 100,000 total groups; 90,000 belong to another caller, with mixed NULL/non-NULL `last_message_at` | Before | 26 candidates, 25 page keys/projections; top-N in-memory sort; no spill; 18.576 ms | 26 candidates, 25 page keys/projections; external merge sort spilled 2,488 kB (248 temp blocks read / 311 written); 32.004 ms | p95 not recorded for the unindexed diagnostic run |
| Same 10,000/100,000 distribution | Candidate partial expression index | Ordered index scan on the effective `COALESCE(last_message_at, created_at), id` key; 51/52 candidate checks to find 26 active groups; no spill; 0.500 ms | Cursor tuple bounds use the same index; 51/52 checks; no spill; 0.470 ms | first p95 **0.245 ms**, cursor p95 **0.240 ms** |
| Sparse distribution: 100 active groups among 100,000 total, spread through the ordering | Candidate partial expression index | Ordered index scan checks 13,005 candidates to find 26; no spill; 15.158 ms | Cursor scan checks 12,501 candidates to find 26; no spill; 13.463 ms | first p95 **12.493 ms**, cursor p95 **11.930 ms** |

The PM-approved performance acceptance is p95 ≤250 ms with no spill at the 10,000/100,000 target workload; sparse 100/100,000 data also stayed within that target. This is measured workload evidence, **not** a groups-per-user quota or a hard upper bound for arbitrary database scale. `conversation_members_active_user_idx` remains the membership authority in the candidate and projection query; the index does not grant access.

The partial expression index measured approximately **1.3 MiB** at 100,000 group rows. A simple 10,000-row `last_message_at` update took 81.380 ms without it and 98.674 ms with it (about 17.3 ms additional batch time / 21% in this isolated probe). This is not a concurrent production write-load guarantee; monitor build IO/WAL/replica lag and ongoing write/bloat impact.

Migration `0012_group_list_activity_index.sql` was applied and rerun. A namespaced session-level PostgreSQL advisory lock covers invalid-build recovery, index validation/build, and schema-version recording in the same psql session. The migration harness held runner one open, observed runner two waiting on the exact advisory lock, then released runner one and verified one correct index and version remained. Error termination releases the lock. Invalid-build recovery was exercised by leaving a deliberately failed concurrent unique build under the target index name; rerunning the migration dropped it concurrently and installed the correct valid/ready expression index. Valid but wrong same-name definitions were rejected; idempotency was verified. The repository migration runner executes all SQL files rather than skipping by version, so `DROP INDEX CONCURRENTLY` is only a temporary operational removal and the next migration run recreates the index; keep the additive index through feature rollback or remove it with a future forward migration. The PostgreSQL adapter integration test checks index validity/readiness, B-tree method, descending expression/ID keys, and group-only predicate.

Final current-tree browser verification: the latest full isolated Playwright result and inspected artifacts are recorded in the final verification section below. Passing pagination screenshots include top/end states in both themes at 2560×1440, 1440×900, 1024×900, and 390×844; cursor-error states cover desktop/medium/mobile with focus, contrast, list scroll geometry, last-row containment, and retry availability. The fixture keeps the shared target offline while owners provision groups, then verifies the 25 first-page API IDs against exactly 25 authorized visible rows and asserts no stale placeholder contaminates that page-bound check. Group management also has browser-visible loading/empty/error member-search coverage.

## Final verification

- Full isolated Playwright `make e2e`: **35 passed**, no failures or skips. `.last-run.json` reports `passed`; exact count is from runner output. Latest retained full-run artifacts: `e2e/test-results/2026-10-05T23-26-20-285Z/`.
- Inspected passing screenshots: account-menu light/dark mobile states; pagination first-page and loaded-list top/end in both themes across 2560×1440, 1440×900, 1024×900, and 390×844; cursor-error/retry states at all four widths/themes; focused Load more controls at all four widths/themes; stable Home/search/group-create visual baselines; PWA offline shell. Latest pagination captures use `group-list-pagination-load-0f248-cross-theme-viewport-matrix-chromium/`. `groups-light-2560x1440-end.png` contains no stale/translucent account menu after the explicit Material overlay-removal wait. Focused load-more screenshots confirm the visible 3px keyboard ring on rounded, theme-correct 44px controls. At error scroll-end, one earlier row may be partially visible at the top scroll boundary; measured scroll geometry confirms the last row and retry are fully contained/reachable and there is no bottom clipping or horizontal overflow.
- Angular headless coverage: **357/357 passed**; production build passed.
- Go: `go vet ./services/...` passed; `go test -race ./services/...` passed against a freshly migrated, isolated `messenger_go_verify_20261005` database and Redis DB 2. Migration 0012's concurrent-runner, error-release, recovery, definition-validation, and idempotency checks passed in the E2E provisioning path.
- `go mod verify`, pinned `govulncheck`, frontend `npm audit --audit-level=high`, and E2E `npm audit --audit-level=high` passed. The scanner found no vulnerabilities in imported Go packages (three findings exist only in required-but-not-called modules).
- Release compatibility gates remain operational: confirm no deployed/cached/out-of-repository older client adopted the unreleased bare-array endpoint before the new backend envelope is released. New frontend supports either response; backend remains envelope-only. Keep the additive index through rollback; the current migration runner recreates it on subsequent runs if dropped.
