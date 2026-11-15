#!/bin/sh
# Run in the production Compose directory with .env and .deploy.env exported.
set -eu
stop_application() {
  docker compose stop frontend auth chat realtime || \
    echo 'Could not stop all Zwei application services after deployment failure.' >&2
}
docker compose --profile migration pull
trap stop_application EXIT
trap 'exit 1' HUP INT TERM
docker compose stop frontend auth chat realtime
running=$(docker compose ps -q --status running frontend auth chat realtime)
test -z "$running"
docker compose up -d --wait --wait-timeout 120 database redis
docker compose run --rm --no-deps migrate
docker compose up -d --no-deps --force-recreate --wait --wait-timeout 120 frontend auth chat realtime
docker compose up -d --no-deps --wait --wait-timeout 120 coturn
trap - EXIT HUP INT TERM
