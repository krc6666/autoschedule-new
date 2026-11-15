-- Apply through Supabase migrations or SQL Editor. No user is made admin here.
begin;

create table public.autoschedule_admin (
  singleton boolean primary key default true check (singleton),
  user_id uuid not null unique references auth.users(id) on delete restrict
);
create table public.autoschedule_workspace (
  singleton boolean primary key default true check (singleton),
  version bigint not null check (version > 0),
  model jsonb not null,
  updated_at timestamptz not null default now()
);
create table public.autoschedule_publications (
  token uuid primary key default gen_random_uuid(),
  group_id text not null check (group_id in ('A', 'B')),
  schedule_date date not null,
  snapshot jsonb not null,
  unique (group_id, schedule_date)
);

alter table public.autoschedule_admin enable row level security;
alter table public.autoschedule_workspace enable row level security;
alter table public.autoschedule_publications enable row level security;
-- No direct client table access, including to the publication directory.
revoke all on public.autoschedule_admin, public.autoschedule_workspace,
  public.autoschedule_publications from public, anon, authenticated;

create function public.cloud_require_admin() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.autoschedule_admin where user_id = auth.uid()
  ) then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;
end;
$$;
revoke all on function public.cloud_require_admin() from public, anon, authenticated;

create function public.cloud_load_workspace() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  perform public.cloud_require_admin();
  select jsonb_build_object('version', version, 'model', model)
    into result from public.autoschedule_workspace where singleton;
  return coalesce(result, jsonb_build_object('version', 0, 'model', null));
end;
$$;

create function public.cloud_save_workspace(p_expected_version bigint, p_model jsonb)
returns bigint language plpgsql security definer set search_path = '' as $$
declare next_version bigint;
begin
  perform public.cloud_require_admin();
  if p_expected_version is null or p_expected_version < 0 or
    (jsonb_typeof(p_model) = 'object' and
     p_model->>'version' = '12' and
     p_model->>'activeGroupId' in ('A','B') and
     jsonb_typeof(p_model->'shared') = 'object' and
     jsonb_typeof(p_model->'groups'->'A') = 'object' and
     jsonb_typeof(p_model->'groups'->'B') = 'object' and
     jsonb_typeof(p_model->'groups'->'A'->'assignments') = 'array' and
     jsonb_typeof(p_model->'groups'->'B'->'assignments') = 'array') is distinct from true
  then raise exception 'INVALID_WORKSPACE'; end if;

  if p_expected_version = 0 then
    insert into public.autoschedule_workspace(singleton, version, model)
      values (true, 1, p_model) on conflict (singleton) do nothing
      returning version into next_version;
  else
    update public.autoschedule_workspace
      set model = p_model, version = version + 1, updated_at = now()
      where singleton and version = p_expected_version
      returning version into next_version;
  end if;
  if next_version is null then raise exception 'WORKSPACE_CONFLICT'; end if;
  return next_version;
end;
$$;

-- Project from the SAVED group, not client-supplied public HTML or JSON.
create function public.cloud_publish_schedule(p_expected_version bigint, p_group_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  workspace public.autoschedule_workspace%rowtype;
  grp jsonb;
  rows jsonb;
  result jsonb;
  publish_token uuid;
  work_date date;
begin
  perform public.cloud_require_admin();
  select * into workspace from public.autoschedule_workspace where singleton for update;
  if workspace.version is null or p_expected_version is distinct from workspace.version then
    raise exception 'WORKSPACE_CONFLICT';
  end if;
  if p_group_id is null or p_group_id not in ('A', 'B') then
    raise exception 'INVALID_GROUP';
  end if;
  grp := workspace.model->'groups'->p_group_id;
  if grp->>'activeScheduleDate' is null or
     grp->>'schedulePolicyStale' is distinct from 'false' or
     jsonb_array_length(grp->'assignments') = 0 then
    raise exception 'SCHEDULE_NOT_PUBLISHABLE';
  end if;
  work_date := (grp->>'activeScheduleDate')::date;
  select jsonb_agg(jsonb_build_object(
    'flightNo', item->>'flightNo', 'position', item->>'position',
    'staffName', coalesce(item->>'staffName', ''),
    'startTime', item->>'startTime', 'endTime', item->>'endTime',
    'remark', coalesce(item->>'remark', ''),
    'status', item->>'status'
  ) order by ordinal) into rows
  from jsonb_array_elements(grp->'assignments') with ordinality as a(item, ordinal);
  result := jsonb_build_object('schemaVersion', 1, 'groupId', p_group_id,
    'date', work_date::text, 'publishedAt', now(), 'rows', rows);
  insert into public.autoschedule_publications(group_id, schedule_date, snapshot)
    values (p_group_id, work_date, result)
    on conflict (group_id, schedule_date) do update set snapshot = excluded.snapshot
    returning token into publish_token;
  return jsonb_build_object('token', publish_token, 'snapshot', result);
end;
$$;

create function public.cloud_read_publication(p_token uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select snapshot from public.autoschedule_publications where token = p_token
$$;

revoke all on function public.cloud_load_workspace() from public, anon, authenticated;
revoke all on function public.cloud_save_workspace(bigint, jsonb) from public, anon, authenticated;
revoke all on function public.cloud_publish_schedule(bigint, text) from public, anon, authenticated;
revoke all on function public.cloud_read_publication(uuid) from public, anon, authenticated;
grant execute on function public.cloud_load_workspace() to authenticated;
grant execute on function public.cloud_save_workspace(bigint, jsonb) to authenticated;
grant execute on function public.cloud_publish_schedule(bigint, text) to authenticated;
grant execute on function public.cloud_read_publication(uuid) to anon, authenticated;
commit;
