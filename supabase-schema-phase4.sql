-- =========================================================================
-- WWU Course Scheduling — Phase 4 Migration
-- =========================================================================
-- Adds:
--   • course_program_managers — maps a course code (e.g. "ACC 240") to the
--     program manager responsible for it. Populated via the new Admin page
--     (CSV upload). The Program Manager column on the Term Assignments page
--     becomes read-only and is auto-filled from this table.
--   • term_date_overrides — per-(semester, subterm, year) override of the
--     start/end dates that ship in the client. The Admin page shows the
--     calculated dates and lets an admin override them.
--
-- Also makes sure the `data jsonb` columns from phase 3 are present (so this
-- migration is safe to run by itself if phase 3 never landed cleanly).
--
-- Safe to re-run: every statement uses IF NOT EXISTS / DROP-then-CREATE.
-- =========================================================================

-- -------------------------------------------------------------------------
-- 0. Phase 3 belt-and-suspenders
-- -------------------------------------------------------------------------
alter table public.offerings        add column if not exists data jsonb;
alter table public.change_requests  add column if not exists data jsonb;

-- -------------------------------------------------------------------------
-- 1. course_program_managers
-- -------------------------------------------------------------------------
create table if not exists public.course_program_managers (
  course_code     text primary key,
  program_manager text not null,
  updated_at      timestamptz not null default now(),
  updated_by      uuid references auth.users(id)
);

drop trigger if exists cpm_set_updated_at on public.course_program_managers;
create trigger cpm_set_updated_at
  before update on public.course_program_managers
  for each row execute function public.set_updated_at();

alter table public.course_program_managers enable row level security;

-- Read: anyone authenticated with a role (we want PMs to see their own mapping).
drop policy if exists cpm_select on public.course_program_managers;
create policy cpm_select
  on public.course_program_managers for select
  using (public.current_role() in ('program_manager','dean','registrar','admin'));

-- Insert/Update/Delete: admin only.
drop policy if exists cpm_insert on public.course_program_managers;
create policy cpm_insert
  on public.course_program_managers for insert
  with check (public.current_role() = 'admin');

drop policy if exists cpm_update on public.course_program_managers;
create policy cpm_update
  on public.course_program_managers for update
  using (public.current_role() = 'admin');

drop policy if exists cpm_delete on public.course_program_managers;
create policy cpm_delete
  on public.course_program_managers for delete
  using (public.current_role() = 'admin');

-- -------------------------------------------------------------------------
-- 2. term_date_overrides
-- -------------------------------------------------------------------------
create table if not exists public.term_date_overrides (
  term_key   text primary key,        -- e.g. "Fall|1A|2026"
  start_date date,
  end_date   date,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

drop trigger if exists tdo_set_updated_at on public.term_date_overrides;
create trigger tdo_set_updated_at
  before update on public.term_date_overrides
  for each row execute function public.set_updated_at();

alter table public.term_date_overrides enable row level security;

drop policy if exists tdo_select on public.term_date_overrides;
create policy tdo_select
  on public.term_date_overrides for select
  using (public.current_role() in ('program_manager','dean','registrar','admin'));

drop policy if exists tdo_insert on public.term_date_overrides;
create policy tdo_insert
  on public.term_date_overrides for insert
  with check (public.current_role() = 'admin');

drop policy if exists tdo_update on public.term_date_overrides;
create policy tdo_update
  on public.term_date_overrides for update
  using (public.current_role() = 'admin');

drop policy if exists tdo_delete on public.term_date_overrides;
create policy tdo_delete
  on public.term_date_overrides for delete
  using (public.current_role() = 'admin');

-- -------------------------------------------------------------------------
-- 3. Add new tables to the realtime publication so admin edits propagate
-- -------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'course_program_managers'
  ) then
    alter publication supabase_realtime add table public.course_program_managers;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'term_date_overrides'
  ) then
    alter publication supabase_realtime add table public.term_date_overrides;
  end if;
end $$;

-- Done.
