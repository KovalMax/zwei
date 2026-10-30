#!/usr/bin/env bash
set -Eeuo pipefail

project="$1"
script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
export E2E_NETWORK_SUBNET=172.30.10.0/24 E2E_TRAEFIK_IP=172.30.10.250 E2E_COTURN_IP=172.30.10.251
export TURN_EXTERNAL_IP=172.30.10.251
export PLAYWRIGHT_HOST_RESOLVER_RULES='MAP turn.chat.localhost 172.30.10.251,MAP *.localhost host.docker.internal'
export E2E_TURN_MODE=1
compose=(docker compose -p "$project" -f docker-compose.yml -f docker-compose.override.yml -f docker-compose.test.yml -f docker-compose.e2e-parallel.yml -f docker-compose.e2e-turn.yml)

# Inspect effective configuration without printing interpolated secrets.
"${compose[@]}" config --format json | python3 -c '
import json, os, sys
c = json.load(sys.stdin)["services"]
if any(service.get("ports") for service in c.values()):
    sys.exit("Refusing TURN acceptance: a service publishes host ports")
if c["realtime"].get("image") != os.environ["E2E_TURN_IMAGE"]:
    sys.exit("Refusing TURN acceptance: realtime image is not isolated")
if c["realtime"]["environment"].get("TURN_URLS") != "turn:turn.chat.localhost:3478?transport=udp,turn:turn.chat.localhost:3478?transport=tcp":
    sys.exit("Refusing TURN acceptance: TURN URL is not local")
if c["auth"]["environment"].get("SMTP_HOST") != "mailpit":
    sys.exit("Refusing TURN acceptance: SMTP is not local")
'
"${compose[@]}" build frontend e2e realtime
bash "$script_dir/e2e.sh" "$project" parallel-group turn
