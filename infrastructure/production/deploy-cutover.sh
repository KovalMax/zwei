#!/bin/sh
# Called on the production VM; no tracing: .env contains secrets.
set -eu
case "${1:-}" in ''|*[!A-Za-z0-9._-]*) echo 'Invalid image tag' >&2; exit 1;; esac
# The staging directory is immutable for the lifetime of its containers.
# The lock lives outside all releases and is shared by every invocation.
root=${2:?deployment root required}
exec 9>"$root/.cutover.lock"
flock -n 9 || { echo 'Another cutover holds the host lock' >&2; exit 1; }
set -a
. "$root/.env"
set +a
umask 077
IMAGE_TAG=$1
export IMAGE_TAG
# Explicit project directory keeps Compose relative bind mounts in this stage.
compose() { docker compose --project-directory "$PWD" -f docker-compose.yml "$@"; }
private() { docker compose --project-directory "$PWD" -f docker-compose.yml -f docker-compose.private.yml "$@"; }
# Fail before changing the running stack if the private overlay cannot be
# parsed (notably !override requires Compose 2.24.4 or newer).
private config --quiet
close_edge() {
  compose stop traefik coturn || echo 'CRITICAL: manually close HTTP(S) and TURN' >&2
}
trap close_edge EXIT
trap 'exit 1' HUP INT TERM
compose stop traefik coturn
compose stop auth chat realtime
test -z "$(compose ps -q --status running traefik coturn auth chat realtime)"
case "$KYC_BASIC_AUTH_FILE" in /*) ;; *) echo 'KYC_BASIC_AUTH_FILE must be absolute' >&2; exit 1;; esac
test -s "$KYC_BASIC_AUTH_FILE"
compose --profile migration pull
compose up -d --wait --wait-timeout 120 database redis
compose run --rm --no-deps migrate
compose up -d --no-deps --force-recreate --wait --wait-timeout 120 frontend auth chat realtime
# Existing ACME storage supplies the real certificates; no public ports are bound.
private up -d --no-deps --force-recreate --wait --wait-timeout 120 traefik
private exec -T traefik sh -c 'test -s /run/secrets/kyc.htpasswd'
# Preserve hostname, SNI and certificate verification while connecting locally.
probe() { curl --connect-to "::127.0.0.1:8443" "$@"; }
# Probe the private edge before publishing either HTTP(S) or TURN.
chat_page=$(probe --fail --silent --show-error --retry 20 --retry-all-errors --retry-delay 3 https://chat.false.tel/)
printf '%s' "$chat_page" | grep -Fq '<app-root>'
kyc_status=$(probe --silent --show-error --retry 20 --retry-all-errors --retry-delay 3 --output /dev/null --write-out '%{http_code}' https://kyc.chat.false.tel/)
test "$kyc_status" = 401
probe --fail --silent --show-error --retry 20 --retry-all-errors --retry-delay 3 --output /dev/null https://auth.chat.false.tel/health/ready
activation_status=$(probe --silent --show-error --retry 20 --retry-all-errors --retry-delay 3 --request POST --data '{}' --output /dev/null --write-out '%{http_code}' 'https://auth.chat.false.tel/api/auth/activate?token=invalid')
test "$activation_status" = 400
probe --fail --silent --show-error --retry 20 --retry-all-errors --retry-delay 3 --output /dev/null https://api.chat.false.tel/health/ready
probe --fail --silent --show-error --retry 20 --retry-all-errors --retry-delay 3 --output /dev/null https://ws.chat.false.tel/health/ready
headers=$(probe --fail --silent --show-error --retry 20 --retry-all-errors --retry-delay 3 --dump-header - --output /dev/null https://chat.false.tel/ | tr -d '\r')
printf '%s\n' "$headers" | grep -Fqi 'permissions-policy: geolocation=(), microphone=(self), camera=()'
printf '%s\n' "$headers" | grep -Fqi 'content-security-policy:'
csp=$(printf '%s\n' "$headers" | awk 'tolower($1) == "content-security-policy:" { $1=""; sub(/^[[:space:]]+/, ""); if (found) result=result "\n"; result=result $0; found=1 } END { print result }')
connect_src=$(printf '%s' "$csp" | tr ';' '\n' | awk 'tolower($1) == "connect-src" { if (found) duplicate=1; found=1; $1=""; sub(/^[[:space:]]+/, ""); directive=$0 } END { if (!found || duplicate) exit 1; print directive }')
for origin in https://media.giphy.com https://media0.giphy.com https://media1.giphy.com https://media2.giphy.com https://media3.giphy.com https://media4.giphy.com; do
  case " $connect_src " in *" $origin "*) ;; *) echo 'Missing CSP origin' >&2; exit 1;; esac
done
if printf '%s\n' "$headers" | grep -Fqi 'fonts.googleapis.com'; then echo 'Stale CSP origin' >&2; exit 1; fi
# Commit only after all private checks pass. The trap remains armed through both
# public starts, so a partial commit is closed on ordinary failure/signals.
compose up -d --no-deps --force-recreate --wait --wait-timeout 120 traefik coturn
trap - EXIT HUP INT TERM
