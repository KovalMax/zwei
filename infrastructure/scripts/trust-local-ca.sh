#!/bin/sh

set -eu

NAME_PREFIX="${1:-${APP_NAME:-messenger}}"
PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
CERT_DIR="$PROJECT_ROOT/infrastructure/traefik-certs"
mkdir -p "$CERT_DIR"
compose() {
  docker compose -p "$NAME_PREFIX" \
    -f "$PROJECT_ROOT/infrastructure/docker-compose.yml" \
    -f "$PROJECT_ROOT/infrastructure/docker-compose.override.yml" "$@"
}

# A Docker Compose project can be running from a different linked worktree.
# Trust the CA actually mounted into the running edge, not whichever checkout
# happened to invoke this helper.
if ! TRAEFIK_CONTAINERS=$(docker ps --filter "label=com.docker.compose.project=$NAME_PREFIX" --filter 'label=com.docker.compose.service=traefik' --format '{{.ID}}'); then
  printf '%s\n' "Could not inspect Docker for the active Traefik container; refusing to trust this checkout's CA as a fallback." >&2
  exit 1
fi
case "$TRAEFIK_CONTAINERS" in
  *'
'*)
    printf '%s\n' "Found multiple Traefik containers for Compose project $NAME_PREFIX; refusing to choose a CA implicitly." >&2
    exit 1
    ;;
esac
TRAEFIK_CONTAINER="$TRAEFIK_CONTAINERS"
if [ -n "$TRAEFIK_CONTAINER" ]; then
  if ! docker cp "$TRAEFIK_CONTAINER:/certs/local-ca.crt" "$CERT_DIR/active-local-ca.crt" >/dev/null 2>&1; then
    printf '%s\n' "Could not copy the CA from running Traefik container $TRAEFIK_CONTAINER; refusing to trust another checkout's CA." >&2
    exit 1
  fi
  CA="$CERT_DIR/active-local-ca.crt"
  CA_SOURCE="running Traefik container ($NAME_PREFIX)"
else
  compose build traefik-certgen
  compose run --rm --no-deps traefik-certgen
  CA="$CERT_DIR/local-ca.crt"
  CA_SOURCE="this checkout's local Traefik certificates"
fi

shell_quote() {
  printf "'"
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
  printf "'"
}

printf 'Trusting CA from %s: ' "$CA_SOURCE"
openssl x509 -in "$CA" -noout -fingerprint -sha256

CA_FINGERPRINT=$(openssl x509 -in "$CA" -noout -fingerprint -sha256 | sed 's/.*=//; s/://g' | tr '[:upper:]' '[:lower:]')
LOGIN_FINGERPRINTS=$(security find-certificate -a -c 'Zwei Local CA' -Z "$HOME/Library/Keychains/login.keychain-db" 2>/dev/null | awk '/SHA-256 hash:/ {gsub(/:/, "", $3); print tolower($3)}')
if ! printf '%s\n' "$LOGIN_FINGERPRINTS" | grep -Fqx "$CA_FINGERPRINT"; then
  security add-trusted-cert -d -r trustRoot -k "$HOME/Library/Keychains/login.keychain-db" "$CA"
fi
SYSTEM_FINGERPRINTS=$(security find-certificate -a -c 'Zwei Local CA' -Z /Library/Keychains/System.keychain 2>/dev/null | awk '/SHA-256 hash:/ {gsub(/:/, "", $3); print tolower($3)}')
if ! printf '%s\n' "$SYSTEM_FINGERPRINTS" | grep -Fqx "$CA_FINGERPRINT"; then
  if ! sudo -n security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "$CA" 2>/dev/null; then
    printf '%s\n' 'The active CA is trusted in your login keychain, but not the System keychain.' >&2
    printf '%s\n' 'Chrome/Chromium requires System keychain trust for this local HTTPS certificate. Run this in Terminal:' >&2
    printf 'sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain %s\n' "$(shell_quote "$CA")" >&2
    exit 1
  fi
fi
printf '%s\n' 'The active Traefik CA is trusted in login and System keychains.'
printf '%s\n' 'Fully quit and reopen Chrome/Chromium.'
