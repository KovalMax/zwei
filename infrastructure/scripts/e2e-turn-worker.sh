#!/usr/bin/env bash
set -Eeuo pipefail

project="$1"
script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
export E2E_NETWORK_SUBNET=172.30.10.0/24 E2E_TRAEFIK_IP=172.30.10.250 E2E_COTURN_IP=172.30.10.251
export TURN_EXTERNAL_IP=172.30.10.251
export PLAYWRIGHT_HOST_RESOLVER_RULES='MAP turn.chat.localhost 172.30.10.251,MAP *.localhost host.docker.internal'
export E2E_TURN_MODE=1
compose=(docker compose -p "$project" --env-file .env.dist --env-file .env -f docker-compose.yml -f docker-compose.override.yml -f docker-compose.test.yml -f docker-compose.e2e-parallel.yml -f docker-compose.e2e-turn.yml)

# Inspect effective configuration without printing interpolated secrets.
"${compose[@]}" config --format json | python3 -c '
import json, os, sys
c = json.load(sys.stdin)["services"]
if any(service.get("ports") for service in c.values()):
    sys.exit("Refusing TURN acceptance: a service publishes host ports")
if c["realtime"].get("image") != os.environ["E2E_TURN_IMAGE"]:
    sys.exit("Refusing TURN acceptance: realtime image is not isolated")
coturn_ip = os.environ["E2E_COTURN_IP"]
expected_turn_urls = f"turn:{coturn_ip}:3478?transport=udp,turn:{coturn_ip}:3478?transport=tcp"
if c["realtime"]["environment"].get("TURN_URLS") != expected_turn_urls:
    sys.exit("Refusing TURN acceptance: TURN URL is not local")
if c["realtime"]["environment"].get("TURN_SHARED_SECRET") != os.environ["E2E_TURN_SECRET"]:
    sys.exit("Refusing TURN acceptance: realtime and Coturn secrets differ")
coturn_command = c["coturn"].get("command", [])
turn_secret = os.environ["E2E_TURN_SECRET"]
static_secret = f"--static-auth-secret={turn_secret}"
if "--use-auth-secret" not in coturn_command or static_secret not in coturn_command:
    sys.exit("Refusing TURN acceptance: Coturn shared-secret authentication is required")
if "--no-stun" not in coturn_command:
    sys.exit("Refusing TURN acceptance: anonymous STUN is still enabled")
if any(
    option in {"--cli", "--no-cli"}
    or option.startswith("--cli=")
    or option.startswith("--no-cli=")
    for option in coturn_command
):
    sys.exit("Refusing TURN acceptance: explicit CLI flags are not supported by the pinned Coturn version")
if "--unauthorized-ratelimit" not in coturn_command or "--unauthorized-ratelimit-rps=100" not in coturn_command:
    sys.exit("Refusing TURN acceptance: UDP 401 response rate limiting is not configured")
if "--log-file=/dev/null" not in coturn_command or "--no-stdout-log" not in coturn_command:
    sys.exit("Refusing TURN acceptance: Coturn logging is not safely disabled")
if c["auth"]["environment"].get("SMTP_HOST") != "mailpit":
    sys.exit("Refusing TURN acceptance: SMTP is not local")
'
"${compose[@]}" build frontend e2e realtime
bash "$script_dir/e2e.sh" "$project" parallel-group turn "${E2E_TURN_TEST_TITLE:-}"
