#!/bin/sh

set -eu

NAME_PREFIX="$1"
COMPOSE="docker compose -p $NAME_PREFIX -f docker-compose.yml -f docker-compose.override.yml -f docker-compose.test.yml"

$COMPOSE exec -T database sh -eu -c '
dropdb --if-exists --force -U "$POSTGRES_USER" messenger_test
createdb -U "$POSTGRES_USER" messenger_test
for migration in /migrations/*.sql; do
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d messenger_test -f "$migration"
done
'
