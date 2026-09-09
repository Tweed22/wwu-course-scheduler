-- ============================================================================
-- Keep profiles.role (what RLS checks) in sync with user_app_access.role
-- (what the app UI shows and what the Hub admin screen edits).
--
-- Background: current_sched_role() reads profiles.role, but every admin screen
-- writes user_app_access.role. Nothing connected the two, so a user added as a
-- registrar sat at profiles.role = 'pending' — which appears in none of the RLS
-- policy arrays — and silently got zero rows on every select plus 42501 on
-- every write, while the UI happily showed them the Registrar tab.
-- ============================================================================

-- 1 ─ Let the sync path through the escalation guard.
--     prevent_role_escalation() raises unless the CALLER is a scheduler admin.
--     The Hub admin screen is gated on hub-admin, not scheduler-admin, so
--     without this the sync below would break role editing for those admins.
--     The flag is transaction-local (set_config's third arg) and only ever set
--     by the sync function, so it can't be left on or reached from the client.
create or replace function public.prevent_role_escalation()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if current_setting('app.syncing_role', true) = 'on' then
    return new;   -- mirroring user_app_access, not a user-initiated change
  end if;
  if public.current_sched_role() <> 'admin' then
    if new.role   is distinct from old.role   then raise exception 'Only admins can change role';   end if;
    if new.school is distinct from old.school then raise exception 'Only admins can change school'; end if;
  end if;
  return new;
end;
$$;

-- 2 ─ Mirror scheduler role changes onto the profile.
create or replace function public.sync_scheduler_profile_role()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'auth'
as $$
declare
  v_uid uuid;
begin
  if new.app is distinct from 'scheduler' then return new; end if;

  -- Deliberate exclusion: this account's scheduler UI role is intentionally
  -- lower than its database role, so it must not be mirrored downward.
  if lower(new.email::text) = 'anthony.weed@gmail.com' then return new; end if;

  -- Ignore anything outside the user_role enum rather than letting a bad cast
  -- abort the caller's write to user_app_access.
  if new.role not in ('pending','program_manager','dean','registrar','admin') then
    return new;
  end if;

  select id into v_uid from auth.users where lower(email) = lower(new.email::text) limit 1;
  if v_uid is null then return new; end if;   -- not signed up yet; step 3 covers them

  perform set_config('app.syncing_role', 'on', true);
  update public.profiles
     set role = new.role::public.user_role
   where id = v_uid
     and role is distinct from new.role::public.user_role;
  perform set_config('app.syncing_role', 'off', true);

  return new;
end;
$$;

drop trigger if exists user_app_access_sync_role on public.user_app_access;
create trigger user_app_access_sync_role
after insert or update of role, email on public.user_app_access
for each row execute function public.sync_scheduler_profile_role();

-- 3 ─ New signups inherit their scheduler role instead of landing on 'pending'.
--     This is the half that fixes people granted access BEFORE they first log
--     in (Tara Emerson today): step 2 can't touch a profile that doesn't exist
--     yet, so the role has to be resolved at signup instead.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_role public.user_role;
begin
  select a.role::public.user_role
    into v_role
    from public.user_app_access a
   where lower(a.email::text) = lower(new.email)
     and a.app = 'scheduler'
     and a.role in ('pending','program_manager','dean','registrar','admin')
   limit 1;

  insert into public.profiles (id, email, role)
  values (
    new.id,
    new.email,
    case when lower(new.email) = 'anthony.weed@williamwoods.edu'
         then 'admin'::public.user_role
         else coalesce(v_role, 'pending'::public.user_role)
    end
  )
  on conflict (id) do nothing;

  return new;
end;
$$;
