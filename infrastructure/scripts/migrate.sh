#!/bin/sh

set -eu

NAME_PREFIX="$1"
COMPOSE="docker compose -p $NAME_PREFIX -f docker-compose.yml -f docker-compose.override.yml"

$COMPOSE exec -T database sh -c 'for migration in /migrations/*.sql; do psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f "$migration"; done'
