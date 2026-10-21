---
name: zwei-refactoring
description: Safely restructures Zwei code while preserving externally observable behavior and keeping each change reviewable.
---

# Zwei Refactoring

Use when the requested outcome is structural improvement with behavior preserved, or when a small design improvement is justified by the implementation task. Load `zwei-architecture`, `zwei-quality`, `zwei-codebase-design`, and the relevant language/data skills.

## Safety rules

- State the refactoring goal and behavior that must remain unchanged. Keep unrelated cleanup out of scope.
- Inspect existing tests and run the narrow baseline before editing. If the behavior is unprotected, add characterization/regression tests at the caller-facing seam first; do not silently treat missing coverage as permission for a broad rewrite.
- Make small steps that leave the code understandable and tests runnable. Prefer a sequence of mechanical changes over a redesign bundled with behavior changes.
- Preserve public APIs, protocol payloads, persistence semantics, authorization, errors, ordering, cancellation, and lifecycle behavior unless the request explicitly changes them.
- After each structural step, run the focused checks. Do not change production behavior and refactor simultaneously unless a required fix makes separation impossible; explain that exception.
- Review the final diff for accidental API churn, duplicated abstractions, new dependency directions, and generated/unrelated files.

## Useful candidates (not a checklist)

- Duplicated behavior that has one stable owner.
- Long functions or components mixing policy, transport, and persistence/presentation responsibilities.
- Shallow pass-through wrappers that do not hide complexity.
- Feature envy or primitive-heavy state where a cohesive domain value/type would clarify invariants.
- Interfaces that expose implementation detail or are broader than their callers need.
- Existing code made problematic by the new use case, when improving it is necessary and within agreed scope.

Do not refactor solely to satisfy a smell list. Use deep-module questions from `zwei-codebase-design`, apply KISS/YAGNI, and prefer locality over speculative generalization. For broad cleanup, first agree on a scoped plan with acceptance criteria.
