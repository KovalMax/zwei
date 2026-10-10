# Zwei

<p align="center">
  <img src="assets/zwei-logo.svg" alt="Zwei logo" width="112">
</p>

<h2 align="center">Private conversations, deliberately simple.</h2>

<p align="center">
  Zwei is a private, server-mediated messaging app for direct and small-group conversations.
  It is designed for focused conversations rather than a public social feed.
</p>

## What Zwei is about

- **Direct and small-group conversations** — direct chats and groups of up to 16 active members keep attention on the people, not a feed. Group member lists show display names and roles, not email addresses.
- **Audio calls** — direct calls are available one-to-one, and group calls support up to four participants at once.
- **A live sense of connection** — messages, presence, typing, delivery recovery, and read state work together naturally.
- **Privacy with accurate language** — Zwei protects application data and browser sessions, but messages are server-mediated; this is not end-to-end encryption.
- **A considerate interface** — dark and light themes, responsive layouts, keyboard-visible focus, reduced motion, and clear empty/loading/error states.

## Tech stack

- Angular 22 and TypeScript for the browser client
- Go services for authentication, chat, and real-time messaging
- PostgreSQL for durable application data
- Redis for shared realtime coordination and rate limiting
- Docker Compose for reproducible local development
- Playwright for browser-level verification

## Local development and testing

Local application, dependency, and browser-test commands run in Docker Compose; the host needs Docker with the Compose plugin and `make`. Do not install or run Go, Node/npm, PostgreSQL, Redis, or Playwright directly on the host for the supported local workflow.

```sh
make build
make migrate
make trust-local-ca   # macOS, once
```

`make build` builds and starts the development stack. Open `https://chat.localhost` after trusting the generated local certificate. For subsequent starts use `make start`.

Useful local checks (run from the repository root):

```sh
make test
make frontend-spec SPEC=src/app/home/home.component.spec.ts
make -C infrastructure frontend-test
make frontend-build
make e2e
```

The Playwright suite runs in an isolated Docker Compose test environment with its own database and Redis namespace. It temporarily stops and recreates the development auth/chat/realtime services while running; do not run E2E concurrently against the same Compose project. Mailpit is available in the local stack for inspecting test activation messages. See `make help` and `make -C infrastructure help` for supported targets.

## GitHub checks and releases

Pull requests and pushes to `main` run `.github/workflows/ci.yml`: Go formatting and vet checks, Go race tests with PostgreSQL/Redis Compose dependencies, Angular headless tests with coverage and a production build, and the Playwright E2E suite. `.github/workflows/security.yml` verifies Go module checksums, runs the pinned Go vulnerability scan, and audits the frontend and E2E npm lockfiles.

Publishing a GitHub Release triggers `.github/workflows/release.yml`. It verifies the tagged source, publishes the application and migration images to GHCR for `linux/arm64`, then deploys that release to the production VM. Configure a GitHub Environment named `production` with these values:

| Kind | Name | Purpose |
| --- | --- | --- |
| Secret | `DEPLOY_HOST` | VM SSH host |
| Secret | `DEPLOY_KNOWN_HOSTS` | Previously verified SSH host key entry; deployment enforces strict host-key checking |
| Secret | `DEPLOY_SSH_PRIVATE_KEY` | Private key for the deployment user |
| Variable | `DEPLOY_USER` | VM deployment account |
| Variable | `DEPLOY_PATH` | Dedicated remote deployment directory |

The VM must be Linux ARM64 with Docker Engine, the Docker Compose plugin, and `rsync`; a deployment account/path accessible by SSH; DNS for the production hostnames; inbound TCP 80/443 and TURN TCP/UDP 3478 plus UDP 49160–49200; a populated VM-owned `.env` based on `infrastructure/production/.env.example`; and the configured KYC htpasswd file stored outside `DEPLOY_PATH`. The production `.env` must include the required database, application, SMTP, TURN shared-secret, TURN external-IP, and proxy/IP allowlist settings. Keep application/runtime secrets and the KYC htpasswd file on the VM. Put the SSH deployment key, host, and verified known-hosts entry only in the GitHub `production` environment secrets; never place secrets in GitHub variables or repository files.

The release workflow synchronizes `infrastructure/production/` over strict-host-key SSH using `rsync --delete`. It preserves `.env` and `.deploy.env`; other files inside `DEPLOY_PATH` may be removed, so use a dedicated directory and keep unrelated data elsewhere. The workflow writes the selected release tag to `.deploy.env`, pulls the production images, starts database and Redis, runs migrations, recreates the services, and probes public HTTPS health and security headers. The production Compose configuration is separate from the local development configuration. Review `.github/workflows/release.yml` and `infrastructure/production/` as the operational source of truth; no manual VM bootstrap procedure is provided here.

## Browser PWA installation

Zwei is a browser PWA, not a signed native application. It is served over HTTPS
and supports the browser's PWA installation flow where available. Installation
prompts and installed-app behavior vary by browser and operating system. Do not
install a copied or downloaded `.app` bundle. If the interface appears stale
after deployment, use **Update available — Reload** from the account menu.

## Contributing

Contributions are welcome. Run local checks through the Docker-backed Make targets above. GitHub Actions runs the CI and security checks on pull requests and pushes to `main`; CI's runner commands are not a substitute for the supported local Docker workflow.

A simple contribution workflow:

1. Fork the repository and create a focused branch.
2. Make the smallest coherent change that preserves existing behavior.
3. Add focused tests for new domain, service, adapter, frontend, or browser behavior.
4. Run the relevant Docker-backed checks before opening a pull request.
5. Review the diff for accidental files, leaked credentials, misleading product claims, and accessibility regressions.

Please keep secrets, local environment files, generated test artifacts, and private configuration out of commits. For larger product or compatibility decisions, open an issue first so the behavior and protocol boundaries can be discussed before implementation.
