# Development and operations

## Local development

Local application, dependency, and browser-test commands run through Docker Compose and the repository Make targets. The supported local workflow requires Docker with the Compose plugin and `make`; it does not require host-installed Go, Node/npm, PostgreSQL, Redis, or Playwright.

```sh
make build
make migrate
make trust-local-ca   # macOS, once
make start
```

Open `https://chat.localhost` after trusting the generated certificate. Use `make help` and `make -C infrastructure help` to list commands.

Useful checks:

```sh
make test
make frontend-spec SPEC=src/app/home/home.component.spec.ts
make -C infrastructure frontend-test
make frontend-build
make e2e-one SPEC=tests/chat-flow.spec.ts TEST='direct messaging'
make e2e-parallel
make e2e-turn
```

`make e2e` and `make e2e-one` use the shared development Compose project, reset the reserved E2E database and Redis DB, and temporarily stop/recreate development auth/chat/realtime. Do not run them while relying on those services. `make e2e-parallel` uses two isolated disposable Compose projects and does not reset the development stack. Preserve and inspect artifacts in `e2e/test-results/` after browser runs. See `AGENTS.md` for the full local test lifecycle.

## GitHub checks and first release

Pull requests and pushes to `main` run `.github/workflows/ci.yml` and `.github/workflows/security.yml`. A published GitHub Release calls those same workflows against the release commit; image publishing and automated deployment wait for both to pass. The deployment publishes ARM64 images to GHCR and uses the separate production Compose setup. It does not probe public endpoints or security headers; those checks and browser acceptance are manual operator steps described in [`infrastructure/production/DEPLOYMENT.md`](../infrastructure/production/DEPLOYMENT.md).

Configure runtime secrets on the VM, not in source, GitHub variables, image build arguments, or browser configuration. In particular, `GIPHY_API_KEY` belongs only in the Auth runtime environment. The browser receives it only after an authenticated user explicitly starts GIPHY search; it is public to that browser and cannot be made secret by a short client-side cache lifetime. GIPHY receives search terms and client network metadata directly.

For the push fingerprint key's shared Auth/Realtime identity and deliberate re-key procedure, see [`push-fingerprint-key-operations.md`](push-fingerprint-key-operations.md).

Push subscription encryption keys must match between Auth and Realtime. V1 is
32 random bytes encoded as 64 hex characters. Encryption-key rotation is
staged: deploy the new v2 key to both services while retaining v1, switch both
services to v2 for new rows, and keep v1 configured until no v1-encrypted rows
remain. The fingerprint key is separate from encryption keys; changing the
VAPID key pair requires browsers to enroll again.

GIPHY is a direct browser integration, not a media proxy. Search terms and
client network metadata go to GIPHY. Apply provider-side origin restrictions
and quotas where available; the key is observable by users and cannot be made
secret or revoked by the app's local cache policy. With a runtime key configured
in the local Compose environment, run the opt-in live-provider browser check
with `GIPHY_LIVE_E2E=1 make e2e-parallel`; it exercises the authenticated key
grant, live G-rated search, and CDN preview. The test disables Playwright trace
capture because the public key appears in the provider request URL.

## Support-log export

After support logging is configured, export only realtime JSON log records whose top-level `support_ref` exactly equals the supplied UUID. Locally, run `make support-export SUPPORT_REF=<uuid>` (optional `WINDOW=30m`, up to `24h`). On the VM, from the production Compose directory, run:

```sh
python3 export-realtime-logs.py <uuid> --window 30m
```

The exporter validates the UUID/window before invoking Docker, does not follow logs or upload data, examines at most 20,000 lines / 32 MiB, and writes at most 1,000 matching records / 2 MiB. Its default JSONL output is created in the operator's home directory with mode `0600`; an existing path is never overwritten. Python 3 and the Docker Compose plugin are required on the VM.

Treat exports as sensitive. A support reference is an opaque correlation ID, not an access credential, but production Redis AOF, snapshots, and backups may retain prior state after the live key expires. Restrict access to persistence files and backups; do not promise immediate erasure. Verify the VM host key before copying an export to a private local directory, review it, remove unnecessary records, and share only through an approved private channel. Production Docker JSON logs are size-capped and rotate, so they are not durable audit storage and an export may be incomplete.
