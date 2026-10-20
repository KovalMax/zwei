---
name: zwei-diagnosing-bugs
description: Reproduces, minimizes, investigates, fixes, and regression-tests difficult Zwei bugs and performance regressions.
---

# Zwei Bug Diagnosis

Use when a failure is unclear, intermittent, cross-layer, or performance-related. For an obvious small defect, use a focused regression-test workflow without unnecessary ceremony. Load `zwei-quality`, `zwei-architecture`, and the relevant Go/Angular/database/security guidance.

1. **Establish scope and safety.** Inspect the affected code/tests and current scripts. Get a sanitized symptom/reproduction when needed. Inspect side effects before running commands; keep E2E on its isolated database/Redis setup and never expose secrets, message contents, auth tokens, SDP/ICE, or personal data.
2. **Build a sharp feedback loop.** Find or create a targeted test/probe at the caller-facing seam that fails on the reported symptom. Prefer deterministic fixtures, injected clocks, isolated browser state, and narrowly scoped service tests. If no safe red-capable loop is possible, state what evidence/access is missing instead of guessing.
3. **Reproduce and minimize.** Observe the failure, then remove irrelevant inputs, state, timing, or layers one at a time while preserving it. Record exact environment/setup needed; do not alter shared development data to make a repro.
4. **Rank falsifiable hypotheses.** List a few plausible causes and what evidence would distinguish them. Test one variable at a time; distinguish confirmed facts from hypotheses.
5. **Instrument selectively.** Prefer focused test output, debugger, or temporary bounded instrumentation. Never log credential values, private payloads, ticket URLs, or raw SDP/ICE. Remove temporary instrumentation when done. For performance, capture a reproducible baseline before changes.
6. **Fix test-first.** Turn the minimized repro into a regression test, observe it fail for the right reason, implement the smallest fix, then observe it pass. Use `zwei-tdd`; use `zwei-codebase-design` if the bug exposes a missing/poor seam.
7. **Close the loop.** Re-run the original reproduction and the approved affected checks, inspect relevant browser artifacts for UI issues, clean only task-created temporary outputs, and report cause/evidence, regression test, exact commands/results, limitations, and remaining hypotheses.

Do not run broad stress/fuzz workloads, use production instrumentation/data, mutate shared databases, or use history-rewriting/bisect workflows without checking scope and getting required authorization. Never claim a cause that the evidence does not establish.
