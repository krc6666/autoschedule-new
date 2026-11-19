-- Apply after 202611170002_single_editor_session.sql. No workspace data changes.
-- Requests notify; only the holder's transaction can transfer a live lease.
begin;

create table public.autoschedule_editor_requests (
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id text not null check (char_length(request_id) between 16 and 200),
  requester_session_id text not null,
  holder_session_id text not null,
  status text not null check (status in ('pending','approved','rejected','expired','cancelled')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key(user_id, request_id)
);
create unique index autoschedule_one_pending_request
  on public.autoschedule_editor_requests(user_id) where status = 'pending';
alter table public.autoschedule_editor_requests enable row level security;
revoke all on public.autoschedule_editor_requests from public, anon, authenticated;

create function public.cloud_lock_editor_account(p_session_id text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.cloud_require_admin();
  if p_session_id is null or char_length(trim(p_session_id)) not between 16 and 200 then
    raise exception 'SESSION_INVALID';
  end if;
  -- Lock an existing account row, including when no lease has been inserted yet.
  perform 1 from public.autoschedule_admin where user_id = auth.uid() for update;
end;
$$;
revoke all on function public.cloud_lock_editor_account(text) from public, anon, authenticated;

create function public.cloud_editor_request_json(r public.autoschedule_editor_requests)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object('id', r.request_id, 'status', r.status, 'expiresAt', r.expires_at);
$$;
revoke all on function public.cloud_editor_request_json(public.autoschedule_editor_requests) from public, anon, authenticated;

create or replace function public.cloud_acquire_editor_session(
  p_session_id text, p_takeover boolean default false
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare current_session public.autoschedule_editor_sessions%rowtype;
declare next_expiry timestamptz;
begin
  perform public.cloud_lock_editor_account(p_session_id);
  select * into current_session from public.autoschedule_editor_sessions
    where user_id = auth.uid() for update;
  -- p_takeover is deliberately powerless: older clients cannot bypass approval.
  if found and current_session.session_id <> trim(p_session_id)
    and current_session.expires_at > now() then
    raise exception 'SESSION_ACTIVE';
  end if;
  update public.autoschedule_editor_requests set status = 'expired'
    where user_id = auth.uid() and status = 'pending'
      and (expires_at <= now() or current_session.expires_at <= now()
        or holder_session_id <> trim(p_session_id));
  next_expiry := now() + interval '90 seconds';
  insert into public.autoschedule_editor_sessions(user_id, session_id, last_seen_at, expires_at)
    values(auth.uid(), trim(p_session_id), now(), next_expiry)
    on conflict(user_id) do update set session_id = excluded.session_id,
      last_seen_at = excluded.last_seen_at, expires_at = excluded.expires_at;
  return jsonb_build_object('expiresAt', next_expiry);
end;
$$;

create function public.cloud_request_editor_session(p_session_id text, p_request_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare lease public.autoschedule_editor_sessions%rowtype;
declare r public.autoschedule_editor_requests%rowtype;
begin
  perform public.cloud_lock_editor_account(p_session_id);
  if p_request_id is null or char_length(p_request_id) not between 16 and 200 then
    raise exception 'SESSION_REQUEST_INVALID';
  end if;
  select * into r from public.autoschedule_editor_requests
    where user_id = auth.uid() and request_id = p_request_id;
  if found then
    if r.requester_session_id <> trim(p_session_id) then raise exception 'SESSION_REQUEST_INVALID'; end if;
    return public.cloud_poll_editor_request(p_session_id, p_request_id);
  end if;
  select * into lease from public.autoschedule_editor_sessions where user_id = auth.uid() for update;
  if not found or lease.expires_at <= now() or lease.session_id = trim(p_session_id) then
    raise exception 'SESSION_REQUEST_CLOSED';
  end if;
  delete from public.autoschedule_editor_requests
    where user_id = auth.uid() and expires_at < now() - interval '1 day';
  update public.autoschedule_editor_requests set status = 'expired'
    where user_id = auth.uid() and status = 'pending'
      and (expires_at <= now() or holder_session_id <> lease.session_id);
  if exists(select 1 from public.autoschedule_editor_requests where user_id = auth.uid() and status = 'pending') then
    raise exception 'SESSION_REQUEST_BUSY';
  end if;
  insert into public.autoschedule_editor_requests
    (user_id, request_id, requester_session_id, holder_session_id, status, expires_at)
    values(auth.uid(), p_request_id, trim(p_session_id), lease.session_id, 'pending', now() + interval '60 seconds')
    returning * into r;
  return public.cloud_editor_request_json(r);
end;
$$;

create function public.cloud_poll_editor_request(p_session_id text, p_request_id text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare lease public.autoschedule_editor_sessions%rowtype;
declare r public.autoschedule_editor_requests%rowtype;
begin
  perform public.cloud_lock_editor_account(p_session_id);
  select * into lease from public.autoschedule_editor_sessions where user_id = auth.uid();
  if p_request_id is null then
    perform public.cloud_require_editor_session(p_session_id);
    select * into r from public.autoschedule_editor_requests
      where user_id = auth.uid() and holder_session_id = trim(p_session_id) and status = 'pending';
  else
    select * into r from public.autoschedule_editor_requests
      where user_id = auth.uid() and request_id = p_request_id
        and requester_session_id = trim(p_session_id);
    if not found then raise exception 'SESSION_REQUEST_INVALID'; end if;
  end if;
  if r.request_id is null then return null; end if;
  if r.status = 'pending' and (r.expires_at <= now() or lease.session_id is null
      or lease.session_id <> r.holder_session_id or lease.expires_at <= now()) then
    update public.autoschedule_editor_requests set status = 'expired'
      where user_id = auth.uid() and request_id = r.request_id returning * into r;
  end if;
  return public.cloud_editor_request_json(r);
end;
$$;

create function public.cloud_decide_editor_request(p_session_id text, p_request_id text, p_allow boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare r public.autoschedule_editor_requests%rowtype;
begin
  perform public.cloud_lock_editor_account(p_session_id);
  perform public.cloud_require_editor_session(p_session_id);
  select * into r from public.autoschedule_editor_requests
    where user_id = auth.uid() and request_id = p_request_id for update;
  if not found or r.holder_session_id <> trim(p_session_id) or r.status <> 'pending'
    or r.expires_at <= now() or p_allow is null then raise exception 'SESSION_REQUEST_CLOSED'; end if;
  if p_allow then
    update public.autoschedule_editor_sessions set session_id = r.requester_session_id,
      last_seen_at = now(), expires_at = now() + interval '90 seconds' where user_id = auth.uid();
  end if;
  update public.autoschedule_editor_requests set status = case when p_allow then 'approved' else 'rejected' end
    where user_id = auth.uid() and request_id = p_request_id;
end;
$$;

create function public.cloud_cancel_editor_request(p_session_id text, p_request_id text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.cloud_lock_editor_account(p_session_id);
  update public.autoschedule_editor_requests set status = 'cancelled'
    where user_id = auth.uid() and request_id = p_request_id
      and requester_session_id = trim(p_session_id) and status = 'pending';
end;
$$;

revoke all on function public.cloud_request_editor_session(text,text) from public, anon, authenticated;
revoke all on function public.cloud_poll_editor_request(text,text) from public, anon, authenticated;
revoke all on function public.cloud_decide_editor_request(text,text,boolean) from public, anon, authenticated;
revoke all on function public.cloud_cancel_editor_request(text,text) from public, anon, authenticated;
grant execute on function public.cloud_request_editor_session(text,text) to authenticated;
grant execute on function public.cloud_poll_editor_request(text,text) to authenticated;
grant execute on function public.cloud_decide_editor_request(text,text,boolean) to authenticated;
grant execute on function public.cloud_cancel_editor_request(text,text) to authenticated;
notify pgrst, 'reload schema';
commit;
