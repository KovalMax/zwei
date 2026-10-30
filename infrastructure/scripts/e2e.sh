#!/bin/bash

set -Eeuo pipefail

NAME_PREFIX="$1"
TEST_SCRIPT="${2:-test}"
SPEC="${3:-}"
TEST_TITLE="${4:-}"
COMPOSE=(docker compose -p "$NAME_PREFIX" -f docker-compose.yml -f docker-compose.override.yml)
TEST_COMPOSE=("${COMPOSE[@]}" -f docker-compose.test.yml)
MIGRATION_OVERLAY=""
ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
source "$SCRIPT_DIR/e2e-env.sh"
validate_local_e2e_targets "$SCRIPT_DIR/../.env"

case "$TEST_SCRIPT" in
  test|parallel-group) ;;
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
  if [[ "$TEST_SCRIPT" == parallel-group ]]; then
    case "$SPEC" in
      chat|other|turn) ;;
      *) printf '%s\n' 'Parallel group must be chat, other, or turn' >&2; exit 2 ;;
    esac
  else
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
fi
if [[ "$TEST_TITLE" == *$'\n'* ]]; then
  printf '%s\n' 'TEST must be a single-line Playwright title selector' >&2
  exit 2
fi

if [[ "$TEST_SCRIPT" == parallel-group ]]; then
  if [[ ! "$NAME_PREFIX" =~ ^[a-z0-9][a-z0-9_-]{0,24}-e2e-[0-9]{14}-[0-9]+-[ab]$ ]]; then
    printf '%s\n' 'Parallel groups must use a parent-generated isolated Compose project name' >&2
    exit 2
  fi
  [[ -n "${E2E_NETWORK_SUBNET:-}" && -n "${E2E_TRAEFIK_IP:-}" && -n "${E2E_COTURN_IP:-}" && -n "${PLAYWRIGHT_RUN_ID:-}" ]] || {
    printf '%s\n' 'Parallel groups require E2E_NETWORK_SUBNET, E2E_TRAEFIK_IP, E2E_COTURN_IP, and PLAYWRIGHT_RUN_ID' >&2
    exit 2
  }
  e2e_validate_parallel_network "$E2E_NETWORK_SUBNET" "$E2E_TRAEFIK_IP" "$E2E_COTURN_IP"
  validate_local_e2e_targets "$SCRIPT_DIR/../.env"
  source "$SCRIPT_DIR/e2e-groups.sh"
  COMPOSE+=( -f docker-compose.test.yml -f docker-compose.e2e-parallel.yml )
  if [[ "$SPEC" == turn ]]; then
    [[ "${E2E_TURN_MODE:-}" == 1 && -n "${E2E_TURN_IMAGE:-}" ]] || { printf '%s\n' 'TURN acceptance requires the dedicated parent harness' >&2; exit 2; }
    COMPOSE+=( -f docker-compose.e2e-turn.yml )
  fi
  TEST_COMPOSE=("${COMPOSE[@]}")
  MIGRATION_OVERLAY="docker-compose.e2e-parallel.yml"
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
# Keep local push encryption/fingerprint secrets stable and available to auth in both E2E modes.
python3 "$SCRIPT_DIR/ensure-local-push-secrets.py"
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
if e2e_uses_redis_db_one "${development_redis_url:-}"; then
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

restore_application_services() {
  "${COMPOSE[@]}" up -d --force-recreate auth chat realtime >/dev/null
}

wait_for_browser_routes() {
  "${TEST_COMPOSE[@]}" run --rm --no-deps e2e node -e '
const https = require("node:https");
const deadline = Date.now() + 30000;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function check(url, accepted) {
  let lastError;
  while (Date.now() < deadline) {
    try {
      const status = await new Promise((resolve, reject) => {
        const request = https.get(url, {rejectUnauthorized: false, timeout: 2000}, response => {
          response.resume();
          resolve(response.statusCode || 0);
        });
        request.on("timeout", () => request.destroy(new Error("request timed out")));
        request.on("error", reject);
      });
      if (accepted(status)) return;
      lastError = new Error(`HTTP ${status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }
  throw new Error(`Browser route did not become ready (${url}): ${lastError?.message || "deadline exceeded"}`);
}
(async () => {
  await check("https://chat.localhost/login", status => status >= 200 && status < 400);
  // The KYC shell is intentionally protected by Traefik Basic Auth.
  await check("https://kyc.localhost/login", status => status === 401);
  console.log("Browser HTTPS routes are ready");
})().catch(error => {
  console.error(error.message);
  process.exit(1);
});
'
}

if [[ "$TEST_SCRIPT" != parallel-group ]]; then
  trap restore_application_services EXIT
fi

if [[ "$TEST_SCRIPT" == parallel-group ]]; then
  "${TEST_COMPOSE[@]}" up -d database frontend traefik mailpit redis coturn >/dev/null
else
  "${TEST_COMPOSE[@]}" up -d database frontend traefik mailpit redis >/dev/null
fi
"${TEST_COMPOSE[@]}" up -d --wait --wait-timeout 60 database redis >/dev/null
if [[ -z "$SPEC" || "$SPEC" == tests/pwa-offline.spec.ts ]] && [[ "${E2E_SKIP_FRONTEND_BUILD:-0}" != 1 ]]; then
  # Build the exact production artifact in the running frontend container. The
  # frontend source bind mount makes this output available to the E2E container.
  "${TEST_COMPOSE[@]}" exec -T frontend npm run build -- --configuration production
  bash "$SCRIPT_DIR/e2e-pwa-build.sh" "${TEST_COMPOSE[@]}"
fi
"${COMPOSE[@]}" stop auth chat realtime >/dev/null || true
if [[ -n "$MIGRATION_OVERLAY" ]]; then
  bash "$SCRIPT_DIR/migrate-test.sh" "$NAME_PREFIX" "$MIGRATION_OVERLAY"
else
  bash "$SCRIPT_DIR/migrate-test.sh" "$NAME_PREFIX"
fi
"${TEST_COMPOSE[@]}" exec -T redis redis-cli -n 1 FLUSHDB >/dev/null
"${TEST_COMPOSE[@]}" up -d --wait --wait-timeout 60 --force-recreate auth chat realtime >/dev/null
wait_for_browser_routes
if [[ "$SPEC" == turn ]] && [[ -z "$("${TEST_COMPOSE[@]}" ps -q --status running coturn)" ]]; then
  printf '%s\n' 'Isolated coturn is not running' >&2
  exit 1
fi

printf '%s\n' 'Password123!' | "${TEST_COMPOSE[@]}" run -T --rm --no-deps auth /usr/bin/service admin create --email e2e-admin@example.test --display-name "E2E Admin"
baseline_mount="$ROOT_DIR/e2e/visual-baselines:/e2e/visual-baselines:ro"
if [[ "$TEST_SCRIPT" == baseline ]]; then
  baseline_mount="$ROOT_DIR/e2e/visual-baselines:/e2e/visual-baselines:rw"
fi
run_args=(--rm -v "$ROOT_DIR/e2e/test-results:/e2e/test-results" -v "$baseline_mount" e2e npm run test --)
if [[ "$TEST_SCRIPT" == parallel-group ]]; then
  run_args=(--rm -e "PLAYWRIGHT_RUN_ID=$PLAYWRIGHT_RUN_ID" -v "$ROOT_DIR/e2e/test-results:/e2e/test-results" -v "$baseline_mount" e2e npm run test --)
fi
if [[ -z "$SPEC" || "$SPEC" == tests/pwa-offline.spec.ts || ( "$TEST_SCRIPT" == parallel-group && "$SPEC" != turn ) ]]; then
  run_args=(-v "$ROOT_DIR/frontend-app/dist/messenger/browser:/production-app:ro" "${run_args[@]}")
  run_args=(-v "$ROOT_DIR/frontend-app/dist/pwa-update/browser:/production-app-update:ro" "${run_args[@]}")
fi
if [[ "$TEST_SCRIPT" == baseline ]]; then
  run_args+=("$SPEC" --update-snapshots)
elif [[ -n "$SPEC" && -n "$TEST_TITLE" && "$TEST_SCRIPT" != parallel-group ]]; then
  run_args+=("$SPEC" --grep "$escaped_test_title")
elif [[ -n "$SPEC" && "$TEST_SCRIPT" != parallel-group ]]; then
  run_args+=("$SPEC")
fi
if [[ "$TEST_SCRIPT" == parallel-group ]]; then
  if [[ -n "$TEST_TITLE" ]]; then
    run_args+=(--grep "$escaped_test_title")
  fi
  if [[ "$SPEC" == turn ]]; then
    run_args+=(--config=turn-playwright.config.ts)
  elif [[ "$SPEC" == chat ]]; then
    run_args+=("${E2E_CHAT_SPECS[@]}")
  else
    run_args+=("${E2E_OTHER_SPECS[@]}")
  fi
fi
"${TEST_COMPOSE[@]}" run "${run_args[@]}"
