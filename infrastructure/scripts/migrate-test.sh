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

psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d messenger_test <<"SQL"
INSERT INTO users (id, email, password_hash, display_name)
VALUES ($q$12000000-0000-4000-8000-000000000012$q$, $q$migration-index-test@example.test$q$, $q$integration$q$, $q$Migration Index Test$q$);

INSERT INTO conversations (id, kind, group_name, owner_id)
VALUES
    ($q$12000000-0000-4000-8000-000000000112$q$, $q$group$q$, $q$Migration Fixture One$q$, $q$12000000-0000-4000-8000-000000000012$q$),
    ($q$12000000-0000-4000-8000-000000000212$q$, $q$group$q$, $q$Migration Fixture Two$q$, $q$12000000-0000-4000-8000-000000000012$q$);

DELETE FROM schema_migrations WHERE version = $q$0012_group_list_activity_index$q$;
DROP INDEX CONCURRENTLY conversations_group_activity_idx;
CREATE INDEX conversations_group_activity_idx
    ON conversations ((COALESCE(last_message_at, created_at)) DESC, id DESC)
    WHERE kind = $q$group$q$ AND group_name = $q$Migration Fixture One$q$;
SQL

if output=$(psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d messenger_test -f /migrations/0012_group_list_activity_index.sql 2>&1); then
  printf "%s\n" "expected restrictive same-name index validation to fail" >&2
  exit 1
else
  case "$output" in
    *"exists with an unexpected definition"*) printf "%s\n" "Validated: migration rejects a valid same-name index with an extra restrictive predicate." ;;
    *) printf "%s\n" "$output" >&2; printf "%s\n" "unexpected failure while validating restrictive same-name index" >&2; exit 1 ;;
  esac
fi
if ! psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d messenger_test -Atc "SELECT pg_try_advisory_lock(1515668809, 12)" | grep -qx t; then
  printf "%s\n" "migration connection failure did not release the session advisory lock" >&2
  exit 1
fi
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d messenger_test <<"SQL"
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = $q$0012_group_list_activity_index$q$) THEN
        RAISE EXCEPTION $q$migration version was recorded after rejecting the restrictive index$q$;
    END IF;
END $$;
DROP INDEX CONCURRENTLY conversations_group_activity_idx;
SQL
printf "%s\n" "Validated: rejected definition did not record the migration version and was removed concurrently."

psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d messenger_test <<"SQL"
CREATE INDEX conversations_group_activity_idx
    ON conversations ((COALESCE(last_message_at, created_at)) DESC NULLS LAST, id DESC)
    WHERE kind = $q$group$q$;
SQL

if output=$(psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d messenger_test -f /migrations/0012_group_list_activity_index.sql 2>&1); then
  printf "%s\n" "expected NULLS LAST same-name index validation to fail" >&2
  exit 1
else
  case "$output" in
    *"exists with an unexpected definition"*) printf "%s\n" "Validated: migration rejects a same-name index with DESC NULLS LAST." ;;
    *) printf "%s\n" "$output" >&2; printf "%s\n" "unexpected failure while validating NULLS LAST same-name index" >&2; exit 1 ;;
  esac
fi
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d messenger_test <<"SQL"
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = $q$0012_group_list_activity_index$q$) THEN
        RAISE EXCEPTION $q$migration version was recorded after rejecting the NULLS LAST index$q$;
    END IF;
END $$;
DROP INDEX CONCURRENTLY conversations_group_activity_idx;
SQL
printf "%s\n" "Validated: rejected DESC NULLS LAST index did not record the migration version and was removed concurrently."

if output=$(psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d messenger_test -c "CREATE UNIQUE INDEX CONCURRENTLY conversations_group_activity_idx ON conversations (kind) WHERE kind = \$q\$group\$q\$;" 2>&1); then
  printf "%s\n" "expected duplicate group kinds to fail the concurrent unique index build" >&2
  exit 1
else
  case "$output" in
    *"could not create unique index"*|*"duplicate key value violates unique constraint"*) ;;
    *) printf "%s\n" "$output" >&2; printf "%s\n" "unexpected failure while creating the intentionally invalid concurrent index" >&2; exit 1 ;;
  esac
fi
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d messenger_test <<"SQL"
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_class index_class
        JOIN pg_namespace index_namespace ON index_namespace.oid = index_class.relnamespace
        JOIN pg_index index_state ON index_state.indexrelid = index_class.oid
        WHERE index_namespace.nspname = current_schema()
          AND index_class.relname = $q$conversations_group_activity_idx$q$
          AND NOT index_state.indisvalid
    ) THEN
        RAISE EXCEPTION $q$failed concurrent build did not leave the expected invalid index$q$;
    END IF;
END $$;
SQL
printf "%s\n" "Validated: duplicate group kinds leave an invalid same-name concurrent index."

assert_migration_index() {
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d messenger_test <<"SQL"
DO $$
DECLARE
    inspected_index record;
    migration_count integer;
BEGIN
    SELECT index_state.indisvalid,
           index_state.indisready,
           index_state.indisunique,
           index_state.indnkeyatts,
           index_state.indnatts,
           access_method.amname,
           table_class.relname AS table_name,
           pg_get_indexdef(index_class.oid, 1, true) AS first_key,
           pg_get_indexdef(index_class.oid, 2, true) AS second_key,
            (index_state.indoption[0] & 3) AS first_ordering_options,
            (index_state.indoption[1] & 3) AS second_ordering_options,
            first_opclass.opcname AS first_opclass,
            first_opclass_namespace.nspname AS first_opclass_schema,
            second_opclass.opcname AS second_opclass,
            second_opclass_namespace.nspname AS second_opclass_schema,
            index_state.indcollation[0] AS first_collation,
            index_state.indcollation[1] AS second_collation,
            pg_get_expr(index_state.indpred, index_state.indrelid) AS predicate
     INTO inspected_index
    FROM pg_class index_class
    JOIN pg_namespace index_namespace ON index_namespace.oid = index_class.relnamespace
    JOIN pg_index index_state ON index_state.indexrelid = index_class.oid
    JOIN pg_class table_class ON table_class.oid = index_state.indrelid
    JOIN pg_am access_method ON access_method.oid = index_class.relam
    JOIN pg_opclass first_opclass ON first_opclass.oid = index_state.indclass[0]
    JOIN pg_namespace first_opclass_namespace ON first_opclass_namespace.oid = first_opclass.opcnamespace
    JOIN pg_opclass second_opclass ON second_opclass.oid = index_state.indclass[1]
    JOIN pg_namespace second_opclass_namespace ON second_opclass_namespace.oid = second_opclass.opcnamespace
    WHERE index_namespace.nspname = current_schema()
      AND index_class.relname = $q$conversations_group_activity_idx$q$;

    IF NOT FOUND
       OR NOT inspected_index.indisvalid
       OR NOT inspected_index.indisready
       OR inspected_index.indisunique
       OR inspected_index.indnkeyatts <> 2
       OR inspected_index.indnatts <> 2
       OR inspected_index.amname <> $q$btree$q$
       OR inspected_index.table_name <> $q$conversations$q$
       OR inspected_index.first_key <> $q$COALESCE(last_message_at, created_at)$q$
        OR inspected_index.first_ordering_options <> 3
        OR inspected_index.first_opclass <> $q$timestamptz_ops$q$
        OR inspected_index.first_opclass_schema <> $q$pg_catalog$q$
        OR inspected_index.first_collation <> 0
        OR inspected_index.second_key <> $q$id$q$
        OR inspected_index.second_ordering_options <> 3
        OR inspected_index.second_opclass <> $q$uuid_ops$q$
        OR inspected_index.second_opclass_schema <> $q$pg_catalog$q$
        OR inspected_index.second_collation <> 0
       OR inspected_index.predicate <> $q$(kind = $q$ || chr(39) || $q$group$q$ || chr(39) || $q$::text)$q$ THEN
        RAISE EXCEPTION $q$recovered group activity index does not have the expected valid definition$q$;
    END IF;

    SELECT count(*) INTO migration_count
    FROM schema_migrations
    WHERE version = $q$0012_group_list_activity_index$q$;
    IF migration_count <> 1 THEN
        RAISE EXCEPTION $q$migration version count is %, want exactly one$q$, migration_count;
    END IF;
END $$;
SQL
}

psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d messenger_test -f /migrations/0012_group_list_activity_index.sql
assert_migration_index
printf "%s\n" "Validated: rerun drops the invalid index, builds the correct valid/ready index, and records the version exactly once."

psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d messenger_test -f /migrations/0012_group_list_activity_index.sql
assert_migration_index
printf "%s\n" "Validated: migration rerun is idempotent and preserves one version row and the correct index."

# Keep runner one connected after the migration file finishes. An outer
# acquisition of the migration session lock models a runner still inside its
# migration lifecycle; the migration matching unlock leaves this guard held.
# Runner two must be observed waiting on that exact advisory lock before the
# guard is released, so this assertion is state-based rather than sleep-based.
lock_gate=/tmp/migration-0012-runner-one.release
runner_one_log=/tmp/migration-0012-runner-one.log
runner_two_log=/tmp/migration-0012-runner-two.log
rm -f "$lock_gate" "$runner_one_log" "$runner_two_log"
{
  printf "%s\n" "SELECT pg_advisory_lock(1515668809, 12);"
  cat /migrations/0012_group_list_activity_index.sql
  printf "%s\n" "\\! while [ ! -e $lock_gate ]; do sleep 0.1; done"
} | PGAPPNAME=migration_0012_runner_one psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d messenger_test >"$runner_one_log" 2>&1 &
runner_one_pid=$!

runner_one_ready=0
attempt=0
while [ "$attempt" -lt 300 ]; do
  if psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d messenger_test -Atc "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = \$q\$migration_0012_runner_one\$q\$)" | grep -qx t; then
    if psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d messenger_test -Atc "SELECT count(*) = 1 FROM schema_migrations WHERE version = \$q\$0012_group_list_activity_index\$q\$" | grep -qx t; then
      runner_one_ready=1
      break
    fi
  fi
  attempt=$((attempt + 1))
  sleep 0.1
done
if [ "$runner_one_ready" -ne 1 ]; then
  : >"$lock_gate"
  wait "$runner_one_pid" || true
  printf "%s\n" "runner one did not finish migration while retaining its session lock" >&2
  cat "$runner_one_log" >&2
  exit 1
fi

PGAPPNAME=migration_0012_runner_two psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d messenger_test -f /migrations/0012_group_list_activity_index.sql >"$runner_two_log" 2>&1 &
runner_two_pid=$!
runner_two_blocked=0
attempt=0
while [ "$attempt" -lt 300 ]; do
  if psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d messenger_test -Atc "SELECT EXISTS (SELECT 1 FROM pg_stat_activity activity JOIN pg_locks lock ON lock.pid = activity.pid WHERE activity.application_name = \$q\$migration_0012_runner_two\$q\$ AND lock.locktype = \$q\$advisory\$q\$ AND lock.classid = 1515668809 AND lock.objid = 12 AND lock.objsubid = 2 AND NOT lock.granted)" | grep -qx t; then
    runner_two_blocked=1
    break
  fi
  attempt=$((attempt + 1))
  sleep 0.1
done
if [ "$runner_two_blocked" -ne 1 ]; then
  : >"$lock_gate"
  wait "$runner_one_pid" || true
  wait "$runner_two_pid" || true
  printf "%s\n" "runner two was not observed waiting on the migration advisory lock" >&2
  cat "$runner_one_log" "$runner_two_log" >&2
  exit 1
fi
assert_migration_index
: >"$lock_gate"
wait "$runner_one_pid"
wait "$runner_two_pid"
assert_migration_index
rm -f "$lock_gate" "$runner_one_log" "$runner_two_log"
printf "%s\n" "Validated: runner two waited on the session advisory lock until runner one completed, then exactly one correct index/version remained."

psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d messenger_test <<"SQL"
DELETE FROM conversations WHERE id IN ($q$12000000-0000-4000-8000-000000000112$q$, $q$12000000-0000-4000-8000-000000000212$q$);
DELETE FROM users WHERE id = $q$12000000-0000-4000-8000-000000000012$q$;
SQL
'
