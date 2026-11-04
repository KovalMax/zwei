# Initial production deployment

This runbook describes the first deployment and the ongoing automated release
path. No existing release, client fleet, or production database is assumed.
Local development continues to use `infrastructure/docker-compose.yml`; this
directory contains the separate ARM64 production Compose setup.

## Before the first release

Provision a Linux ARM64 VM with Docker Engine, the Docker Compose plugin, and
`rsync`. Point the production hostnames at the VM and allow TCP 80/443, TURN
TCP/UDP 3478, and UDP 49160–49200. The app uses `chat.false.tel`,
`kyc.chat.false.tel`, `auth.chat.false.tel`, `api.chat.false.tel`,
`ws.chat.false.tel`, and `turn.chat.false.tel`; change the deployment
configuration and edge policy together if using other hostnames.

Set `DEPLOY_PATH` to the absolute path of a dedicated deployment directory; it
may be outside `/opt/zwei`. The release workflow rejects relative paths and
unsafe path syntax, then verifies the remote canonical path before running its
destructive sync. The directory must be owned by the deploy user and must be
provisioned before the first release (the deploy user must be able to create a
child directory when one is selected). The release workflow synchronizes
`infrastructure/production/` there with
`rsync --delete`, excluding only `.env` and `.deploy.env`; do not store unrelated
files or data in that directory. Create a VM-owned `.env` from `.env.example`
and keep the KYC htpasswd file at an absolute path outside `DEPLOY_PATH`.
Protect both files and never commit their values. Configure registry access on
the VM if the GHCR packages are private.

Set up the GitHub `production` environment:

- Secrets: `DEPLOY_HOST`, `DEPLOY_KNOWN_HOSTS` (verified host key),
  `DEPLOY_SSH_PRIVATE_KEY`.
- Variables: `DEPLOY_USER`, `DEPLOY_PATH`.

Use independent random values for application and TURN secrets. Set the same
push encryption and fingerprint keys and VAPID public key for Auth and
Realtime; only Realtime receives the VAPID private key and subject. See
`docs/push-fingerprint-key-operations.md` for the push fingerprint-key
invariant. Keep `GIPHY_API_KEY` in the Auth VM environment only. Do not place
application/runtime secrets in GitHub variables, build arguments, or browser
configuration.

## Publish and deploy

Publish a GitHub Release for the intended source commit. The release workflow
runs Go tests and Angular tests/production build against that exact commit
before publishing the five ARM64 images (Auth, Chat, Realtime, Frontend, and
Migrator). Full CI and Security workflows remain enabled on pull requests and
pushes to `main`; the release does not repeat them. It deploys the commit-SHA
image tag through strict-host-key SSH and the protected
`production` environment. The deploy is serialized with other release jobs.

The VM must be able to pull the published images. The deployment script checks
the required KYC credential mount before stopping services, then stops the
edge and application services, applies migrations, starts and health-checks
the candidate application, and reopens the edge. Public endpoint and
security-header checks are intentionally manual: after the workflow completes,
create the initial administrator, then run them from the VM console and complete
browser acceptance before inviting users.

On the first deployment only, bootstrap the administrator after the release
workflow has completed successfully and the Auth service is healthy. From the
deployment directory, load the VM-owned Compose settings and run the Auth
container's interactive command:

```sh
set -a
. ./.env
. ./.deploy.env
set +a
docker compose run --rm --no-deps auth /usr/bin/service admin create
```

Enter the administrator email, display name, and a strong unique password at
the prompts. The password is read interactively; do not put it in shell history,
command arguments, or deployment configuration. This account unlocks the KYC
admin UI for approving pending registrations.

From the VM console, verify valid HTTPS certificates and these results:

- `https://chat.false.tel/` serves the app shell.
- `https://kyc.chat.false.tel/` returns the expected `401` Basic Auth challenge.
- `/health/ready` succeeds on `auth.chat.false.tel`, `api.chat.false.tel`, and
  `ws.chat.false.tel`.
- POST `{}` to
  `https://auth.chat.false.tel/api/auth/activate?token=invalid` returns `400`.
- The chat response has
  `Permissions-Policy: geolocation=(), microphone=(self), camera=()` and a CSP
  with exactly one `connect-src` directive containing
  `https://media.giphy.com` and `https://media0.giphy.com` through
  `https://media4.giphy.com`, and no removed font origin such as
  `fonts.googleapis.com`.

Then use a supported browser to sign in, exercise direct and group messaging
over `/ws/v4`, and verify calls/TURN and push as configured. Check that no
secrets or bearer values appear in logs.

## Data protection and failed deployments

The first installation has no previous production backup to restore. Before
accepting real user data, configure and test a database backup and recovery
procedure. Before later releases that can modify user data, take and verify a
backup and review the migration's recovery implications before publishing.

The workflow attempts to close the public edge if deployment fails; it does not
roll back images or migrations. If deployment fails or state is uncertain,
inspect workflow logs and VM/container/database state before retrying. Keep the
edge closed until the candidate is healthy and an operator accepts the result.
Do not start older application images against a database changed by a newer
migration; recovery requires a reviewed forward fix or an approved database
restore with its data-loss consequences understood.
