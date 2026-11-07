#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

mkdir -p "$TEMP_DIR/bin"
touch "$TEMP_DIR/.env" "$TEMP_DIR/.env.dist" \
  "$TEMP_DIR/docker-compose.yml" "$TEMP_DIR/docker-compose.override.yml"
cat >"$TEMP_DIR/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
if [[ "${E2E_TEST_DOCKER_EXIT:-0}" != 0 ]]; then
  exit "$E2E_TEST_DOCKER_EXIT"
fi
printf '%s\n' \
  'BASE_URL=https://chat.localhost' \
  'ADMIN_BASE_URL=https://kyc.localhost'
DOCKER
chmod +x "$TEMP_DIR/bin/docker"

unset BASE_URL ADMIN_BASE_URL PLAYWRIGHT_HOST_RESOLVER_RULES || true
PATH="$TEMP_DIR/bin:$PATH"
export PATH

source "$SCRIPT_DIR/e2e-env.sh"
validate_local_e2e_targets "$TEMP_DIR/.env"

if error_output="$(
  E2E_TEST_DOCKER_EXIT=19 PATH="$TEMP_DIR/bin:$PATH" bash -euc \
    'source "$1"; validate_local_e2e_targets "$2"' _ \
    "$SCRIPT_DIR/e2e-env.sh" "$TEMP_DIR/.env" 2>&1
)"; then
  printf '%s\n' 'Expected Compose environment lookup failure to be rejected' >&2
  exit 1
fi
if [[ "$error_output" != *'Unable to read Compose environment value for BASE_URL'* ]]; then
  printf 'Unexpected Compose lookup failure: %s\n' "$error_output" >&2
  exit 1
fi
