#!/usr/bin/env bash

# Browser tests must never receive credentials or traffic aimed at a
# non-local service when environment overrides are present.
e2e_dotenv_value() {
  local key="$1" env_file="$2"
  [[ -f "$env_file" ]] || return 0
  awk -F= -v key="$key" '$1 == key { value = substr($0, index($0, "=") + 1); gsub(/^"|"$/, "", value); print value; exit }' "$env_file"
}

e2e_reject_duplicate_keys() {
  local env_file="$1" key count
  [[ -f "$env_file" ]] || return 0
  for key in BASE_URL ADMIN_BASE_URL PLAYWRIGHT_HOST_RESOLVER_RULES; do
    count="$(awk -F= -v key="$key" '$1 == key { count++ } END { print count + 0 }' "$env_file")"
    if ((count > 1)); then
      printf 'Refusing E2E run: infrastructure/.env contains duplicate %s entries\n' "$key" >&2
      return 1
    fi
  done
}

e2e_uses_redis_db_one() {
  local redis_url="$1"
  # Redis URL parsing decodes escaped path characters and ignores query/fragment
  # suffixes when selecting the numeric DB, so recognize equivalent spellings.
  [[ "$redis_url" =~ /([+]|%2[bB])?([0]|%30)*([1]|%31)([?]|[#]|$) ]]
}

e2e_validate_parallel_network() {
  local subnet="$1" proxy_ip="$2" coturn_ip="$3"
  case "$subnet:$proxy_ip:$coturn_ip" in
    172.30.10.0/24:172.30.10.250:172.30.10.251|172.30.11.0/24:172.30.11.250:172.30.11.251) return 0 ;;
    *)
      printf '%s\n' 'Refusing parallel E2E: network, proxy, and TURN addresses must match a harness-managed isolated project' >&2
      return 1
      ;;
  esac
}

validate_local_e2e_targets() {
  local env_file="$1" resolver_mode="${2:-validate}"
  e2e_reject_duplicate_keys "$env_file"
  local base_url admin_base_url expected_resolver resolver_rules
  base_url="${BASE_URL:-$(e2e_dotenv_value BASE_URL "$env_file")}"
  admin_base_url="${ADMIN_BASE_URL:-$(e2e_dotenv_value ADMIN_BASE_URL "$env_file")}"
  if [[ "$base_url" != "https://chat.localhost" || "$admin_base_url" != "https://kyc.localhost" ]]; then
    printf '%s\n' 'Refusing E2E run: BASE_URL and ADMIN_BASE_URL must target the local HTTPS hosts chat.localhost and kyc.localhost' >&2
    return 1
  fi
  if [[ "$resolver_mode" != managed ]]; then
    if [[ -n "${E2E_COTURN_IP:-}" ]]; then
      expected_resolver="MAP turn.chat.localhost $E2E_COTURN_IP,MAP *.localhost host.docker.internal"
    else
      expected_resolver='MAP *.localhost host.docker.internal'
    fi
    resolver_rules="${PLAYWRIGHT_HOST_RESOLVER_RULES:-$(e2e_dotenv_value PLAYWRIGHT_HOST_RESOLVER_RULES "$env_file")}"
    if [[ -n "$resolver_rules" && "$resolver_rules" != "$expected_resolver" ]]; then
      printf '%s\n' 'Refusing E2E run: PLAYWRIGHT_HOST_RESOLVER_RULES must use the harness-managed local gateway mapping' >&2
      return 1
    fi
  fi
}
