-- Additive migration; run after the existing workspace and operation-audit migrations.
begin;

-- Existing rows deliberately remain unattributed: installing the feature is not an upload.
alter table public.autoschedule_workspace
  add column uploader_id uuid,
  add column uploader_label text;

create table public.schedule_versions (
  id bigint generated always as identity primary key,
  workspace_version bigint not null unique check (workspace_version > 0),
  content jsonb not null check (jsonb_typeof(content) = 'object'),
  -- The archived content's original save time, not the later replacement time.
  created_at timestamptz not null,
  uploader_id uuid,
  uploader_label text
);
alter table public.schedule_versions enable row level security;
revoke all on public.schedule_versions from public, anon, authenticated;
revoke all on sequence public.schedule_versions_id_seq from public, anon, authenticated;

-- All writes (including old clients and restores) consume this single archive/retention policy.
-- UPDATE holds the workspace row lock; concurrent CAS writes cannot interleave this cleanup.
create function public.cloud_capture_workspace_version() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    insert into public.schedule_versions(workspace_version, content, created_at, uploader_id, uploader_label)
      values (old.version, old.model, old.updated_at, old.uploader_id, old.uploader_label);
    delete from public.schedule_versions
      where id in (select id from public.schedule_versions order by workspace_version desc offset 20);
  end if;
  new.uploader_id := auth.uid();
  select coalesce(nullif(email, ''), new.uploader_id::text) into new.uploader_label
    from auth.users where id = new.uploader_id;
  return new;
end;
$$;
revoke all on function public.cloud_capture_workspace_version() from public, anon, authenticated;
create trigger autoschedule_workspace_versions before insert or update on public.autoschedule_workspace
  for each row execute function public.cloud_capture_workspace_version();

create function public.cloud_list_workspace_versions() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  perform public.cloud_require_admin();
  select jsonb_agg(jsonb_build_object('id', id::text, 'version', workspace_version,
      'createdAt', created_at, 'actor', uploader_label) order by workspace_version desc)
    into result from (select * from public.schedule_versions order by workspace_version desc limit 20) v;
  return coalesce(result, '[]'::jsonb);
end;
$$;

-- Read just the selected content so the existing client restorer can reject damaged data
-- before any restore write. The client cannot modify or insert archive contents.
create function public.cloud_read_workspace_version(p_version_id bigint) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  perform public.cloud_require_admin();
  select content into result from public.schedule_versions where id = p_version_id;
  if not found then raise exception 'VERSION_NOT_FOUND'; end if;
  return result;
end;
$$;

create function public.cloud_restore_workspace_version(p_expected_version bigint, p_version_id bigint)
returns bigint language plpgsql security definer set search_path = '' as $$
declare current_version bigint; archived jsonb;
begin
  perform public.cloud_require_admin();
  -- Lock workspace before history, in the same order as normal saves/retention.
  select version into current_version from public.autoschedule_workspace where singleton for update;
  if current_version is null or p_expected_version is distinct from current_version then
    raise exception 'WORKSPACE_CONFLICT';
  end if;
  select content into archived from public.schedule_versions where id = p_version_id;
  if not found then raise exception 'VERSION_NOT_FOUND'; end if;
  -- Reuse all existing save validation, monotonic versioning and audit triggers.
  return public.cloud_save_workspace(p_expected_version, archived);
end;
$$;

revoke all on function public.cloud_list_workspace_versions() from public, anon, authenticated;
revoke all on function public.cloud_read_workspace_version(bigint) from public, anon, authenticated;
revoke all on function public.cloud_restore_workspace_version(bigint, bigint) from public, anon, authenticated;
grant execute on function public.cloud_list_workspace_versions() to authenticated;
grant execute on function public.cloud_read_workspace_version(bigint) to authenticated;
grant execute on function public.cloud_restore_workspace_version(bigint, bigint) to authenticated;
commit;
