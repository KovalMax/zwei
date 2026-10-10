---
name: zwei-iteration
description: Use when implementing a Zwei roadmap iteration or making a major architectural, security, UI-system, or workflow change.
---

# Zwei Iteration Workflow

1. Read the relevant existing skills before editing. Do not expect a permanent project-plan ledger.
2. Inspect the current implementation, tests, dependency boundaries, and worktree state.
3. Make the smallest coherent change for one roadmap slice. Do not mix unrelated feature work.
4. Add or update focused tests and remove dead code or duplicated logic exposed by the change.
5. Run the narrowest checks first, then the required Go, Angular, infrastructure, or Playwright checks.
6. Review the diff for security exposure, stale labels, protocol compatibility, resource ownership, and accidental files.
7. For UI slices, reproduce the reported state/theme/viewport before editing, inspect a rendered screenshot or trace after editing, and record browser assertions for geometry, visual state, and transitions—not only compile/test results. After the E2E run, retain and inspect passing screenshots; review light/dark surfaces and all visible controls at the relevant viewports. For tables/lists, inspect screenshots before and after scrolling to the end and verify that the first and last elements are visible inside the contained scroll region.
8. For agreed feature work, keep one ignored, feature-scoped working plan only while that work is active. Include outcome, non-goals, architecture, compatibility/security risks, acceptance criteria, and Definition of Done; remove it after acceptance. Do not retain completed plan ledgers or iteration history.
9. For a major change, update the relevant `.opencode/skills/*`, `.opencode/agents/*`, and `.serena/memories/*` durable guidance in the same iteration, then remove the temporary plan after all acceptance gates pass.

Do not mark a feature accepted or remove its active plan while required verification is unavailable or a known regression remains unresolved. Plans are working aids, not durable records of completed iterations.
