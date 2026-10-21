---
name: zwei-database
description: Use when changing PostgreSQL schema, migrations, SQL queries, indexes, transactions, or persistence behavior in Zwei.
---

# Zwei Database and Migration Guidance

## Ownership and boundaries

- PostgreSQL schema changes belong in the repository's migration system; inspect neighboring migrations and migration runners before editing.
- Keep SQL and database-specific behavior inside infrastructure/repository adapters. Domain and application packages must not depend on SQL, PostgreSQL drivers, or migration details.
- Keep migration files ordered and consistent with the existing naming and up/down conventions. Do not rewrite an already-applied migration to change deployed state; add a new migration.
- Load `zwei-architecture`, `zwei-go`, and `zwei-quality` with this skill. Consult `zwei-dba` for non-trivial schema, query-plan, concurrency, or rollout decisions.

## Migration design

- Assess compatibility with both the currently deployed application and the candidate application. Prefer expand/migrate/contract when old and new application versions can overlap.
- Make rerun behavior and transaction behavior explicit according to the repository's migration runner. Do not assume DDL is transactional without verifying the PostgreSQL operation and runner.
- For destructive changes, identify affected data, backfill/retention needs, rollback feasibility, and what happens if deployment stops between steps. Do not silently drop or irreversibly transform user data.
- Preserve constraints that encode business invariants. Add appropriate foreign keys, unique constraints, nullability, and check constraints only after validating existing data and deployment sequencing.
- Treat index creation and large-table locking as operational concerns; inspect table size/workload assumptions and use the repository's supported PostgreSQL version and migration patterns.
- Keep down migrations honest: if an operation cannot restore data, state that limitation in the review/plan rather than implying a lossless rollback.

## Query and concurrency review

- Parameterize values; never concatenate untrusted input into SQL identifiers or expressions.
- Review query count, selected columns, pagination, ordering stability, and indexes for the actual access pattern. Avoid speculative indexes without a demonstrated query need.
- Use transactions for invariants spanning multiple writes. For counters, cursors, token consumption, or concurrent claims, reason about isolation/locking and test competing operations rather than relying on a happy path.
- Preserve monotonic cursor and durable-delivery semantics: a cursor cannot move backward or exceed persisted message state, and delivery advances only after successful socket queue admission.
- Ensure repository methods propagate context cancellation and close rows/resources on every path.

## Verification

- Add migration tests or integration coverage using the existing test database setup for schema and repository behavior.
- Verify both fresh-database migration and upgrade-from-supported-schema paths when practical; test migration reruns where the deployment path requires it.
- Run local database/application checks only through the Docker-backed Make workflow in `AGENTS.md`. Never point destructive migration or test commands at production or the development database when the E2E runner expects an isolated database.
- Report exact migration/test commands, data-loss/locking risks, backward-compatibility assumptions, and any untested rollback path.
