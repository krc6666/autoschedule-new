with tables as (
  select oid, relname, relrowsecurity, relforcerowsecurity,
    has_table_privilege('anon', oid, 'select,insert,update,delete,truncate,references,trigger') as anon_granted,
    has_table_privilege('authenticated', oid, 'select,insert,update,delete,truncate,references,trigger') as auth_granted
  from pg_class
  where relnamespace = 'public'::regnamespace and relkind in ('r', 'p')
    and (relname like 'autoschedule\_%' or relname = 'schedule_versions')
), routines as (
  select oid, proname, oidvectortypes(proargtypes) as arguments, pg_get_function_result(oid) as result,
    replace(prosrc, chr(13), '') as source, prosecdef, provolatile, proconfig, pronargdefaults,
    has_function_privilege('anon', oid, 'execute') as anon_granted,
    has_function_privilege('authenticated', oid, 'execute') as auth_granted
  from pg_proc
  where pronamespace = 'public'::regnamespace and proname like 'cloud\_%'
), metadata(kind, parent, name, definition) as (
  select 'table', '', relname, (to_jsonb(tables) - 'oid')::text from tables
  union all select 'column', relname, attname, jsonb_build_array(attnum, format_type(atttypid, atttypmod),
    attnotnull, attidentity, pg_get_expr(adbin, adrelid))::text
    from tables join pg_attribute on attrelid = tables.oid and attnum > 0 and not attisdropped
    left join pg_attrdef on adrelid = attrelid and adnum = attnum
  union all select 'constraint', relname, conname, pg_get_constraintdef(pg_constraint.oid)
    from tables join pg_constraint on conrelid = tables.oid and contype <> 'n'
  union all select 'index', tables.relname, index_class.relname, pg_get_indexdef(index_class.oid)
    from tables join pg_index on indrelid = tables.oid join pg_class index_class on index_class.oid = indexrelid
  union all select 'trigger', relname, tgname, tgenabled::text || pg_get_triggerdef(pg_trigger.oid)
    from tables join pg_trigger on tgrelid = tables.oid and not tgisinternal
  union all select 'policy', relname, policyname, (to_jsonb(pg_policies) - 'schemaname' - 'tablename')::text
    from tables join pg_policies on schemaname = 'public' and tablename = relname
  union all select 'function', proname, arguments, (to_jsonb(routines) - 'oid')::text from routines
)
select md5(coalesce(jsonb_agg(metadata order by kind collate "C", parent collate "C", name collate "C")::text, '[]'))
from metadata;
