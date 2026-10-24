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
| Run full serial Playwright suite | `make e2e` |
| Run full Playwright suite in two isolated local groups | `make e2e-parallel` |
| Run one Playwright test through isolated setup/teardown | `make e2e-one SPEC=tests/chat-flow.spec.ts TEST='direct call offers and answers connect in the browser UI'` |
| Run service command in a container | `make exec <service> <command...>` |

Use a fast feedback loop during implementation. These focused frontend commands use the **already-running** frontend container and do not start or recreate the Compose stack; run `make start` once if it is not up. `frontend-test` remains available for the full Angular suite, but its dependency starts/recreates the stack, so prefer `frontend-spec` while iterating:

```sh
make frontend-spec SPEC=src/app/home/home.component.spec.ts
make frontend-build
# Milestone: run all Angular specs
make -C infrastructure frontend-test
```

For browser diagnosis, use `make e2e-one SPEC=tests/<file>.spec.ts TEST='<test title or unique title substring>'` to run matching test case(s); omitting `TEST` selects the whole spec. The title is escaped and passed only as a literal Playwright `--grep` substring, not arbitrary CLI flags, regex, or shell syntax. `make e2e` and `make e2e-one` use the shared local Compose project, reset its test database and Redis DB 1, and temporarily stop/recreate development `auth`, `chat`, and `realtime`; do not run these commands alongside work that needs those services. For local parallel speed, use `make e2e-parallel`: it runs two file-based groups (chat-flow and remaining specs) in separate disposable Compose projects, each with its own database, Redis, Mailpit, app services, network, volumes, and output directory. It does not stop or reset the development project, publishes no group ports, and permits one parallel invocation per workspace. Preserve and inspect artifacts in `e2e/test-results/`.

The E2E runner fails closed if development configuration points at the reserved `messenger_test` database or Redis DB 1, because those namespaces are reset for E2E. E2E `BASE_URL` and `ADMIN_BASE_URL` must remain the local HTTPS hosts; the harness rejects external overrides. `make e2e-parallel` requires Docker Compose v2.24.4 or newer for Compose override tags and fails before startup if either fixed test subnet overlaps an existing Docker network.

Run the appropriate full suite at final browser acceptance; focused specs do not replace it. The existing `infrastructure/scripts/e2e.sh` owns the serial shared-project workflow. The `infrastructure/scripts/e2e-parallel.sh` parent owns two independent projects and coordinated cleanup; each group process migrates only its own test database, flushes only its own Redis DB 1, creates its own admin, and retains separately scoped Playwright output. Prefer Make targets over invoking Playwright directly.

## When direct Docker Compose commands are appropriate

Use direct Compose only when a Make target cannot express the required operation (for example, forcing one service recreation or probing health). Preserve the repository topology, project-specific files, artifact mount, and database/Redis isolation. The parallel target intentionally uses `docker-compose.e2e-parallel.yml` with two generated project names, non-overlapping subnets, internal proxy/TURN addresses, and no published host ports; do not bypass its lifecycle or clean up by broad container/image patterns.

The canonical Compose files and project are:

```sh
docker compose -p messenger \
  -f infrastructure/docker-compose.yml \
  -f infrastructure/docker-compose.override.yml
```

Before browser tests whose source is copied into images for the shared development project:

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

Before `make e2e-one` or `make e2e`, rebuild frontend/E2E images and recreate frontend as shown above when copied sources changed; wait for Angular's `Application bundle generation complete` and verify HTTPS readiness. `make e2e-parallel` builds the E2E runner and the frontend image for each project before starting groups, then builds the shared production bundle once. All targets preserve `e2e/test-results/` artifacts; inspect passing visual artifacts as well as failures. Never use the development database for browser tests.

Do not stop or remove the user's existing development stack unless the requested workflow requires it. The serial `e2e` workflow restores development auth/chat/realtime services; the parallel workflow tears down only its unique E2E projects. Verify development-service health after browser runs or interrupted cleanup.

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
