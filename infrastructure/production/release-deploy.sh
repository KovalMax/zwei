#!/bin/sh
# Run in the production Compose directory with .env and .deploy.env exported.
set -eu
verification_marker=.release-verification-pending
case "${1:-deploy}" in
  deploy) ;;
  cleanup)
    if [ -f "$verification_marker" ]; then
      docker compose stop traefik coturn
      rm -f "$verification_marker"
    fi
    exit 0
    ;;
  verified)
    test -f "$verification_marker"
    rm -f "$verification_marker"
    exit 0
    ;;
  *) echo 'Usage: release-deploy.sh [cleanup|verified]' >&2; exit 2 ;;
esac
close_edge() {
  docker compose stop traefik coturn || echo 'CRITICAL: manually close HTTP(S) and TURN' >&2
}
test -f "$KYC_BASIC_AUTH_FILE" && test -s "$KYC_BASIC_AUTH_FILE"
docker compose config --quiet
docker compose --profile migration pull
# Validate readability through the same read-only mount without attaching a
# second Traefik to the live proxy's fixed edge IP.
docker run --rm --network none \
  --mount "type=bind,source=$KYC_BASIC_AUTH_FILE,target=/run/secrets/kyc.htpasswd,readonly" \
  --entrypoint sh traefik:v3.5 \
  -c 'test -f /run/secrets/kyc.htpasswd && test -r /run/secrets/kyc.htpasswd && test -s /run/secrets/kyc.htpasswd'
# The marker survives SSH status ambiguity and remains until public probes pass.
(umask 077; : > "$verification_marker")
# From this point a failed cutover must leave public routes closed.
trap close_edge EXIT
trap 'exit 1' HUP INT TERM
docker compose stop traefik coturn
docker compose stop frontend auth chat realtime
running=$(docker compose ps -q --status running traefik coturn frontend auth chat realtime)
test -z "$running"
docker compose up -d --wait --wait-timeout 120 database redis
docker compose run --rm --no-deps migrate
docker compose up -d --no-deps --force-recreate --wait --wait-timeout 120 frontend auth chat realtime
docker compose up -d --no-deps --force-recreate --wait --wait-timeout 120 coturn traefik
trap - EXIT HUP INT TERM
