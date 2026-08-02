#!/bin/sh

set -eu

PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
mkdir -p "$PROJECT_ROOT/infrastructure/traefik-certs"
docker run --rm -v "$PROJECT_ROOT/infrastructure/traefik-certs:/certs" messenger-traefik-certgen
CA="$PROJECT_ROOT/infrastructure/traefik-certs/local-ca.crt"
security add-trusted-cert -d -r trustRoot -k "$HOME/Library/Keychains/login.keychain-db" "$CA"

if security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "$CA" 2>/dev/null; then
  printf '%s\n' 'Trusted P2P Web Chat local CA in login and System keychains.'
else
  printf '%s\n' 'Trusted P2P Web Chat local CA in the login keychain.'
  printf '%s\n' 'Chrome/Chromium may require System keychain trust. Run:'
  printf 'sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain %s\n' "$CA"
fi
printf '%s\n' 'Fully quit and reopen Chrome/Chromium.'
