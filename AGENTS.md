# Repository Agent Guidance

## Local runtime and command execution

The local Zwei development and browser-test environment runs in **Docker Compose only**. Do not assume the host has Go, Node/npm, Angular CLI, PostgreSQL, Redis, or Playwright browser dependencies installed. Run local application, build, and test commands through the repository's Docker-backed Make targets or service containers; direct host commands belong to GitHub-hosted workflow runners, not local setup.

Run commands from the repository root unless noted. The root `Makefile` delegates infrastructure operations to `infrastructure/Makefile`; use these as the normal interface:

| Purpose | Command |
| --- | --- |
| Show supported targets | `make help` |
| Start/recreate local stack | `make start` |
| Stop/remove local stack | `make stop` |
| Build/recreate all development images | `make build` |
| Run migrations | `make migrate` |
| Follow service logs | `make logs` |
| Run one Angular spec in the already-running frontend container | `make frontend-spec SPEC=src/app/home/home.component.spec.ts` |
| Run the production Angular build in the already-running frontend container | `make frontend-build` |
| Run full isolated Playwright suite | `make e2e` |
| Run one Playwright test through isolated setup/teardown | `make e2e-one SPEC=tests/chat-flow.spec.ts TEST='direct call offers and answers connect in the browser UI'` |
| Run service command in a container | `make exec <service> <command...>` |

Use a fast feedback loop during implementation. These focused frontend commands use the **already-running** frontend container and do not start or recreate the Compose stack; run `make start` once if it is not up. `frontend-test` remains available for the full Angular suite, but its dependency starts/recreates the stack, so prefer `frontend-spec` while iterating:

```sh
make frontend-spec SPEC=src/app/home/home.component.spec.ts
make frontend-build
# Milestone: run all Angular specs
make -C infrastructure frontend-test
```

For browser diagnosis, use `make e2e-one SPEC=tests/<file>.spec.ts TEST='<test title or unique title substring>'` to run matching test case(s); omitting `TEST` selects the whole spec. The title is escaped and passed only as a literal Playwright `--grep` substring, not arbitrary CLI flags, regex, or shell syntax. This still uses the full isolated E2E setup and teardown. E2E runs reset the test database and Redis DB 1 and temporarily stop/recreate development `auth`, `chat`, and `realtime`, so do not run E2E commands concurrently against the same Compose project. Preserve and inspect artifacts in `e2e/test-results/`.

The E2E runner fails closed if development configuration points at the reserved `messenger_test` database or Redis DB 1, because those namespaces are reset for E2E.

Run `make e2e` once at final browser acceptance; a focused spec does not replace the full suite. `infrastructure/scripts/e2e.sh` owns setup/teardown: it migrates the isolated test database, flushes Redis DB 1, creates the E2E admin, runs Playwright, and then recreates the development auth/chat/realtime services. Prefer the Make targets over invoking Playwright directly.

## When direct Docker Compose commands are appropriate

Use direct Compose only when a Make target cannot express the required operation (for example, rebuilding just the copied frontend/E2E images, forcing one service recreation, or probing health). Preserve the repository topology, Compose project name, base/override/test files, artifact mount, and database/Redis isolation. Do not invent a second stack or bypass the setup in `infrastructure/scripts/e2e.sh` for focused or full E2E runs.

The canonical Compose files and project are:

```sh
docker compose -p messenger \
  -f infrastructure/docker-compose.yml \
  -f infrastructure/docker-compose.override.yml
```

Before browser tests whose source is copied into images:

```sh
docker compose -p messenger \
  -f infrastructure/docker-compose.yml \
  -f infrastructure/docker-compose.override.yml \
  build frontend e2e
docker compose -p messenger \
  -f infrastructure/docker-compose.yml \
  -f infrastructure/docker-compose.override.yml \
  up -d --force-recreate frontend
```

Before browser tests whose source is copied into images, rebuild frontend/E2E images and recreate frontend as shown above. Wait for Angular's `Application bundle generation complete` in frontend logs (and verify HTTPS readiness) before `make e2e-one` or `make e2e`. Both targets preserve `e2e/test-results/` screenshots/traces; inspect passing visual artifacts as well as failures. Never use the development database for browser tests.

Do not stop or remove the user's existing development stack unless the requested workflow requires it. E2E cleanup restores development auth/chat/realtime services; verify their health if startup/teardown was interrupted.

## Change discipline

- Inspect current source, package boundaries, scripts, and tests before editing. Keep unrelated dirty-worktree changes intact.
- Use the project skills and feature acceptance plan where applicable. For visual changes, reproduce the rendered state and assert computed geometry, contrast, and control overlap; do not infer success from CSS declarations or a green test alone.
- Keep Go domain/application boundaries infrastructure- and transport-independent. Keep Angular transport behind typed services/facades and use component outputs for presentation intents.
- Preserve protocol, persistence, permissions, secrets, media ownership, cancellation, and resource cleanup. Add regression tests for behavior changes.
- Run focused tests first, then full package/workspace gates appropriate to the change. Do not change tests, thresholds, or budgets merely to hide a failure.

## Product and operational source of truth

- Zwei supports direct and small-group messaging and audio calls. It is server-mediated and is not end-to-end encrypted.
- Local development/testing uses the Docker Compose stack and Make targets. GitHub Actions runs CI/security checks on hosted runners; keep local commands distinct from CI commands.
- Production deployment is triggered by a published GitHub Release and uses the separate `infrastructure/production/` Compose setup, GHCR images, and strict-host-key SSH to the VM. Keep deployment secrets on GitHub's `production` environment or the VM, never in the repository. Use the workflows and production Compose files as the source of truth.
