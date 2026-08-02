#!/bin/sh

set -eu
NAME_PREFIX="$1"

docker compose -p "$NAME_PREFIX" build
docker compose -p "$NAME_PREFIX" up -d --force-recreate
