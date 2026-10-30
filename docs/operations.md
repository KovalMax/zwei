# Zwei development and operations

Realtime read-event fan-out uses only the `recipient_ids` Redis payload. Deploy
realtime replicas together: an older publisher that sends only `recipient_id`
will not deliver those read updates to a newer consumer during a mixed-version
rollout. Read cursors remain durable and can be recovered by reloading.

Group membership outbox processing concerns the membership projection, not
delivery of a group-call terminal event. Realtime keeps membership-retirement
evidence in Redis for at most 60 seconds and retries terminal publication while
it remains available. Once evidence expires or is lost, the outbox can complete
the projection without another terminal publication. Redis Pub/Sub acceptance
and an outbox processed marker do not prove any client received either event.

Connected group-call observers reconcile by discovery; participating clients
reconcile ownership and stop media on confirmed absence or repeated verification
failure. These depend on a responsive client and network and have no guaranteed
deadline. A removed member's projection refresh also triggers local cleanup.
Server-side membership and signaling checks do not forcibly revoke an already
established peer-to-peer media path or control an uncooperative client.

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
make e2e-parallel
```

`make e2e` runs the serial Playwright suite with a reserved test database and Redis DB in the shared local Compose project; it temporarily stops and recreates development auth/chat/realtime, so do not use it while relying on those services. For faster local feedback, `make e2e-parallel` runs two file-based Playwright groups concurrently in separate disposable Compose projects: `chat-flow` and the remaining specs. Each group has one Playwright worker and its own database, Redis, Mailpit, application services, network, volumes, and artifacts; the groups cover every discovered spec exactly once and neither stops or resets the development stack. The parallel target requires Docker Compose v2.24.4 or newer, is capped at two groups, uses additional CPU/memory, and allows only one parallel-suite invocation per workspace. It accepts only the local HTTPS test hosts `chat.localhost` and `kyc.localhost`; it refuses custom URLs to avoid sending test credentials or traffic to unintended services. Both targets use disposable E2E data, not the development database. Mailpit in the development stack remains available for inspecting development messages. See `make help` and `make -C infrastructure help` for supported targets.

## GitHub checks and releases

Pull requests and pushes to `main` run `.github/workflows/ci.yml`: Go formatting and vet checks, Go race tests with PostgreSQL/Redis Compose dependencies, Angular headless tests with coverage and a production build, and the Playwright E2E suite. `.github/workflows/security.yml` verifies Go module checksums, runs the pinned Go vulnerability scan, and audits the frontend and E2E npm lockfiles.

Publishing a GitHub Release triggers `.github/workflows/release.yml`: it verifies the tagged source, publishes ARM64 images, and automatically synchronizes, migrates and deploys to the production VM, then probes public HTTPS. For the browser-session cutover, establish and externally verify a maintenance barrier, stop all Auth and Realtime replicas and the public edge, and take and verify a backup **before publication**. Keep the barrier in place until migration and deployment are complete. Coordinate all deployments and inspect the workflow's state before any manual VM-console cutover. Public probes may fail behind the barrier; failure does not undo the deployment.

Migration 0027 irreversibly deletes all existing Web Push registrations during the cutover; users must re-enable push on their browsers after deployment. A binary rollback cannot restore these registrations. Communicate this interruption before release and verify enrollment and delivery after the barrier is lifted.

Configure the GitHub `production` environment: secrets `DEPLOY_HOST`, `DEPLOY_KNOWN_HOSTS` (previously verified SSH host key), and `DEPLOY_SSH_PRIVATE_KEY`; variables `DEPLOY_USER` and `DEPLOY_PATH`. The workflow uses strict-host-key SSH and `rsync --delete`, preserving only `.env` and `.deploy.env` in the deployment directory. Keep stages, unrelated data, and the KYC htpasswd outside that directory.

Set `GIPHY_API_KEY` in the auth service's runtime environment: use the local Compose `.env` based on `infrastructure/.env.dist`, and set it in the production VM's `.env` based on `infrastructure/production/.env.example`. Do not put it in GitHub variables, frontend build arguments, or browser runtime configuration. A key value is intentionally omitted here.

The authenticated browser requests the key only when a user explicitly starts their first GIPHY Search. The auth service grants it only while the global GIPHY policy is enabled and a key is configured. The Angular service keeps a successful grant in memory for 15 minutes from receipt; searches do not extend this local TTL. This TTL controls only Zwei's local copy: the GIPHY key is public and extractable from browser network requests, can be copied and used outside Zwei, and cannot be revoked by disabling the Zwei policy. The browser calls GIPHY directly as required by GIPHY; search terms and client network metadata are sent to GIPHY, and the chat app does not proxy or cache GIF media. Configure provider-side origin restrictions and quota monitoring where available, but do not treat the key or client policy as secret/revocation controls.

With a configured runtime key, run the opt-in real-provider browser check using `GIPHY_LIVE_E2E=1 make e2e-parallel`. It exercises the authenticated key grant, live G-rated search, and CDN preview; its Playwright trace is disabled because GIPHY requires the public key in the request URL.

The VM must be Linux ARM64 with Docker Engine, the Docker Compose plugin, and `rsync`; an operator-controlled deployment path; DNS for the production hostnames; inbound TCP 80/443 and TURN TCP/UDP 3478 plus UDP 49160–49200; a populated VM-owned `.env` based on `infrastructure/production/.env.example`; and the configured KYC htpasswd file stored outside `DEPLOY_PATH`. The production `.env` must include the required database, application, SMTP, TURN, proxy/IP allowlist, and Web Push settings. For push, configure `PUSH_SUBSCRIPTION_ENCRYPTION_KEY_V1` (32 random bytes encoded as 64 hex characters), `PUSH_SUBSCRIPTION_FINGERPRINT_KEY` (at least 32 random bytes encoded as hex), a matching `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` pair, and a valid public `VAPID_SUBJECT` such as `https://chat.false.tel/` or a monitored `mailto:` address. Auth and realtime must have identical values for both stored-subscription keys and the VAPID public key; only realtime receives the VAPID private key and subject. Keep `PUSH_SUBSCRIPTION_ENCRYPTION_CURRENT_VERSION=v1` for initial deployment; leave `PUSH_SUBSCRIPTION_ENCRYPTION_KEY_V2` empty unless performing the staged rotation described below. Losing the fingerprint key makes subscriptions unfindable, while losing an encryption key makes rows encrypted with it unreadable. Changing the VAPID pair requires browsers to enroll again. Do not copy generated secrets into this repository or GitHub workflow variables. Keep application/runtime secrets and the KYC htpasswd file on the VM. Never place secrets in GitHub variables or repository files.

The workflow writes the release tag to `.deploy.env`, pulls images, starts database and Redis, runs migrations, recreates services, and probes public HTTPS. Migration 0024 revokes sessions once; its manual rerun does not repeat that revocation. For this release, confirm all production runtime settings and persistent push keys are present. WebSocket `/ws/v3` is the only supported route; older clients must reload or update. Drain old realtime replicas and sockets before reopening traffic, and deploy frontend, chat and realtime together. Rollback requires restoring matching frontend, chat and realtime versions and draining sockets again. Migrations 0017–0022 establish subscription ownership, notification outbox, key identity, and bounded terminal-outbox retention; they run before candidate services start and do not drop push data. The worker purges terminal push-outbox identifiers after 30 days in bounded batches; pending work and active claims are not eligible. Rows purged under this retention policy are not restored by binary rollback. Keep the existing fingerprint key and encryption v1 key unchanged through upgrades and rollback; do not roll back by deleting the new subscription/outbox schema or rotating these keys. To intentionally rotate subscription encryption, back up the database and current keys, configure a new 32-byte hex v2 key on both auth and realtime while retaining v1 and current version v1, deploy that configuration, then set `PUSH_SUBSCRIPTION_ENCRYPTION_CURRENT_VERSION=v2` on both services and redeploy. Both versions must remain configured while rows encrypted under them exist; there is no bulk re-encryption path, so inactive browser subscriptions may keep v1 rows indefinitely. Do not remove v1 until `SELECT count(*) FROM push_subscriptions WHERE encryption_version = 'v1'` returns zero. This rotation changes encryption only; do not change the fingerprint key. After deployment, verify ready endpoints and browser enrollment/delivery with a supported browser, then validate direct/group message and call alerts, preference/offline suppression, click-through, logout cleanup, and logs for secret-free diagnostics. The production Compose configuration is separate from the local development configuration. Review `.github/workflows/release.yml` and `infrastructure/production/` as the operational source of truth.

### Private realtime support-log export

For a support investigation, export only realtime JSON log records whose top-level `support_ref` exactly equals the supplied UUID. Locally, run `make support-export SUPPORT_REF=<uuid>` (optional `WINDOW=30m`, up to `24h`). This uses the existing development Compose project. On the production VM, from the deployed `infrastructure/production` directory (the directory containing `.env` and `docker-compose.yml`), run:

```sh
python3 export-realtime-logs.py <uuid> --window 30m
```

The lookback defaults to 30 minutes; valid windows are positive integer seconds, minutes, or hours, capped at 24 hours. The exporter validates the UUID and window before invoking Docker, never follows logs, and does not upload anything. It handles Docker Compose's container-name prefix and timestamp, examines at most the last 20,000 Docker log lines / 32 MiB, and writes at most 1,000 matching records / 2 MiB. By default, the newly created JSONL file is placed directly in the user's home directory (including when run from the deployed directory) and is mode `0600`; `--output` can select another path. The command prints the selected path and reports its UTC window, empty results, and any safety-cap truncation. An existing output path is never overwritten. Python 3 and the Docker Compose plugin are required on the VM.

The support reference is an opaque correlation ID, not an access credential. It is stored with the existing TTL-bound Redis call state, but production Redis uses AOF persistence: expiration from the live keyspace does **not** securely erase earlier AOF records. Redis AOF rewrites can compact obsolete entries, and VM snapshots/backups may retain older files according to their own retention policy. Treat Redis persistence files and backups as sensitive operational data, restrict access, and apply the VM's normal backup retention/deletion controls; do not promise immediate erasure when the call expires.

Treat the export as sensitive. After verifying the VM host key is already in your `known_hosts`, copy it from the printed path in the VM user's home directory to a private local directory, then review it before sharing:

```sh
install -d -m 700 "$HOME/private-support"
scp -o StrictHostKeyChecking=yes <vm-user>@<verified-vm-host>:<export-file-path-under-home> "$HOME/private-support/"
less "$HOME/private-support/<export-file>"
```

Remove anything not needed and share only with the authorized support recipient over an approved private channel. Do not put it in a ticket with public access, commit it, or send it through a public route. The production realtime Docker `json-file` log is capped at 10 MiB per file and three files (30 MiB total). This bounds disk use but means older records rotate out; an export may be incomplete even when its output-cap status says complete. Do not treat Docker logs as durable audit storage.

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
