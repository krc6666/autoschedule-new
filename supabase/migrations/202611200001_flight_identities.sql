-- Directory-aware clients keep AppState v12; the shared contract is versioned
-- independently. Never modify an already deployed migration.
begin;

create function public.cloud_validate_flight_identity_write() returns trigger
language plpgsql security definer set search_path = '' as $$
declare directory jsonb; item jsonb; alias jsonb; workspace jsonb; reference text;
begin
  if tg_op = 'UPDATE' and old.model->'shared'->>'flightIdentitySchemaVersion' = '1'
    and new.model->'shared'->>'flightIdentitySchemaVersion' is distinct from '1' then
    raise exception 'FLIGHT_IDENTITY_CLIENT_UPGRADE_REQUIRED';
  end if;
  if new.model->'shared' ? 'flightIdentitySchemaVersion'
    and new.model->'shared'->>'flightIdentitySchemaVersion' is distinct from '1' then
    raise exception 'FLIGHT_IDENTITY_SCHEMA_UNSUPPORTED';
  end if;
  directory := new.model->'shared'->'flightIdentities';
  if directory is null then directory := '[]'::jsonb;
  elsif jsonb_typeof(directory) is distinct from 'array'
    or new.model->'shared'->>'flightIdentitySchemaVersion' is distinct from '1' then
    raise exception 'FLIGHT_IDENTITY_INVALID';
  end if;
  for item in select value from jsonb_array_elements(directory) loop
    if jsonb_typeof(item) is distinct from 'object' or jsonb_typeof(item->'id') is distinct from 'string'
      or coalesce(item->>'id','') !~ '^[A-Za-z0-9_-]+$'
      or jsonb_typeof(item->'displayName') is distinct from 'string'
      or left(trim(item->>'displayName'),1) = '@'
      or length(trim(coalesce(item->>'displayName',''))) = 0
      or jsonb_typeof(item->'aliases') is distinct from 'array'
      or jsonb_array_length(item->'aliases') = 0 then raise exception 'FLIGHT_IDENTITY_INVALID'; end if;
    for alias in select value from jsonb_array_elements(item->'aliases') loop
      if jsonb_typeof(alias) is distinct from 'object' or jsonb_typeof(alias->'flightNo') is distinct from 'string'
        or length(trim(coalesce(alias->>'flightNo',''))) = 0
        or left(regexp_replace(alias->>'flightNo','\s+','','g'),1) = '@' then raise exception 'FLIGHT_IDENTITY_INVALID'; end if;
      if (alias ? 'from' and jsonb_typeof(alias->'from') is distinct from 'string')
        or (alias ? 'until' and jsonb_typeof(alias->'until') is distinct from 'string') then raise exception 'FLIGHT_IDENTITY_DATE_INVALID'; end if;
      if alias ? 'from' and ((alias->>'from') !~ '^\d{4}-\d{2}-\d{2}$' or to_char((alias->>'from')::date,'YYYY-MM-DD') <> alias->>'from') then raise exception 'FLIGHT_IDENTITY_DATE_INVALID'; end if;
      if alias ? 'until' and ((alias->>'until') !~ '^\d{4}-\d{2}-\d{2}$' or to_char((alias->>'until')::date,'YYYY-MM-DD') <> alias->>'until') then raise exception 'FLIGHT_IDENTITY_DATE_INVALID'; end if;
      if coalesce(alias->>'from','0001-01-01') > coalesce(alias->>'until','9999-12-31') then raise exception 'FLIGHT_IDENTITY_DATE_INVALID'; end if;
      if alias ? 'positionSourceFlightNo' and (jsonb_typeof(alias->'positionSourceFlightNo') is distinct from 'string'
        or not exists (select 1 from jsonb_array_elements(item->'aliases') a where upper(regexp_replace(a->>'flightNo','\s+','','g')) = upper(regexp_replace(alias->>'positionSourceFlightNo','\s+','','g')))) then raise exception 'FLIGHT_IDENTITY_POSITION_SOURCE_INVALID'; end if;
    end loop;
  end loop;
  if exists (select 1 from jsonb_array_elements(directory) i group by upper(i->>'id') having count(*) > 1)
    or exists (select 1 from jsonb_array_elements(directory) i group by upper(regexp_replace(i->>'displayName','\s+','','g')) having count(*) > 1) then raise exception 'FLIGHT_IDENTITY_DUPLICATE'; end if;
  if exists (
    with aliases as (
      select row_number() over () n, upper(regexp_replace(a->>'flightNo','\s+','','g')) no,
        coalesce(a->>'from','0001-01-01') first_date, coalesce(a->>'until','9999-12-31') last_date
      from jsonb_array_elements(directory) i cross join lateral jsonb_array_elements(i->'aliases') a
    ) select 1 from aliases a join aliases b on a.n < b.n and a.no=b.no
      and a.first_date <= b.last_date and b.first_date <= a.last_date
  ) then raise exception 'FLIGHT_IDENTITY_DATE_OVERLAP'; end if;
  -- Flight target field names are generic across structured rule collections;
  -- inspect only executable references, never unrelated remarks or labels.
  for workspace in select value from jsonb_array_elements(jsonb_build_array(new.model, new.model#>'{groups,A}', new.model#>'{groups,B}')) loop
    for reference in
      select upper(regexp_replace(value #>> '{}','\s+','','g')) from (
        select jsonb_path_query(workspace, '$.settings.**.flightNo') value
        union select jsonb_path_query(workspace, '$.settings.**.sourceFlightNo')
        union select jsonb_path_query(workspace, '$.settings.**.targetFlightNo')
        union select jsonb_path_query(workspace, '$.settings.latePriorityFlightNumbers[*]')
        union select jsonb_path_query(workspace, '$.settings.relaxedShiftFlightNumbers[*]')
        union select jsonb_path_query(workspace, '$.latePriorityFrequencyAdjustments[*].flightNo')
      ) references_to_check
    loop
      if left(reference,1) = '@' and not exists (
        select 1 from jsonb_array_elements(directory) i where '@' || upper(i->>'id') = reference
      ) then raise exception 'FLIGHT_IDENTITY_REFERENCE_MISSING'; end if;
    end loop;
  end loop;
  return new;
end;
$$;
revoke all on function public.cloud_validate_flight_identity_write() from public, anon, authenticated;
create trigger autoschedule_flight_identity_guard before insert or update on public.autoschedule_workspace
  for each row execute function public.cloud_validate_flight_identity_write();

-- Old server archive contents are explicitly upgraded to independent names.
-- New archive directories remain unchanged; CAS, session lock, audit and
-- automatic backup continue through the existing save function.
create or replace function public.cloud_restore_workspace_version_locked(p_expected_version bigint, p_version_id bigint, p_session_id text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare current_version bigint; archived jsonb;
begin
  perform public.cloud_require_editor_session(p_session_id);
  select version into current_version from public.autoschedule_workspace where singleton for update;
  if current_version is null or p_expected_version is distinct from current_version then raise exception 'WORKSPACE_CONFLICT'; end if;
  select content into archived from public.schedule_versions where id = p_version_id;
  if not found then raise exception 'VERSION_NOT_FOUND'; end if;
  if not (archived->'shared' ? 'flightIdentitySchemaVersion') then
    archived := jsonb_set(archived, '{shared}', (archived->'shared') || jsonb_build_object('flightIdentitySchemaVersion',1,'flightIdentities','[]'::jsonb));
  end if;
  return public.cloud_save_workspace_locked(p_expected_version, archived, p_session_id);
end;
$$;
revoke all on function public.cloud_restore_workspace_version_locked(bigint,bigint,text) from public, anon, authenticated;
grant execute on function public.cloud_restore_workspace_version_locked(bigint,bigint,text) to authenticated;
commit;
