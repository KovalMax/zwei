# Zwei Skills Index

Use this index to load project guidance deliberately. Skill files are internal agent instructions, not user-facing product documentation.

## Start Here

- Project workflow and specialist routing: `./zwei-orchestration/SKILL.md`
- Architecture, boundaries, and project context: `./zwei-architecture/SKILL.md`
- Feature/behavior interview and durable domain decisions: `./zwei-grill-with-docs/SKILL.md`
- Verification commands and review gates: `./zwei-quality/SKILL.md`

## Task Type → Add These Skills

- Go services, application logic, adapters, or Go tests: `./zwei-go/SKILL.md`
- Angular, TypeScript, forms, routes, or browser UI: `./zwei-angular/SKILL.md`
- PostgreSQL schema, migrations, SQL, indexes, or persistence behavior: `./zwei-database/SKILL.md`
- Major roadmap, architecture, security, UI-system, or workflow change: `./zwei-iteration/SKILL.md`
- Test-first implementation of a behavior change: `./zwei-tdd/SKILL.md`
- Refactoring existing behavior safely: `./zwei-refactoring/SKILL.md`
- Difficult, intermittent, cross-layer, or performance bug diagnosis: `./zwei-diagnosing-bugs/SKILL.md`
- Module/interface/seam design or testability decisions: `./zwei-codebase-design/SKILL.md`

## Loading Rules

- For every implementation task, load `zwei-architecture` and `zwei-quality`, then load each language/data skill that matches the files or behavior being changed.
- For cross-layer work, load both `zwei-go` and `zwei-angular`; add `zwei-database` when persistence or migrations are involved.
- For a non-trivial feature or behavior/architecture decision, grill the requirements before writing the implementation spec; use the lightweight `grill-me` skill for a small isolated decision. Do not create a glossary or ADR unless the work establishes reusable domain language or a consequential decision.
- Use `zwei-tdd` for behavior changes and bug fixes where a regression test can express the required outcome. Use `zwei-refactoring` when the goal is structural change with behavior preserved; combine them only when refactoring is needed to safely deliver a behavior change.
- Use `zwei-diagnosing-bugs` only when the failure is unclear, intermittent, cross-layer, or performance-related; simple defects should use a focused regression test without the full diagnosis ceremony.
- Load `zwei-codebase-design` when interface depth, module boundaries, or test seams are under discussion; it is a design lens, not a mandate to add abstractions.
- For a material feature or major change, also load `zwei-iteration` and follow its active-plan guidance.
- Load only relevant guidance; do not load every skill by default. If the task expands into a new layer, load that layer's skill before editing it.
- Specialist agents should state the skills they applied in their handoff, along with evidence and any limitations.

## Maintenance

When architecture, tooling, persistence, or workflow changes, update the affected skill(s) and this index in the same change. Keep operational commands aligned with `AGENTS.md` and repository Make targets.
