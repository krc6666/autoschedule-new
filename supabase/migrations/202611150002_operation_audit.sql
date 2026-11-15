-- Additive migration. Existing saves (including older clients) use this trigger.
-- Install after 202611150001; prior activity is intentionally not reconstructed.
begin;

create table public.autoschedule_audit_entries (
  id bigint generated always as identity primary key,
  actor_id uuid,
  actor_label text not null,
  occurred_at timestamptz not null default clock_timestamp(),
  workspace_version bigint not null unique,
  change_count integer not null check (change_count > 0),
  staff_labels jsonb not null
);
create table public.autoschedule_audit_changes (
  entry_id bigint not null references public.autoschedule_audit_entries(id) on delete cascade,
  ordinal integer not null,
  scope text not null check (scope in ('A', 'B', 'shared')),
  area text not null,
  entity_key text not null,
  operation text not null check (operation in ('add', 'update', 'delete')),
  before_value jsonb,
  after_value jsonb,
  primary key (entry_id, ordinal)
);
alter table public.autoschedule_audit_entries enable row level security;
alter table public.autoschedule_audit_changes enable row level security;
revoke all on public.autoschedule_audit_entries, public.autoschedule_audit_changes
  from public, anon, authenticated;
revoke all on sequence public.autoschedule_audit_entries_id_seq from public, anon, authenticated;

-- Only canonical facts, never the duplicated active-group root projection.
-- Rows have stable keys, so editing one row does not report every later row.
create function public.cloud_audit_entities(p_model jsonb)
returns table(scope text, area text, entity_key text, value jsonb)
language sql immutable set search_path = '' as $$
  with sections as (
    select g.key as scope, s.key as area, s.value,
      g.value->'activeScheduleDate' as work_date
    from jsonb_each(coalesce(p_model->'groups', '{}'::jsonb)) g
    cross join lateral jsonb_each(g.value) s
    where g.key in ('A', 'B')
      and s.key not in ('scheduleRuleFingerprint', 'schedulePolicyStale')
    union all
    select 'shared', s.key, s.value, null::jsonb
    from jsonb_each(coalesce(p_model->'shared', '{}'::jsonb)) s
  ), entities as (
    select s.scope, s.area, e.key as entity_key, e.value
    from sections s cross join lateral jsonb_each(
      case when s.area in ('settings', 'flightSeasonOverrides') and jsonb_typeof(s.value) = 'object'
        then s.value else '{}'::jsonb end) e
    union all
    select s.scope, s.area,
      case
        when item ? 'id' then item->>'id'
        when s.area in ('dutyRosterOverrides', 'halfRestSelections') then item->>'date'
        when s.area = 'weeklyFlightPlans' then item->>'weekday'
        when s.area = 'latePriorityFrequencyAdjustments' then
          jsonb_build_array(item->'month', item->'staffId', item->'flightNo', item->'kind')::text
        when s.area = 'ordinaryPriorityFrequencyAdjustments' then
          jsonb_build_array(item->'month', item->'staffId', item->'airlineCode', item->'position')::text
        else ord::text
      end,
      case
        when s.area = 'assignments' then
          (item - 'decisionTrace' - 'decisionEvidence' - 'vacancyEvidence') || jsonb_build_object('date', s.work_date)
        when s.area in ('templates', 'flights') then item - 'positions'
        else item
      end
    from sections s cross join lateral jsonb_array_elements(
      case when jsonb_typeof(s.value) = 'array' then s.value else '[]'::jsonb end
    ) with ordinality a(item, ord)
    union all
    select s.scope, s.area, '$value', s.value from sections s
    where jsonb_typeof(s.value) <> 'array'
      and not (s.area in ('settings', 'flightSeasonOverrides') and jsonb_typeof(s.value) = 'object')
    union all
    select s.scope, s.area, '$order',
      (select coalesce(jsonb_agg(item->'id' order by ord), '[]'::jsonb)
       from jsonb_array_elements(s.value) with ordinality a(item, ord))
    from sections s where s.area in ('staff', 'flights', 'positionRules', 'templates', 'leaveTypes')
      and jsonb_typeof(s.value) = 'array'
  ) select scope, area, coalesce(entity_key, '$unknown'), value from entities;
$$;
revoke all on function public.cloud_audit_entities(jsonb) from public, anon, authenticated;

create function public.cloud_write_workspace_audit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  prior jsonb;
  changes jsonb;
  labels jsonb;
  entry_id bigint;
  actor uuid := auth.uid();
  actor_name text;
begin
  if tg_op = 'UPDATE' then prior := old.model; end if;
  with previous as (select * from public.cloud_audit_entities(prior)),
       current as (select * from public.cloud_audit_entities(new.model))
  select jsonb_agg(jsonb_build_object(
      'scope', coalesce(c.scope, p.scope), 'area', coalesce(c.area, p.area),
      'key', coalesce(c.entity_key, p.entity_key),
      'operation', case when p.scope is null then 'add' when c.scope is null then 'delete' else 'update' end,
      'before', p.value, 'after', c.value
    ) order by coalesce(c.scope, p.scope), coalesce(c.area, p.area), coalesce(c.entity_key, p.entity_key))
    into changes
  from previous p full join current c using(scope, area, entity_key)
  where p.value is distinct from c.value;
  if changes is null then return new; end if;

  -- Display references are snapshots, so later renames/deletions cannot rewrite old records.
  select jsonb_object_agg(side, groups) into labels from (
    select side, jsonb_object_agg(group_id, names) as groups from (
      select m.side, g.key as group_id, coalesce((
        select jsonb_object_agg(s->>'id', s->>'name')
        from jsonb_array_elements(coalesce(g.value->'staff', '[]'::jsonb)) s
      ), '{}'::jsonb) as names
      from (values ('before', prior), ('after', new.model)) m(side, model)
      cross join lateral jsonb_each(coalesce(m.model->'groups', '{}'::jsonb)) g
      where g.key in ('A', 'B')
    ) refs group by side
  ) sides;
  select email into actor_name from auth.users where id = actor;
  insert into public.autoschedule_audit_entries(actor_id, actor_label, workspace_version, change_count, staff_labels)
    values (actor, coalesce(nullif(actor_name, ''), actor::text, '数据库维护'),
      new.version, jsonb_array_length(changes), coalesce(labels, '{}'::jsonb)) returning id into entry_id;
  insert into public.autoschedule_audit_changes(entry_id, ordinal, scope, area, entity_key, operation, before_value, after_value)
    select entry_id, ord::integer, item->>'scope', item->>'area', item->>'key', item->>'operation',
      item->'before', item->'after'
    from jsonb_array_elements(changes) with ordinality a(item, ord);
  return new;
end;
$$;
revoke all on function public.cloud_write_workspace_audit() from public, anon, authenticated;
create trigger autoschedule_workspace_audit after insert or update on public.autoschedule_workspace
  for each row execute function public.cloud_write_workspace_audit();

create function public.cloud_list_audit(p_before_id bigint default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  perform public.cloud_require_admin();
  if p_before_id is not null and p_before_id <= 0 then raise exception 'INVALID_AUDIT_CURSOR'; end if;
  with candidates as (
    select * from public.autoschedule_audit_entries
    where p_before_id is null or id < p_before_id order by id desc limit 21
  ), page as (select * from candidates order by id desc limit 20)
  select jsonb_build_object('entries', coalesce((
    select jsonb_agg(jsonb_build_object('id', id::text, 'actor', actor_label,
      'occurredAt', occurred_at, 'version', workspace_version, 'changeCount', change_count) order by id desc) from page
  ), '[]'::jsonb), 'nextCursor', case when (select count(*) from candidates) > 20
    then (select min(id)::text from page) else null end) into result;
  return result;
end;
$$;

create function public.cloud_audit_details(p_entry_id bigint, p_after_index integer default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare result jsonb; labels jsonb;
begin
  perform public.cloud_require_admin();
  if p_entry_id is null or p_entry_id <= 0 or p_after_index is null or p_after_index < 0 then
    raise exception 'INVALID_AUDIT_CURSOR';
  end if;
  select staff_labels into labels from public.autoschedule_audit_entries where id = p_entry_id;
  if not found then raise exception 'AUDIT_NOT_FOUND'; end if;
  with candidates as (
    select * from public.autoschedule_audit_changes where entry_id = p_entry_id and ordinal > p_after_index
    order by ordinal limit 51
  ), page as (select * from candidates order by ordinal limit 50)
  select jsonb_build_object('changes', coalesce((
    select jsonb_agg(jsonb_build_object('index', ordinal, 'scope', scope, 'area', area, 'key', entity_key,
      'operation', operation, 'before', before_value, 'after', after_value) order by ordinal) from page
  ), '[]'::jsonb), 'staffLabels', labels, 'nextCursor', case when (select count(*) from candidates) > 50
    then (select max(ordinal) from page) else null end) into result;
  return result;
end;
$$;
revoke all on function public.cloud_list_audit(bigint) from public, anon, authenticated;
revoke all on function public.cloud_audit_details(bigint, integer) from public, anon, authenticated;
grant execute on function public.cloud_list_audit(bigint) to authenticated;
grant execute on function public.cloud_audit_details(bigint, integer) to authenticated;
commit;
