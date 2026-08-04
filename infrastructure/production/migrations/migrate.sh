#!/bin/sh

set -eu

for migration in /migrations/*.sql; do
    version="$(basename "$migration" .sql)"
    has_migration_table="$(psql "$DATABASE_URL" -tAc "SELECT to_regclass('public.schema_migrations') IS NOT NULL")"

    if [ "$has_migration_table" = "t" ] && \
        psql "$DATABASE_URL" -tAc "SELECT 1 FROM schema_migrations WHERE version = '$version'" | grep -qx '1'; then
        continue
    fi

    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$migration"
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "INSERT INTO schema_migrations (version) VALUES ('$version') ON CONFLICT (version) DO NOTHING"
done
