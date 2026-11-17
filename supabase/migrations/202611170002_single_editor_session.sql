-- Additive migration. Run after the workspace, audit, and version migrations.
-- A session lease is server-authoritative; sessionStorage is only an id holder.
begin;

create table public.autoschedule_editor_sessions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  session_id text not null check (char_length(session_id) between 16 and 200),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null
);
alter table public.autoschedule_editor_sessions enable row level security;
revoke all on public.autoschedule_editor_sessions from public, anon, authenticated;

create function public.cloud_acquire_editor_session(
  p_session_id text,
  p_takeover boolean default false
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare current_session public.autoschedule_editor_sessions%rowtype;
declare next_expiry timestamptz;
begin
  perform public.cloud_require_admin();
  if p_session_id is null or char_length(trim(p_session_id)) not between 16 and 200 then
    raise exception 'SESSION_INVALID';
  end if;
  select * into current_session
    from public.autoschedule_editor_sessions
    where user_id = auth.uid()
    for update;
  if found and current_session.session_id <> p_session_id
    and current_session.expires_at > now() and not coalesce(p_takeover, false) then
    raise exception 'SESSION_ACTIVE';
  end if;
  next_expiry := now() + interval '90 seconds';
  insert into public.autoschedule_editor_sessions(user_id, session_id, last_seen_at, expires_at)
    values (auth.uid(), trim(p_session_id), now(), next_expiry)
    on conflict (user_id) do update set
      session_id = excluded.session_id,
      last_seen_at = excluded.last_seen_at,
      expires_at = excluded.expires_at;
  return jsonb_build_object('expiresAt', next_expiry);
end;
$$;

create function public.cloud_touch_editor_session(p_session_id text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.cloud_require_admin();
  update public.autoschedule_editor_sessions
    set last_seen_at = now(), expires_at = now() + interval '90 seconds'
    where user_id = auth.uid() and session_id = trim(p_session_id)
      and expires_at > now();
  if not found then raise exception 'SESSION_EXPIRED'; end if;
end;
$$;

create function public.cloud_release_editor_session(p_session_id text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.cloud_require_admin();
  delete from public.autoschedule_editor_sessions
    where user_id = auth.uid() and session_id = trim(p_session_id);
end;
$$;

-- New writes require the lease. The old signatures remain as explicit rejection
-- points so an older page cannot silently bypass the single-editor rule.
create function public.cloud_require_editor_session(p_session_id text) returns void
language plpgsql security definer set search_path = '' as $$
declare current_session public.autoschedule_editor_sessions%rowtype;
begin
  perform public.cloud_require_admin();
  if p_session_id is null then raise exception 'SESSION_REQUIRED'; end if;
  select * into current_session from public.autoschedule_editor_sessions
    where user_id = auth.uid() for update;
  if not found or current_session.session_id <> trim(p_session_id)
    or current_session.expires_at <= now() then
    raise exception 'SESSION_EXPIRED';
  end if;
end;
$$;

create function public.cloud_save_workspace_locked(
  p_expected_version bigint, p_model jsonb, p_session_id text
) returns bigint language plpgsql security definer set search_path = '' as $$
declare next_version bigint;
begin
  perform public.cloud_require_editor_session(p_session_id);
  if p_expected_version is null or p_expected_version < 0 or
    (jsonb_typeof(p_model) = 'object' and p_model->>'version' = '12'
     and p_model->>'activeGroupId' in ('A','B')
     and jsonb_typeof(p_model->'shared') = 'object'
     and jsonb_typeof(p_model->'groups'->'A') = 'object'
     and jsonb_typeof(p_model->'groups'->'B') = 'object'
     and jsonb_typeof(p_model->'groups'->'A'->'assignments') = 'array'
     and jsonb_typeof(p_model->'groups'->'B'->'assignments') = 'array') is distinct from true
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

create or replace function public.cloud_save_workspace(p_expected_version bigint, p_model jsonb)
returns bigint language plpgsql security definer set search_path = '' as $$
begin
  perform public.cloud_require_editor_session(null);
  return null;
end;
$$;

create function public.cloud_publish_schedule_locked(
  p_expected_version bigint, p_group_id text, p_session_id text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare workspace public.autoschedule_workspace%rowtype;
declare grp jsonb; rows jsonb; result jsonb; publish_token uuid; work_date date;
begin
  perform public.cloud_require_editor_session(p_session_id);
  select * into workspace from public.autoschedule_workspace where singleton for update;
  if workspace.version is null or p_expected_version is distinct from workspace.version then
    raise exception 'WORKSPACE_CONFLICT';
  end if;
  if p_group_id is null or p_group_id not in ('A', 'B') then raise exception 'INVALID_GROUP'; end if;
  grp := workspace.model->'groups'->p_group_id;
  if grp->>'activeScheduleDate' is null or grp->>'schedulePolicyStale' is distinct from 'false'
     or jsonb_array_length(grp->'assignments') = 0 then raise exception 'SCHEDULE_NOT_PUBLISHABLE'; end if;
  work_date := (grp->>'activeScheduleDate')::date;
  select jsonb_agg(jsonb_build_object(
    'flightNo', item->>'flightNo', 'position', item->>'position',
    'staffName', coalesce(item->>'staffName', ''), 'startTime', item->>'startTime',
    'endTime', item->>'endTime', 'remark', coalesce(item->>'remark', ''),
    'status', item->>'status') order by ordinal)
    into rows from jsonb_array_elements(grp->'assignments') with ordinality as x(item, ordinal);
  result := jsonb_build_object('schemaVersion', 1, 'groupId', p_group_id,
    'date', work_date::text, 'publishedAt', now(), 'rows', rows);
  insert into public.autoschedule_publications(group_id, schedule_date, snapshot)
    values (p_group_id, work_date, result)
    on conflict (group_id, schedule_date) do update set snapshot = excluded.snapshot
    returning token into publish_token;
  return jsonb_build_object('token', publish_token, 'snapshot', result);
end;
$$;

create or replace function public.cloud_publish_schedule(p_expected_version bigint, p_group_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform public.cloud_require_editor_session(null);
  return null;
end;
$$;

create function public.cloud_restore_workspace_version_locked(
  p_expected_version bigint, p_version_id bigint, p_session_id text
) returns bigint language plpgsql security definer set search_path = '' as $$
declare current_version bigint; archived jsonb;
begin
  perform public.cloud_require_editor_session(p_session_id);
  select version into current_version from public.autoschedule_workspace where singleton for update;
  if current_version is null or p_expected_version is distinct from current_version then raise exception 'WORKSPACE_CONFLICT'; end if;
  select content into archived from public.schedule_versions where id = p_version_id;
  if not found then raise exception 'VERSION_NOT_FOUND'; end if;
  return public.cloud_save_workspace_locked(p_expected_version, archived, p_session_id);
end;
$$;

create or replace function public.cloud_restore_workspace_version(p_expected_version bigint, p_version_id bigint)
returns bigint language plpgsql security definer set search_path = '' as $$
begin
  perform public.cloud_require_editor_session(null);
  return null;
end;
$$;

revoke all on function public.cloud_acquire_editor_session(text, boolean) from public, anon, authenticated;
revoke all on function public.cloud_touch_editor_session(text) from public, anon, authenticated;
revoke all on function public.cloud_release_editor_session(text) from public, anon, authenticated;
revoke all on function public.cloud_require_editor_session(text) from public, anon, authenticated;
revoke all on function public.cloud_save_workspace_locked(bigint, jsonb, text) from public, anon, authenticated;
revoke all on function public.cloud_publish_schedule_locked(bigint, text, text) from public, anon, authenticated;
revoke all on function public.cloud_restore_workspace_version_locked(bigint, bigint, text) from public, anon, authenticated;
grant execute on function public.cloud_acquire_editor_session(text, boolean) to authenticated;
grant execute on function public.cloud_touch_editor_session(text) to authenticated;
grant execute on function public.cloud_release_editor_session(text) to authenticated;
grant execute on function public.cloud_save_workspace_locked(bigint, jsonb, text) to authenticated;
grant execute on function public.cloud_publish_schedule_locked(bigint, text, text) to authenticated;
grant execute on function public.cloud_restore_workspace_version_locked(bigint, bigint, text) to authenticated;
commit;
