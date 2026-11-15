-- Run AFTER creating one email/password user in Authentication > Users.
-- Replace only this placeholder email in your LOCAL copy / SQL Editor.
-- No secret or password belongs in this file.
do $$
declare target_id uuid;
begin
  select id into target_id from auth.users
    where lower(email) = lower('REPLACE_WITH_ADMIN_EMAIL');
  if target_id is null then raise exception 'Create the administrator Auth user first'; end if;
  insert into public.autoschedule_admin(singleton, user_id)
    values (true, target_id) on conflict (singleton) do nothing;
  if not exists (select 1 from public.autoschedule_admin where user_id = target_id) then
    raise exception 'A different administrator is already configured; no change was made';
  end if;
end;
$$;
