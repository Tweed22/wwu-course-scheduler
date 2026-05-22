-- =========================================================================
-- WWU Course Scheduling — Supabase Schema v1.0
-- =========================================================================
-- Paste this entire file into Supabase → SQL Editor → New Query, then click
-- Run.  It's idempotent: safe to re-run if you need to make adjustments.
--
-- Bootstrap admin: anthony.weed@williamwoods.edu (hard-coded below). When
-- that email first signs in, the handle_new_user() trigger auto-elevates
-- their profile to role='admin' so you don't need to bootstrap manually.
-- =========================================================================

-- -------------------------------------------------------------------------
-- 0. Extensions
-- -------------------------------------------------------------------------
create extension if not exists "uuid-ossp";

-- -------------------------------------------------------------------------
-- 1. Role enum
-- -------------------------------------------------------------------------
do $$ begin
  create type user_role as enum ('pending', 'program_manager', 'dean', 'registrar', 'admin');
exception when duplicate_object then null;
end $$;

-- -------------------------------------------------------------------------
-- 2. Helper: touch updated_at on row update
-- -------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- -------------------------------------------------------------------------
-- 3. profiles — extends auth.users with role and display info
-- -------------------------------------------------------------------------
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text unique not null,
  display_name text,
  role         user_role not null default 'pending',
  school       text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists profiles_role_idx on public.profiles(role);

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- Helper: current user's role.  SECURITY DEFINER so it bypasses RLS on
-- profiles when called from inside other RLS policies (no recursion).
create or replace function public.current_role()
returns user_role
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid()
$$;

-- Trigger on auth.users: create a profile row on signup.  Auto-elevate the
-- bootstrap admin email to role='admin'; everyone else starts as 'pending'.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, role)
  values (
    new.id,
    new.email,
    case when lower(new.email) = lower('anthony.weed@williamwoods.edu')
         then 'admin'::user_role
         else 'pending'::user_role
    end
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Trigger on profiles: prevent non-admins from changing role or school of
-- any row (including their own).  This is the *real* enforcement; the
-- update-self RLS policy below only controls which rows you can SEE for
-- update.  Combined: a user can update display_name on their own row, but
-- attempts to escalate role/school throw.
create or replace function public.prevent_role_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.current_role() <> 'admin' then
    if new.role is distinct from old.role then
      raise exception 'Only admins can change role';
    end if;
    if new.school is distinct from old.school then
      raise exception 'Only admins can change school';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_prevent_escalation on public.profiles;
create trigger profiles_prevent_escalation
  before update on public.profiles
  for each row execute function public.prevent_role_escalation();

-- -------------------------------------------------------------------------
-- 4. offerings — moved from localStorage state.offerings
-- -------------------------------------------------------------------------
create table if not exists public.offerings (
  id                     uuid primary key default uuid_generate_v4(),
  course_code            text not null,            -- e.g. "ACC 240"
  semester               text not null check (semester in ('Fall','Spring','Summer')),
  subterm                text not null check (subterm in ('1A','2B','3C')),
  year                   integer not null,
  length                 text,                     -- "5 Weeks" | "10 Weeks" | "15 Weeks" | "16 Weeks" | "As Needed"
  rotation_slot          text,                     -- "A" | "B" | "C" | "F" | "L" | "15W" | "16W" | "AN"
  dean                   text,                     -- derived from school but snapshotted
  program_manager        text,
  deadline               date,
  full_time_needed       text,                     -- retained for data continuity
  instructor             text,
  contract_returned      boolean default false,
  notes                  text,
  submitted              boolean not null default false,
  submitted_at           timestamptz,
  registrar_completed    boolean not null default false,
  registrar_completed_at timestamptz,
  created_by             uuid references auth.users(id),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index if not exists offerings_year_sem_sub_idx on public.offerings(year, semester, subterm);
create index if not exists offerings_course_idx        on public.offerings(course_code);

drop trigger if exists offerings_set_updated_at on public.offerings;
create trigger offerings_set_updated_at
  before update on public.offerings
  for each row execute function public.set_updated_at();

-- -------------------------------------------------------------------------
-- 5. change_requests — moved from localStorage state.requests
-- -------------------------------------------------------------------------
create table if not exists public.change_requests (
  id              uuid primary key default uuid_generate_v4(),
  submitter       text,
  submitted_date  date,
  grad_undergrad  text,
  modality        text,
  term            text,
  subterm         text,
  year            integer,
  prefix          text,
  course_number   text,
  type_of_change  text,
  explanation     text,
  rationale       text,
  status          text not null default 'Pending', -- Pending | Approved | Rejected | Sent to Registrar | Processed | Archived
  approved_by     text,
  approval_notes  text,
  sent_date       date,
  processed_date  date,
  registrar_notes text,
  created_by      uuid references auth.users(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists cr_status_idx on public.change_requests(status);

drop trigger if exists change_requests_set_updated_at on public.change_requests;
create trigger change_requests_set_updated_at
  before update on public.change_requests
  for each row execute function public.set_updated_at();

-- -------------------------------------------------------------------------
-- 6. audit_log — who did what, when
-- -------------------------------------------------------------------------
create table if not exists public.audit_log (
  id          uuid primary key default uuid_generate_v4(),
  actor_id    uuid references auth.users(id),
  actor_email text,
  action      text not null,            -- e.g. "offering.submit", "request.approve"
  table_name  text not null,
  row_id      uuid,
  before      jsonb,
  after       jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists audit_created_at_idx on public.audit_log(created_at desc);
create index if not exists audit_actor_idx      on public.audit_log(actor_id);

-- =========================================================================
-- 7. Row Level Security
-- =========================================================================
alter table public.profiles        enable row level security;
alter table public.offerings       enable row level security;
alter table public.change_requests enable row level security;
alter table public.audit_log       enable row level security;

-- -------- profiles --------
-- Any authenticated user can read all profile rows (needed for dropdowns,
-- displaying who submitted what, etc.)
drop policy if exists profiles_select on public.profiles;
create policy profiles_select
  on public.profiles for select
  using (auth.role() = 'authenticated');

-- Users can update their own row (the trigger above blocks role/school
-- changes from non-admins, so they can only realistically change
-- display_name).
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self
  on public.profiles for update
  using (auth.uid() = id);

-- Admins can update any profile.
drop policy if exists profiles_update_admin on public.profiles;
create policy profiles_update_admin
  on public.profiles for update
  using (public.current_role() = 'admin');

-- No client-side INSERT or DELETE on profiles — trigger creates rows on
-- signup; admin can soft-disable by setting role='pending' if needed.

-- -------- offerings --------
-- Anyone with a non-pending role can read.
drop policy if exists offerings_select on public.offerings;
create policy offerings_select
  on public.offerings for select
  using (public.current_role() in ('program_manager','dean','registrar','admin'));

-- PM/Dean/Registrar/Admin can insert new offerings.
drop policy if exists offerings_insert on public.offerings;
create policy offerings_insert
  on public.offerings for insert
  with check (public.current_role() in ('program_manager','dean','registrar','admin'));

-- Before submission: PM/Dean/Registrar/Admin can update.
drop policy if exists offerings_update_pre on public.offerings;
create policy offerings_update_pre
  on public.offerings for update
  using (
    submitted = false
    and public.current_role() in ('program_manager','dean','registrar','admin')
  );

-- After submission: Registrar/Admin only.  (Dean review for modality
-- happens via change_requests, not by editing the submitted offering.)
drop policy if exists offerings_update_post on public.offerings;
create policy offerings_update_post
  on public.offerings for update
  using (
    submitted = true
    and public.current_role() in ('registrar','admin')
  );

-- Delete: admin only.
drop policy if exists offerings_delete on public.offerings;
create policy offerings_delete
  on public.offerings for delete
  using (public.current_role() = 'admin');

-- -------- change_requests --------
-- Read: anyone non-pending.
drop policy if exists cr_select on public.change_requests;
create policy cr_select
  on public.change_requests for select
  using (public.current_role() in ('program_manager','dean','registrar','admin'));

-- Insert: PM/Dean/Registrar/Admin can submit requests.
drop policy if exists cr_insert on public.change_requests;
create policy cr_insert
  on public.change_requests for insert
  with check (public.current_role() in ('program_manager','dean','registrar','admin'));

-- Update: Dean/Registrar/Admin can update.  UI further restricts which
-- fields (Deans set approved_by/status; Registrar sets sent/processed).
drop policy if exists cr_update on public.change_requests;
create policy cr_update
  on public.change_requests for update
  using (public.current_role() in ('dean','registrar','admin'));

-- Delete: admin only.
drop policy if exists cr_delete on public.change_requests;
create policy cr_delete
  on public.change_requests for delete
  using (public.current_role() = 'admin');

-- -------- audit_log --------
-- Read: admin only.
drop policy if exists audit_select on public.audit_log;
create policy audit_select
  on public.audit_log for select
  using (public.current_role() = 'admin');

-- Insert: anyone authenticated (the app writes its own audit entries).
drop policy if exists audit_insert on public.audit_log;
create policy audit_insert
  on public.audit_log for insert
  with check (auth.role() = 'authenticated');

-- =========================================================================
-- 8. Realtime — push table changes to subscribed clients
-- =========================================================================
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'offerings'
  ) then
    alter publication supabase_realtime add table public.offerings;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'change_requests'
  ) then
    alter publication supabase_realtime add table public.change_requests;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'profiles'
  ) then
    alter publication supabase_realtime add table public.profiles;
  end if;
end $$;

-- =========================================================================
-- Done.  Next steps in the Supabase dashboard:
--   1. Authentication → Providers → Email: ensure "Enable email provider"
--      is ON and "Confirm email" is ON.  Magic links work out of the box.
--   2. Authentication → URL Configuration:
--        Site URL = https://tweed22.github.io/wwu-course-scheduler/
--        Add the same URL to Redirect URLs.
--   3. Settings → API: copy the Project URL and the anon key — send those
--      back so the next phase can wire them into index.html.
-- =========================================================================
