#!/bin/bash

set -Eeuo pipefail

NAME_PREFIX="$1"
TEST_SCRIPT="${2:-test}"
SPEC="${3:-}"
TEST_TITLE="${4:-}"
COMPOSE=(docker compose -p "$NAME_PREFIX" -f docker-compose.yml -f docker-compose.override.yml)
TEST_COMPOSE=("${COMPOSE[@]}" -f docker-compose.test.yml)
ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

case "$TEST_SCRIPT" in
  test) ;;
  baseline)
    if [[ "$SPEC" != "tests/visual-baseline.spec.ts" || -n "$TEST_TITLE" ]]; then
      printf '%s\n' 'Baseline updates require SPEC=tests/visual-baseline.spec.ts and no TEST selector' >&2
      exit 2
    fi
    ;;
  *) printf '%s\n' 'Unsupported E2E script' >&2; exit 2 ;;
esac

dotenv_value() {
  local key="$1"
  local env_file="$SCRIPT_DIR/../.env"
  [[ -f "$env_file" ]] || return 0
  awk -F= -v key="$key" '$1 == key { value = substr($0, index($0, "=") + 1); gsub(/^"|"$/, "", value); print value; exit }' "$env_file"
}

if [[ -n "$SPEC" || -n "$TEST_TITLE" ]]; then
  case "$SPEC" in
    tests/*.spec.ts) ;;
    *) printf '%s\n' 'SPEC must be a Playwright spec path such as tests/chat-flow.spec.ts' >&2; exit 2 ;;
  esac
  case "/$SPEC/" in
    */../*|*//*) printf '%s\n' 'SPEC must be a normalized relative spec path' >&2; exit 2 ;;
  esac
  if [[ ! -f "$ROOT_DIR/e2e/$SPEC" ]]; then
    printf 'Playwright spec not found: %s\n' "$SPEC" >&2
    exit 2
  fi
  if [[ "$TEST_SCRIPT" != "test" && "$TEST_SCRIPT" != "baseline" ]]; then
    printf '%s\n' 'A spec selector can only be used with the test or baseline script' >&2
    exit 2
  fi
  if [[ -n "$TEST_TITLE" && "$TEST_TITLE" == *$'\n'* ]]; then
    printf '%s\n' 'TEST must be a single-line Playwright title selector' >&2
    exit 2
  fi
  if [[ -z "$SPEC" ]]; then
    printf '%s\n' 'Set SPEC to a Playwright spec path' >&2
    exit 2
  fi
fi

# Docker creates a missing bind-mount source as root. Validate the workspace
# before creating either host directory; never mount a different checkout.
if [[ "$(pwd -P)" != "$ROOT_DIR/infrastructure" ]]; then
  printf '%s\n' 'Run E2E from the repository infrastructure directory' >&2
  exit 2
fi
if [[ ! -d "$ROOT_DIR/e2e" || "$(CDPATH= cd -- "$ROOT_DIR/e2e" && pwd -P)" != "$ROOT_DIR/e2e" ]]; then
  printf '%s\n' 'Expected a real e2e directory inside the current repository' >&2
  exit 2
fi
for directory in test-results visual-baselines; do
  if [[ -L "$ROOT_DIR/e2e/$directory" || ( -e "$ROOT_DIR/e2e/$directory" && ! -d "$ROOT_DIR/e2e/$directory" ) ]]; then
    printf 'Expected a real e2e/%s directory\n' "$directory" >&2
    exit 2
  fi
done
mkdir -p "$ROOT_DIR/e2e/test-results" "$ROOT_DIR/e2e/visual-baselines"

# Protect the disposable test namespace from custom settings that point the
# development services at the same database or Redis DB 1.
development_db_name="${APP_DB_NAME:-$(dotenv_value APP_DB_NAME)}"
development_database_url="${DATABASE_URL:-$(dotenv_value DATABASE_URL)}"
development_redis_url="${REDIS_URL:-$(dotenv_value REDIS_URL)}"
if [[ "${development_db_name:-messenger_db}" == "messenger_test" || "${development_database_url:-}" =~ /messenger_test([?]|$) ]]; then
  printf '%s\n' 'Refusing E2E run: APP_DB_NAME must not be messenger_test' >&2
  exit 2
fi
if [[ "${development_redis_url:-}" =~ /1([?]|$) ]]; then
  printf '%s\n' 'Refusing E2E run: development REDIS_URL must not use Redis DB 1' >&2
  exit 2
fi

escaped_test_title=""
for ((index = 0; index < ${#TEST_TITLE}; index++)); do
  character="${TEST_TITLE:index:1}"
  case "$character" in
    '\'|'.'|'*'|'+'|'?'|'('|')'|'['|']'|'{'|'}'|'^'|'$'|'|') escaped_test_title+="\\$character" ;;
    *) escaped_test_title+="$character" ;;
  esac
done

restore_development_services() {
  "${COMPOSE[@]}" up -d --force-recreate auth chat realtime >/dev/null
}

trap restore_development_services EXIT

"${TEST_COMPOSE[@]}" up -d database frontend traefik mailpit redis >/dev/null
if [[ -z "$SPEC" || "$SPEC" == tests/pwa-offline.spec.ts ]]; then
  # Build the exact production artifact in the running frontend container. The
  # frontend source bind mount makes this output available to the E2E container.
  "${TEST_COMPOSE[@]}" exec -T frontend npm run build -- --configuration production
fi
"${COMPOSE[@]}" stop auth chat realtime >/dev/null || true
bash "$SCRIPT_DIR/migrate-test.sh" "$NAME_PREFIX"
"${TEST_COMPOSE[@]}" exec -T redis redis-cli -n 1 FLUSHDB >/dev/null
"${TEST_COMPOSE[@]}" up -d --wait --wait-timeout 60 --force-recreate auth chat realtime >/dev/null

printf '%s\n' 'Password123!' | "${TEST_COMPOSE[@]}" run -T --rm --no-deps auth /usr/bin/service admin create --email e2e-admin@example.test --display-name "E2E Admin"
baseline_mount="$ROOT_DIR/e2e/visual-baselines:/e2e/visual-baselines:ro"
if [[ "$TEST_SCRIPT" == baseline ]]; then
  baseline_mount="$ROOT_DIR/e2e/visual-baselines:/e2e/visual-baselines:rw"
fi
run_args=(--rm -v "$ROOT_DIR/e2e/test-results:/e2e/test-results" -v "$baseline_mount" e2e npm run test --)
if [[ -z "$SPEC" || "$SPEC" == tests/pwa-offline.spec.ts ]]; then
  run_args=(-v "$ROOT_DIR/frontend-app/dist/messenger/browser:/production-app:ro" "${run_args[@]}")
fi
if [[ "$TEST_SCRIPT" == baseline ]]; then
  run_args+=("$SPEC" --update-snapshots)
elif [[ -n "$SPEC" && -n "$TEST_TITLE" ]]; then
  run_args+=("$SPEC" --grep "$escaped_test_title")
elif [[ -n "$SPEC" ]]; then
  run_args+=("$SPEC")
fi
"${TEST_COMPOSE[@]}" run "${run_args[@]}"
