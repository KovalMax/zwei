-- Serialize recovery, concurrent index creation, and version recording across
-- migration runners. The two-int key is namespaced to Zwei migration 0012.
-- This is a session lock: psql keeps one connection for the entire -f file,
-- and PostgreSQL releases it if the client exits on any error.
SELECT pg_advisory_lock(1515668809, 12);

-- A cancelled concurrent build may leave an invalid index. Drop only that
-- invalid object before retrying; never silently accept it via IF NOT EXISTS.
SELECT format('DROP INDEX CONCURRENTLY %I.%I;', namespace.nspname, index_class.relname)
FROM pg_class index_class
JOIN pg_namespace namespace ON namespace.oid = index_class.relnamespace
JOIN pg_index index_state ON index_state.indexrelid = index_class.oid
WHERE namespace.nspname = current_schema()
  AND index_class.relname = 'conversations_group_activity_idx'
  AND NOT index_state.indisvalid
\gexec

-- A valid object with this dedicated name must match the ordering we need.
DO $$
DECLARE
    existing_index record;
BEGIN
    SELECT index_state.indrelid AS table_oid,
           index_state.indisvalid,
           index_state.indisready,
           index_state.indisunique,
           index_state.indnkeyatts,
           index_state.indnatts,
           access_method.amname,
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
    INTO existing_index
    FROM pg_class index_class
    JOIN pg_namespace index_namespace ON index_namespace.oid = index_class.relnamespace
    LEFT JOIN pg_index index_state ON index_state.indexrelid = index_class.oid
    LEFT JOIN pg_am access_method ON access_method.oid = index_class.relam
    LEFT JOIN pg_opclass first_opclass ON first_opclass.oid = index_state.indclass[0]
    LEFT JOIN pg_namespace first_opclass_namespace ON first_opclass_namespace.oid = first_opclass.opcnamespace
    LEFT JOIN pg_opclass second_opclass ON second_opclass.oid = index_state.indclass[1]
    LEFT JOIN pg_namespace second_opclass_namespace ON second_opclass_namespace.oid = second_opclass.opcnamespace
    WHERE index_namespace.nspname = current_schema()
      AND index_class.relname = 'conversations_group_activity_idx';

    IF NOT FOUND THEN
        RETURN;
    END IF;

    IF existing_index.table_oid IS NULL THEN
        RAISE EXCEPTION 'conversations_group_activity_idx exists but is not an index';
    END IF;

    IF NOT existing_index.indisvalid THEN
        RAISE EXCEPTION 'conversations_group_activity_idx remains invalid after concurrent-build recovery';
    END IF;

    IF NOT existing_index.indisready
       OR existing_index.table_oid <> to_regclass(format('%I.conversations', current_schema()))
       OR existing_index.amname <> 'btree'
       OR existing_index.indisunique
       OR existing_index.indnkeyatts <> 2
       OR existing_index.indnatts <> 2
       OR existing_index.first_key <> 'COALESCE(last_message_at, created_at)'
        OR existing_index.first_ordering_options <> 3
        OR existing_index.first_opclass <> 'timestamptz_ops'
        OR existing_index.first_opclass_schema <> 'pg_catalog'
        OR existing_index.first_collation <> 0
        OR existing_index.second_key <> 'id'
        OR existing_index.second_ordering_options <> 3
        OR existing_index.second_opclass <> 'uuid_ops'
        OR existing_index.second_opclass_schema <> 'pg_catalog'
        OR existing_index.second_collation <> 0
       OR existing_index.predicate <> '(kind = ''group''::text)' THEN
        RAISE EXCEPTION 'conversations_group_activity_idx exists with an unexpected definition';
    END IF;
END $$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS conversations_group_activity_idx
    ON conversations ((COALESCE(last_message_at, created_at)) DESC, id DESC)
    WHERE kind = 'group';

INSERT INTO schema_migrations (version)
VALUES ('0012_group_list_activity_index')
ON CONFLICT (version) DO NOTHING;

SELECT pg_advisory_unlock(1515668809, 12);
