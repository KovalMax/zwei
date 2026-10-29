#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
# Published releases also deploy automatically; preserve that fact in this check.
workflow="$root/.github/workflows/release.yml"
if grep -Eq 'AUTH_BROWSER_SESSIONS_V2|BROWSER_SESSION_V2_RELEASE' "$root/infrastructure/production/.env.example"; then
  echo 'Production environment example must not mention obsolete browser session flags' >&2
  exit 1
fi
grep -q '^  release:$' "$workflow"
grep -q '^  publish:$' "$workflow"
grep -q 'push: true' "$workflow"
grep -q '^  deploy:$' "$workflow"
grep -q 'needs: publish' "$workflow"
grep -q 'environment: production' "$workflow"
grep -q 'rsync --archive --compress --delete' "$workflow"
grep -q 'StrictHostKeyChecking=yes' "$workflow"
grep -q 'docker compose run --rm migrate' "$workflow"
grep -q 'docker compose up -d --force-recreate' "$workflow"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
mkdir "$tmp/bin" "$tmp/deploy"
printf 'KYC_BASIC_AUTH_FILE=%s\nSECRET_VALUE=fixture-secret-never-print\n' "$tmp/htpasswd" > "$tmp/deploy/.env"
printf 'fixture\n' > "$tmp/htpasswd"
cat > "$tmp/bin/docker" <<'MOCK'
#!/bin/sh
printf '%s\n' "$*" >> "$CALLS"
case "$*" in
  *"ps -q --status running"*) [ "${RUNNING:-no}" = no ] || echo still-running ;;
  *"$FAIL_POINT"*) [ -z "$FAIL_POINT" ] || exit 1 ;;
esac
MOCK
cat > "$tmp/bin/curl" <<'MOCK'
#!/bin/sh
printf '%s\n' "$*" >> "$PROBES"
case "$*" in
  *--dump-header*) echo 'Permissions-Policy: geolocation=(), microphone=(self), camera=()'; echo 'Content-Security-Policy: connect-src https://media.giphy.com https://media0.giphy.com https://media1.giphy.com https://media2.giphy.com https://media3.giphy.com https://media4.giphy.com;' ;;
  *kyc.chat*) printf 401 ;;
  *activate*) printf 400 ;;
  *chat.false.tel/\ *) printf '<app-root>' ;;
  *https://chat.false.tel/) printf '<app-root>' ;;
esac
[ "${FAIL_PROBE:-no}" = no ]
MOCK
chmod +x "$tmp/bin/"*
export PATH="$tmp/bin:$PATH" CALLS="$tmp/calls" PROBES="$tmp/probes" FAIL_POINT= FAIL_PROBE=no RUNNING=no
cd "$tmp/deploy"
sh "$root/infrastructure/production/deploy-cutover.sh" new-tag "$tmp/deploy" > "$tmp/output" 2>&1
awk '/docker-compose.private.yml config --quiet$/ { config=NR } / stop traefik coturn$/ { if (!edge) edge=NR } / stop auth chat realtime$/ { apps=NR } / run --rm --no-deps migrate$/ { migration=NR } /docker-compose.private.yml up .* traefik$/ { private=NR } / up .* traefik coturn$/ { public=NR } END { exit !(config && config < edge && edge < apps && apps < migration && migration < private && private < public) }' "$CALLS"
test -s "$PROBES"
! grep -v -- '--connect-to ::127.0.0.1:8443' "$PROBES"
# A concurrent invocation must not touch the stack while the host lock is held.
: > "$CALLS"
(
  flock -n 9
  if sh "$root/infrastructure/production/deploy-cutover.sh" other-tag "$tmp/deploy" > "$tmp/output" 2>&1; then exit 1; fi
) 9>"$tmp/deploy/.cutover.lock"
test ! -s "$CALLS"
# Unsupported !override or invalid private configuration must fail without
# stopping anything or reaching migration; the cleanup trap is not armed yet.
: > "$CALLS"; FAIL_POINT='docker-compose.private.yml config --quiet'; export FAIL_POINT
if sh "$root/infrastructure/production/deploy-cutover.sh" new-tag "$tmp/deploy" > "$tmp/output" 2>&1; then echo 'private config failure accepted' >&2; exit 1; fi
test "$(wc -l < "$CALLS" | tr -d ' ')" = 1
! grep -Eq ' stop | run .* migrate' "$CALLS"
for point in 'stop auth chat realtime' 'migration pull' 'run --rm --no-deps migrate' 'frontend auth chat realtime' 'docker-compose.private.yml up' 'traefik coturn'; do
  : > "$CALLS"; FAIL_POINT=$point; export FAIL_POINT
  if sh "$root/infrastructure/production/deploy-cutover.sh" new-tag "$tmp/deploy" > "$tmp/output" 2>&1; then echo "failure accepted: $point" >&2; exit 1; fi
  tail -1 "$CALLS" | grep -q ' stop traefik coturn$'
done
FAIL_POINT=; RUNNING=yes; export FAIL_POINT RUNNING
: > "$CALLS"
if sh "$root/infrastructure/production/deploy-cutover.sh" new-tag "$tmp/deploy" > "$tmp/output" 2>&1; then exit 1; fi
! grep -q ' run .* migrate' "$CALLS"
RUNNING=no; FAIL_PROBE=yes; export RUNNING FAIL_PROBE
: > "$CALLS"
if sh "$root/infrastructure/production/deploy-cutover.sh" new-tag "$tmp/deploy" > "$tmp/output" 2>&1; then exit 1; fi
tail -1 "$CALLS" | grep -q ' stop traefik coturn$'
! grep -q ' up .* traefik coturn$' "$CALLS"
! grep -q 'fixture-secret-never-print' "$tmp/output" "$CALLS"
echo 'release cutover checks passed'
