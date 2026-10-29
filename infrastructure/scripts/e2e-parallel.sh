#!/usr/bin/env bash

set -Eeuo pipefail

NAME_PREFIX="${1:-messenger}"
ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
source "$SCRIPT_DIR/e2e-env.sh"
source "$SCRIPT_DIR/e2e-groups.sh"

if [[ "$(pwd -P)" != "$(CDPATH= cd -- "$ROOT_DIR/infrastructure" && pwd -P)" ]]; then
  printf '%s\n' 'Run parallel E2E from the repository infrastructure directory' >&2
  exit 2
fi
if [[ ! "$NAME_PREFIX" =~ ^[a-z0-9][a-z0-9_-]{0,24}$ ]]; then
  printf '%s\n' 'APP_NAME must be a safe Compose project-name prefix of at most 25 characters' >&2
  exit 2
fi

validate_compose_version() {
  local version major minor patch
  version="$(docker compose version --short)"
  IFS=. read -r major minor patch <<<"$version"
  patch="${patch%%-*}"
  if [[ ! "$major" =~ ^[0-9]+$ || ! "$minor" =~ ^[0-9]+$ || ! "$patch" =~ ^[0-9]+$ ]] || \
    ((major < 2)) || ((major == 2 && minor < 24)) || ((major == 2 && minor == 24 && patch < 4)); then
    printf 'Parallel E2E requires Docker Compose v2.24.4 or newer (found %s)\n' "$version" >&2
    return 1
  fi
}

ipv4_bounds() {
  local cidr="$1" ip prefix a b c d value mask start end
  [[ "$cidr" =~ ^([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)/([0-9]+)$ ]] || return 1
  ip="${BASH_REMATCH[1]}"
  prefix="${BASH_REMATCH[2]}"
  ((prefix <= 32)) || return 1
  IFS=. read -r a b c d <<<"$ip"
  for octet in "$a" "$b" "$c" "$d"; do
    [[ "$octet" =~ ^[0-9]{1,3}$ ]] && ((10#$octet <= 255)) || return 1
  done
  value=$(( (10#$a << 24) | (10#$b << 16) | (10#$c << 8) | 10#$d ))
  if ((prefix == 0)); then mask=0; else mask=$(((0xffffffff << (32 - prefix)) & 0xffffffff)); fi
  start=$((value & mask))
  end=$((start | ((~mask) & 0xffffffff)))
  printf '%s %s\n' "$start" "$end"
}

validate_network_subnets() {
  local network_id details network_name subnet candidate_start candidate_end existing_start existing_end
  local candidate
  for candidate in 172.30.10.0/24 172.30.11.0/24; do
    read -r candidate_start candidate_end < <(ipv4_bounds "$candidate")
    while IFS= read -r network_id; do
      [[ -n "$network_id" ]] || continue
      details="$(docker network inspect --format '{{.Name}}{{range .IPAM.Config}} {{.Subnet}}{{end}}' "$network_id")"
      read -r network_name subnet _ <<<"$details"
      for subnet in ${details#"$network_name"}; do
        read -r existing_start existing_end < <(ipv4_bounds "$subnet") || continue
        if ((candidate_start <= existing_end && existing_start <= candidate_end)); then
          printf 'Parallel E2E subnet %s overlaps Docker network %s (%s); remove/reconfigure the conflicting network or choose another subnet.\n' "$candidate" "$network_name" "$subnet" >&2
          return 1
        fi
      done
    done < <(docker network ls -q)
  done
}

validate_compose_version
validate_local_e2e_targets "$SCRIPT_DIR/../.env" managed
validate_network_subnets

ARTIFACT_ROOT="$ROOT_DIR/e2e/test-results"
if [[ -L "$ARTIFACT_ROOT" || ( -e "$ARTIFACT_ROOT" && ! -d "$ARTIFACT_ROOT" ) ]]; then
  printf '%s\n' 'Expected e2e/test-results to be a real directory' >&2
  exit 2
fi
mkdir -p "$ARTIFACT_ROOT"
LOCK_FILE="$ARTIFACT_ROOT/.parallel-e2e-lock"
OWNER_FILE=""
RUN_ID="$(date -u +%Y%m%d%H%M%S)-$$"
PROJECT_A="$NAME_PREFIX-e2e-$RUN_ID-a"
PROJECT_B="$NAME_PREFIX-e2e-$RUN_ID-b"
E2E_RUNNER_IMAGE="zwei-e2e:e2e-$RUN_ID"
export E2E_RUNNER_IMAGE
PIDS=()
EXIT_STATUS=0
LOCK_ACQUIRED=0
COMPOSE_FILES=(-f docker-compose.yml -f docker-compose.override.yml -f docker-compose.test.yml -f docker-compose.e2e-parallel.yml)
ASSIGNED_SPECS=("${E2E_CHAT_SPECS[@]}" "${E2E_OTHER_SPECS[@]}")

for spec in "$ROOT_DIR"/e2e/tests/*.spec.ts; do
  filename="${spec##*/}"
  found=0
  for assigned in "${ASSIGNED_SPECS[@]}"; do
    if [[ "$filename" == "${assigned#tests/}" ]]; then
      found=1
      break
    fi
  done
  if [[ "$found" -ne 1 ]]; then
    printf 'Assign new Playwright spec to an isolated group before running: %s\n' "$filename" >&2
    exit 2
  fi
done
if [[ "${#ASSIGNED_SPECS[@]}" -ne "$(find "$ROOT_DIR/e2e/tests" -maxdepth 1 -name '*.spec.ts' -type f | wc -l | tr -d ' ')" ]]; then
  printf '%s\n' 'Parallel E2E spec assignments do not match the discovered spec count' >&2
  exit 2
fi

group_compose() {
  local project="$1" subnet="$2" proxy_ip="$3" coturn_ip="$4"
  shift 4
  E2E_NETWORK_SUBNET="$subnet" \
  E2E_TRAEFIK_IP="$proxy_ip" \
  E2E_COTURN_IP="$coturn_ip" \
  TURN_EXTERNAL_IP="$coturn_ip" \
  PLAYWRIGHT_HOST_RESOLVER_RULES="MAP turn.chat.localhost $coturn_ip,MAP *.localhost host.docker.internal" \
    docker compose -p "$project" "${COMPOSE_FILES[@]}" "$@"
}

cleanup() {
  local status=$?
  local pid cleanup_failed=0
  trap - EXIT INT TERM
  for pid in "${PIDS[@]:-}"; do
    [[ -n "$pid" ]] || continue
    if kill -0 "$pid" 2>/dev/null; then
      terminate_process_tree "$pid"
    fi
  done
  wait_for_terminated_shards
  if ! group_compose "$PROJECT_A" 172.30.10.0/24 172.30.10.250 172.30.10.251 down --rmi local --volumes --remove-orphans >/dev/null; then
    printf 'Failed to remove isolated Compose project %s\n' "$PROJECT_A" >&2
    cleanup_failed=1
  fi
  if ! group_compose "$PROJECT_B" 172.30.11.0/24 172.30.11.250 172.30.11.251 down --rmi local --volumes --remove-orphans >/dev/null; then
    printf 'Failed to remove isolated Compose project %s\n' "$PROJECT_B" >&2
    cleanup_failed=1
  fi
  if docker image inspect "$E2E_RUNNER_IMAGE" >/dev/null 2>&1; then
    if ! docker image rm "$E2E_RUNNER_IMAGE" >/dev/null; then
      printf 'Failed to remove this run’s E2E image %s\n' "$E2E_RUNNER_IMAGE" >&2
      cleanup_failed=1
    fi
  fi
  if [[ "$LOCK_ACQUIRED" -eq 1 ]]; then
    rm -f "$LOCK_FILE" || cleanup_failed=1
  fi
  if [[ -n "$OWNER_FILE" ]]; then rm -f "$OWNER_FILE" || cleanup_failed=1; fi
  if [[ "$cleanup_failed" -eq 1 ]]; then status=1; fi
  exit "$status"
}

terminate_process_tree() {
  local parent="$1" child
  while IFS= read -r child; do
    [[ -n "$child" ]] || continue
    terminate_process_tree "$child"
  done < <(pgrep -P "$parent" 2>/dev/null || true)
  kill -TERM "$parent" 2>/dev/null || true
}

kill_process_tree() {
  local parent="$1" child
  while IFS= read -r child; do
    [[ -n "$child" ]] || continue
    kill_process_tree "$child"
  done < <(pgrep -P "$parent" 2>/dev/null || true)
  kill -KILL "$parent" 2>/dev/null || true
}

wait_for_terminated_shards() {
  local pid attempt
  for pid in "${PIDS[@]:-}"; do
    [[ -n "$pid" ]] || continue
    for ((attempt = 0; attempt < 10; attempt++)); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "$pid" 2>/dev/null; then
      printf 'Shard process %s did not exit after SIGTERM; escalating to SIGKILL.\n' "$pid" >&2
      kill_process_tree "$pid"
    fi
    wait "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

OWNER_FILE="$(mktemp "$ARTIFACT_ROOT/.parallel-e2e-owner.XXXXXX")"
printf '%s\n' "$$" >"$OWNER_FILE"
if ! ln "$OWNER_FILE" "$LOCK_FILE" 2>/dev/null; then
  if [[ -f "$LOCK_FILE" && ! -L "$LOCK_FILE" ]]; then
    lock_pid="$(cat "$LOCK_FILE")"
    if [[ "$lock_pid" =~ ^[0-9]+$ ]] && ! kill -0 "$lock_pid" 2>/dev/null; then
      printf 'A stale parallel E2E lock exists (PID %s); remove %s after confirming no run is active.\n' "$lock_pid" "$LOCK_FILE" >&2
    else
      printf '%s\n' 'Another parallel E2E run owns this workspace; wait for it to finish' >&2
    fi
  else
    printf '%s\n' 'A parallel E2E lock exists but its owner cannot be read safely; manual recovery is required' >&2
  fi
  exit 2
fi
LOCK_ACQUIRED=1
rm -f "$OWNER_FILE"
OWNER_FILE=""

printf 'Preparing isolated E2E groups %s (chat) and %s (other specs)\n' "$PROJECT_A" "$PROJECT_B"
# Prepare each project's frontend image and the shared E2E runner image before
# either suite starts; the production bundle is built once below.
group_compose "$PROJECT_A" 172.30.10.0/24 172.30.10.250 172.30.10.251 build frontend e2e
group_compose "$PROJECT_B" 172.30.11.0/24 172.30.11.250 172.30.11.251 build frontend
group_compose "$PROJECT_A" 172.30.10.0/24 172.30.10.250 172.30.10.251 \
  up -d database frontend traefik mailpit redis coturn
group_compose "$PROJECT_A" 172.30.10.0/24 172.30.10.250 172.30.10.251 \
  exec -T frontend npm run build -- --configuration production
E2E_NETWORK_SUBNET=172.30.10.0/24 E2E_TRAEFIK_IP=172.30.10.250 E2E_COTURN_IP=172.30.10.251 \
  TURN_EXTERNAL_IP=172.30.10.251 bash "$SCRIPT_DIR/e2e-pwa-build.sh" docker compose -p "$PROJECT_A" "${COMPOSE_FILES[@]}"

run_group() {
  local project="$1" group="$2" subnet="$3" proxy_ip="$4" coturn_ip="$5" run_id="$6" status
  export E2E_NETWORK_SUBNET="$subnet" E2E_TRAEFIK_IP="$proxy_ip" E2E_COTURN_IP="$coturn_ip"
  export TURN_EXTERNAL_IP="$coturn_ip"
  export PLAYWRIGHT_HOST_RESOLVER_RULES="MAP turn.chat.localhost $coturn_ip,MAP *.localhost host.docker.internal"
  export E2E_SKIP_FRONTEND_BUILD=1 PLAYWRIGHT_RUN_ID="$run_id"
  printf 'E2E group %s START %s project=%s\n' "$group" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$project"
  if bash "$SCRIPT_DIR/e2e.sh" "$project" parallel-group "$group"; then status=0; else status=$?; fi
  printf 'E2E group %s END %s project=%s exit=%s\n' "$group" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$project" "$status"
  return "$status"
}

(
  run_group "$PROJECT_A" chat 172.30.10.0/24 172.30.10.250 172.30.10.251 "parallel-$RUN_ID-chat"
) &
PIDS+=("$!")

(
  run_group "$PROJECT_B" other 172.30.11.0/24 172.30.11.250 172.30.11.251 "parallel-$RUN_ID-other"
) &
PIDS+=("$!")

for pid in "${PIDS[@]}"; do
  if wait "$pid"; then
    :
  else
    EXIT_STATUS=1
  fi
done
PIDS=()
if [[ "$EXIT_STATUS" -ne 0 ]]; then
  exit "$EXIT_STATUS"
fi
printf 'Both E2E groups passed. Artifacts: %s/parallel-%s-*\n' "$ARTIFACT_ROOT" "$RUN_ID"
