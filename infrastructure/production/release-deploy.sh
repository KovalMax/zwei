#!/bin/sh
# Run in the production Compose directory with .env and .deploy.env exported.
set -eu
close_edge() {
  docker compose stop traefik coturn || echo 'CRITICAL: manually close HTTP(S) and TURN' >&2
}
test -f "$KYC_BASIC_AUTH_FILE" && test -s "$KYC_BASIC_AUTH_FILE"
docker compose --profile migration pull
# Validate the bind mount inside Traefik before disturbing the running edge.
docker compose run --rm --no-deps --entrypoint sh traefik -c 'test -f /run/secrets/kyc.htpasswd && test -s /run/secrets/kyc.htpasswd'
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
