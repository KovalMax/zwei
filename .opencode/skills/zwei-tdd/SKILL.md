---
name: zwei-tdd
description: Drives behavior-focused red-green implementation in small Go, Angular, and cross-layer slices.
---

# Zwei Test-Driven Development

Use for implementation of an agreed behavior change or bug fix. Load `zwei-quality`, `zwei-architecture`, and the relevant `zwei-go`, `zwei-angular`, and `zwei-database` skills. Load `zwei-codebase-design` when a public seam or test boundary is unclear.

## Loop

1. Confirm the approved behavior, observable contract, and relevant acceptance criteria. If the seam or expected behavior is materially unclear, pause and resolve it before encoding assumptions in tests.
2. Pick one behavior slice and write a test at the most meaningful caller-facing layer: domain/application, adapter/transport, Angular user interaction, or browser flow as appropriate. Prefer independent expected values and deterministic fixtures over tautological assertions.
3. Run the narrow test using the repository's Docker-backed Make target and observe that it fails for the intended reason. If it passes before the fix, establish why it still catches the regression or improve it.
4. Make the smallest change that makes that test pass. Do not anticipate unrelated future cases or weaken the assertion to get green.
5. Repeat one behavior at a time. Keep tests focused on observable behavior rather than private methods, incidental call counts, or implementation structure.
6. Once behavior is protected, consider a separate safe refactoring pass using `zwei-refactoring`; rerun the focused checks after each structural step.
7. Run the agreed broader verification from `zwei-quality`. Report exact commands/results and any unavailable layers; never claim red/green without observing both runs.

## Zwei-specific boundaries

- Go: test domain invariants without infrastructure, application orchestration with fakes at ports, and adapters at their actual boundary. Use `context.Context`, injected time, and deterministic concurrency tests where relevant.
- Angular: test visible inputs/outputs and user behavior with deterministic HTTP/router/browser API fakes. For visible UI, component tests do not replace browser assertions and screenshot review.
- Cross-layer protocol/persistence work: test the backend and frontend contract boundaries together; include the isolated Playwright flow when acceptance depends on the user-visible integrated path.
- Local app/build/test commands run through Docker-backed Make targets. Preserve the E2E database/Redis isolation and inspect test side effects before execution.

TDD is a feedback discipline, not a requirement to write a speculative test suite up front. Never use production credentials/data or mutate unrelated development resources for a test.
