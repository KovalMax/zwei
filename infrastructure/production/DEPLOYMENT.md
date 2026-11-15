# Production deployment and shared edge

This runbook describes the production edge migration and ongoing automated
release path. Local development continues to use
`infrastructure/docker-compose.yml`; this directory contains the separate
ARM64 production application Compose setup.

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
files or data in that directory. Create a VM-owned `.env` from `.env.example`.
Protect it and never commit its values. Configure registry access on the VM if
the GHCR packages are private.

## Shared Traefik edge

The edge Compose project (`compose.yaml` and `Makefile` from the shared-traefik
configuration) should be copied to `~/traefik/` on the VM; it alone owns host
ports 80/443, the Let's Encrypt resolver, and certificate storage. It must create a
Docker network named `public-edge` on a subnet that does not overlap any VM
network. The configuration in this repository assumes `172.30.0.0/24` with the
Traefik container fixed at `172.30.0.250`. Set
`TRUSTED_PROXY_CIDRS=172.30.0.250/32` in Zwei's VM `.env`; this value must match
the actual central Traefik address. If you choose another subnet/address,
update the Compose network, this setting, and the Horizon integration contract
together.

Use the same VM account for the edge Compose project and the app release
workflows so their `~/traefik/dynamic/` paths refer to one directory. Configure
Traefik's file provider to watch `~/traefik/dynamic/` (mounted into the container
as a directory, with watching enabled). Keep the project route files separate:
the Zwei release workflow atomically installs
`infrastructure/production/traefik/dynamic.yml` as `zwei.yml`; Horizon installs
its own `horizon.yml`. Do not use `rsync --delete` against the shared route
directory. The central Compose project must also mount the KYC htpasswd file
read-only at `/run/secrets/kyc.htpasswd` for the existing KYC Basic Auth
middleware. Keep that host file and the central Traefik `.env` outside both app
deployment directories.

For the first migration, use a maintenance window. The current Zwei-owned
Traefik still holds ports 80/443 and its app containers are on the old
`zwei_edge` network. The cutover requires a short period of unavailable public
routes. Prepare and validate the central Compose project first; reuse the
existing Docker volume `zwei_traefik-acme` for ACME state so certificates are
retained. Stage both route files into `~/traefik/dynamic/` before starting the
new proxy. Then run these targeted steps:

1. From Zwei's current VM deployment directory, stop and remove only its old
   Traefik service while the old Compose file still defines it:

   ```sh
   docker compose stop traefik
   docker compose rm -f traefik
   ```

2. Start the standalone Traefik Compose project. The application services are
   still on `zwei_edge`, so routes may return 502 until their next deploy.
3. Deploy the updated Zwei release so its application containers join
   `public-edge`, then deploy Horizon. Verify health endpoints, HTTPS
   certificates, and KYC Basic Auth.

Do not run `docker compose down -v` or remove either application's
database/Redis volumes. The release workflows never stop or reconfigure the
standalone Traefik project.

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

The VM must be able to pull the published images. The deployment script stops
and health-checks the application services, applies migrations, and starts the
candidate application. It does not stop, restart, or reconfigure shared
Traefik; route changes are picked up from the watched directory. Public endpoint
and security-header checks are intentionally manual: after the workflow
completes, create the initial administrator, then run them from the VM console
and complete browser acceptance before inviting users.

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

If deployment fails, the workflow stops the Zwei application services; the
independently managed public edge remains running. The workflow does not roll
back images or migrations. If deployment fails or state is uncertain, inspect
workflow logs and VM/container/database state before retrying. Do not remove or
recreate the shared edge, ACME, PostgreSQL, or Redis volumes as a recovery step.
Do not start older application images against a database changed by a newer
migration; recovery requires a reviewed forward fix or an approved database
restore with its data-loss consequences understood.
