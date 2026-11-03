# Browser session v2 maintenance cutover

This release is v2-only; there is no release/VM feature-flag selection. The
cutover revokes existing sessions once (migration 0024), requiring sign-in
again. Cached tabs and service workers may still contain the old client; users
must reload/update the app. Verify the integrated v2 release before deployment.

Each manual cutover stages configuration in a unique directory outside `DEPLOY_PATH`;
never delete a stage while its containers use bind mounts from it. The VM-owned
`.env`, htpasswd and ACME volume remain outside stages. The deploy script requires
Linux `flock` and holds `.cutover.lock` under the deployment root. Only cutover script invocations using the same lock are serialized; independent Compose
commands are not fenced. The htpasswd path in `.env` must be absolute.

The manual script stops public Traefik and coturn, then auth, chat and realtime, and
verifies they are down before migration. The topology must remain the only path
to these services; no other proxy or published application port is allowed.
Candidate applications start with `--no-deps`. A private Traefik instance binds
only 127.0.0.1:8443 and uses the existing ACME certificates; local HTTPS probes
verify hostnames and certificates before public Traefik and coturn are started.
The VM must have valid, unexpired ACME certificates for every probed hostname;
the private edge cannot complete HTTP-01 challenges during maintenance.

On ordinary script failure or handled signals, the trap stops both public edge
services; no old applications are restarted. A failed Docker stop, SIGKILL, host
failure, or external automation can defeat cleanup, especially during public
commit. Verify container and network state before recovery; the script is not an
external network maintenance barrier. A manually stopped container stays stopped
across daemon restarts with `unless-stopped`.

Before publication take and verify a database backup and preserve the trusted,
matching old configuration and image tags as described below. If migration or startup fails, keep the edge closed; inspect state and
forward-fix or rerun the same candidate migration (0024 is transactionally
marked). Do not restart old images against the migrated database. To revert to
an older release, keep the edge closed, stop all application containers, restore
a verified pre-cutover database backup, assess and accept loss of all writes
since that backup, and deploy the matching old images/configuration together.
Reopening requires explicit operator verification; session revocation and newer
writes cannot be reversed by changing an image tag. Do not restore database or
reopen traffic until the backup and recovery consequences are approved.

## Manual VM console procedure

This is an operator procedure, not a local CI command. After image publication,
the release workflow synchronizes files and writes `.deploy.env`; its
`release-deploy.sh` preflights the KYC credential file and pulls images, then
checks the read-only credential mount in a network-isolated container to avoid
colliding with the live proxy's fixed IP. It then stops the public edge and
application writers, migrates, recreates the applications, reopens the edge,
then returns. It does not run public endpoint or security-header probes, take the
manual script's `.cutover.lock`, or roll back on failure. **Before publishing**,
coordinate and fence other operators and
automation, including queued/running GitHub deployments and independent Compose
commands, and take and verify the final backup. Do not assume the deployment
script serializes external writers or operators.
Before publication, record the currently running image tags and preserve a trusted
copy of their matching deployed configuration outside `DEPLOY_PATH`, where the
workflow's `rsync --delete` cannot replace or remove it. Verify the copy and tags
correspond to the running old release and are available for recovery; do not rely
on the deployment root or `.deploy.env` after publication. Protect any sensitive
configuration and VM-owned secrets using the approved secure backup procedure;
never print them or put them in an unprotected stage. Retain the existing push
keys and other required VM-owned configuration for the old release.
Keep the barrier effective even when the workflow recreates public services; the
script does not provide it. Plan for existing sessions to be revoked and users
to sign in again; old tabs and service workers may need updating.

The workflow does not verify public reachability or headers. After it finishes,
manually inspect its logs and the VM, migration, image, and container state, then
perform endpoint and security-header checks from the VM console. A successful
workflow does not by itself establish public availability. A failed
or incomplete deploy requires operator investigation; do not assume it is safe
to proceed or retry. If the
automatic migrator already applied 0024, the manual migration skips its revocation
because its marker and updates commit together; it does not revoke sessions a
second time. Stop if writers could have created sessions or data during the
window and assess consequences rather than relying on another revocation.

Before proceeding, verify that the pre-publication backup and preserved old
configuration and image tags remain available; record the backup time. Inspect
the currently running image tags and configuration separately as post-deployment
state, not as a substitute for the preserved old release. Any writes after
the backup will be lost if it is restored. Confirm the candidate's five ARM64
images (frontend, auth, chat, realtime and migrator) exist in the configured
registry, that the VM can pull them, and that the release has passed its gates.
Verify Docker Compose **2.24.4 or newer** (the private overlay uses
`!override`), `flock`, `curl`, `rsync`, the VM-owned `.env`, absolute
KYC htpasswd path, valid existing ACME certificates for all probed hosts, and
the existing `zwei` project/volumes. The fixed hostnames and 127.0.0.1:8443 in
the script must match the VM topology and that port must be available. Resolve
any missing prerequisite before continuing; do not bypass failed checks.
The script validates the merged private Compose configuration before stopping
services or running migrations; configuration validation errors abort without
changing the stack. Check the version with `docker compose version`.

After the automatic deployment is finished and its state accepted, obtain the exact trusted release's `infrastructure/production/` directory on
the VM, separately from the deployment root. Set these **non-secret** variables
in the VM console to its absolute path, the existing deployment root, and the
published image tag. Use the same approved release for both artifacts and tag.
The root `.env` is VM-owned shell input sourced by the script: protect and trust
it; do not print it, enable shell tracing, or copy it into the stage. Registry
authentication, if needed, must already be configured securely on the VM.
Create a protected stage parent in advance and verify its resolved path is outside
the resolved deployment root, including symlinks and mounts, before running the
commands below. This separation is an operator prerequisite, not checked by them.

```sh
DEPLOY_PATH=/absolute/path/to/existing/deployment
RELEASE_SOURCE=/absolute/path/to/release/infrastructure/production
IMAGE_TAG=approved-release-tag
STAGE_PARENT=/absolute/path/outside/deployment
case "$DEPLOY_PATH" in /*) ;; *) echo 'Deployment root must be absolute' >&2; exit 1;; esac
case "$RELEASE_SOURCE" in /*) ;; *) echo 'Release source must be absolute' >&2; exit 1;; esac
case "$STAGE_PARENT" in /*) ;; *) echo 'Stage parent must be absolute' >&2; exit 1;; esac
case "$IMAGE_TAG" in ''|*[!A-Za-z0-9._-]*) echo 'Invalid image tag' >&2; exit 1;; esac
test -f "$DEPLOY_PATH/.env" && test -f "$RELEASE_SOURCE/deploy-cutover.sh" || exit 1
umask 077
stage="$STAGE_PARENT/manual-$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir "$stage" || exit 1
rsync --archive --exclude='.env' --exclude='.deploy.env' "$RELEASE_SOURCE/" "$stage/" || exit 1
(cd "$stage" && sh ./deploy-cutover.sh "$IMAGE_TAG" "$DEPLOY_PATH")
```

The workflow uses `rsync --delete` in the deployment root and can remove stages
and bind-mounted configuration there on any later
release. Keep stages until no containers use their bind mounts, and coordinate
future deployments: the script's lock does not protect against the workflow.

The script pulls images, starts database/Redis, runs the migrator, starts the
candidate and checks it through the private edge, then starts public Traefik
and coturn. It does **not** persist the selected tag in `.deploy.env`, perform a
backup, or perform public verification. `.deploy.env` remains the workflow's
selected tag; verify it agrees with the intended tag before later Compose or
deployment operations, and do not assume the manual script updates it. Preserve the stage while any container
uses its bind mounts. If it fails, assume the state is uncertain: keep the
external barrier closed, inspect container/network state and investigate before
rerunning the same candidate. Never start old binaries on the migrated database.
An actual rollback requires an approved, verified pre-cutover restore and matching
old images/configuration; assess lost writes and revocation effects first. Do not
run restore or reopen automatically.

After success, remove the external barrier only under operator control. From the
VM console, manually verify the public HTTPS routes: `https://chat.false.tel/`
serves the app shell; `https://kyc.chat.false.tel/` returns the expected `401`
Basic Auth challenge; `/health/ready` succeeds on the auth, API, and WebSocket
hosts; and POSTing an invalid activation token to the auth activation route
returns `400`. Specifically, readiness must succeed at
`https://auth.chat.false.tel/health/ready`,
`https://api.chat.false.tel/health/ready`, and
`https://ws.chat.false.tel/health/ready`; POST `{}` to
`https://auth.chat.false.tel/api/auth/activate?token=invalid` and expect `400`.
Confirm valid HTTPS certificates. On the chat response, require
`Permissions-Policy: geolocation=(), microphone=(self), camera=()` and a CSP
with exactly one `connect-src` directive containing
`https://media.giphy.com` and `https://media0.giphy.com` through
`https://media4.giphy.com`, and no removed external font origin such as
`fonts.googleapis.com`.

Then verify fresh sign-in with a supported browser. Exercise direct and group
messaging over `/ws/v4`, calls/TURN and push as applicable; confirm a previous
session requires sign-in and inspect secret-free diagnostics. The VM checks do
not by themselves establish browser behavior or media relay. On any failure,
close the external barrier and follow the recovery decision above rather than
assuming the script rolled back.
