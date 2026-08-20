#!/bin/bash

set -Eeuo pipefail

NAME_PREFIX="$1"
TEST_SCRIPT="${2:-test}"
COMPOSE=(docker compose -p "$NAME_PREFIX" -f docker-compose.yml -f docker-compose.override.yml)
TEST_COMPOSE=("${COMPOSE[@]}" -f docker-compose.test.yml)
ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

restore_development_services() {
  "${COMPOSE[@]}" up -d --force-recreate auth chat realtime >/dev/null
}

trap restore_development_services EXIT

"${TEST_COMPOSE[@]}" up -d database frontend traefik mailpit >/dev/null
"${COMPOSE[@]}" stop auth chat realtime >/dev/null || true
bash "$SCRIPT_DIR/migrate-test.sh" "$NAME_PREFIX"
"${TEST_COMPOSE[@]}" up -d --force-recreate auth chat realtime >/dev/null

printf '%s\n' 'Password123!' | "${TEST_COMPOSE[@]}" run -T --rm --no-deps auth /usr/bin/service admin create --email e2e-admin@example.test --display-name "E2E Admin"
mkdir -p "$ROOT_DIR/e2e/test-results"
"${TEST_COMPOSE[@]}" run --rm -v "$ROOT_DIR/e2e/test-results:/e2e/test-results" e2e npm run "$TEST_SCRIPT"
