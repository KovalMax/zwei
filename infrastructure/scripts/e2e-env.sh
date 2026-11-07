#!/usr/bin/env bash

# Browser tests must never receive credentials or traffic aimed at a
# non-local service when environment overrides are present.
e2e_dotenv_value() {
  local key="$1" env_file="$2" infrastructure_dir defaults_file environment value
  infrastructure_dir="$(CDPATH= cd -- "$(dirname -- "$env_file")" && pwd)"
  defaults_file="$infrastructure_dir/.env.dist"
  local -a compose=(docker compose --env-file "$defaults_file")
  if [[ -f "$env_file" && "$env_file" != "$defaults_file" ]]; then
    compose+=(--env-file "$env_file")
  fi
  compose+=(-f "$infrastructure_dir/docker-compose.yml" -f "$infrastructure_dir/docker-compose.override.yml" config --environment)
  if ! environment="$("${compose[@]}")"; then
    return 2
  fi
  if value="$(printf '%s\n' "$environment" | awk -F= -v key="$key" '$1 == key { print substr($0, index($0, "=") + 1); found = 1; exit } END { if (!found) exit 1 }')"; then
    printf '%s' "$value"
    return 0
  fi
  return 1
}

e2e_effective_value() {
  local key="$1" env_file="$2"
  if printenv "$key" >/dev/null; then
    printf '%s' "${!key}"
    return 0
  fi
  local value status
  if value="$(e2e_dotenv_value "$key" "$env_file")"; then
    printf '%s' "$value"
    return 0
  else
    status=$?
  fi
  if ((status != 1)); then
    printf 'Unable to read Compose environment value for %s\n' "$key" >&2
  fi
  return "$status"
}

e2e_reject_duplicate_keys() {
  local env_file="$1" key count
  [[ -f "$env_file" ]] || return 0
  for key in BASE_URL ADMIN_BASE_URL PLAYWRIGHT_HOST_RESOLVER_RULES APP_DB_NAME DATABASE_URL REDIS_URL; do
    count="$(awk -v key="$key" '
      {
        line = $0
        sub(/^[[:space:]]*export[[:space:]]+/, "", line)
        sub(/^[[:space:]]+/, "", line)
        if (match(line, /^[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=/)) {
          name = substr(line, RSTART, RLENGTH)
          sub(/[[:space:]]*=$/, "", name)
          if (name == key) count++
        }
      }
      END { print count + 0 }
    ' "$env_file")"
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

e2e_database_url_is_safe() {
  python3 - "$1" <<'PY'
from shlex import split
from sys import argv, exit
from urllib.parse import parse_qs, unquote, urlsplit

value = argv[1]
try:
    if value.startswith(("postgres://", "postgresql://")):
        parsed = urlsplit(value)
        path_database = unquote(parsed.path.lstrip("/"))
        query_databases = [
            database
            for name, values in parse_qs(parsed.query, keep_blank_values=True).items()
            if name.lower() == "dbname"
            for database in values
        ]
        if len(query_databases) > 1 or not path_database:
            exit(2)
        databases = [path_database, *(unquote(item) for item in query_databases)]
    else:
        options = split(value)
        database_options = [item.split("=", 1)[1] for item in options if item.lower().startswith("dbname=")]
        if len(database_options) != 1:
            exit(2)
        databases = database_options
except (ValueError, IndexError):
    exit(2)

exit(1 if any(database == "messenger_test" for database in databases) else 0)
PY
}

validate_development_e2e_targets() {
  local env_file="$1"
  local development_db_name development_database_url development_redis_url
  e2e_reject_duplicate_keys "$env_file" || return 1
  development_db_name="$(e2e_effective_value APP_DB_NAME "$env_file")"
  development_database_url="$(e2e_effective_value DATABASE_URL "$env_file")"
  development_redis_url="$(e2e_effective_value REDIS_URL "$env_file")"

  if [[ -z "$development_db_name" || -z "$development_database_url" || -z "$development_redis_url" ]]; then
    printf '%s\n' 'Refusing E2E run: effective APP_DB_NAME, DATABASE_URL, and REDIS_URL must be non-empty' >&2
    return 1
  fi
  if [[ "$development_db_name" == "messenger_test" ]] || ! e2e_database_url_is_safe "$development_database_url"; then
    printf '%s\n' 'Refusing E2E run: APP_DB_NAME must not be messenger_test' >&2
    return 1
  fi
  if e2e_uses_redis_db_one "$development_redis_url"; then
    printf '%s\n' 'Refusing E2E run: development REDIS_URL must not use Redis DB 1' >&2
    return 1
  fi
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
  base_url="$(e2e_effective_value BASE_URL "$env_file")"
  admin_base_url="$(e2e_effective_value ADMIN_BASE_URL "$env_file")"
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
    # Compose may omit the default host resolver from --environment. This
    # variable is optional for serial E2E; parallel harnesses provide it.
    if resolver_rules="$(e2e_effective_value PLAYWRIGHT_HOST_RESOLVER_RULES "$env_file")"; then
      :
    else
      local resolver_status=$?
      if ((resolver_status != 1)); then
        return "$resolver_status"
      fi
      resolver_rules=""
    fi
    if [[ -n "$resolver_rules" && "$resolver_rules" != "$expected_resolver" ]]; then
      printf '%s\n' 'Refusing E2E run: PLAYWRIGHT_HOST_RESOLVER_RULES must use the harness-managed local gateway mapping' >&2
      return 1
    fi
  fi
}
