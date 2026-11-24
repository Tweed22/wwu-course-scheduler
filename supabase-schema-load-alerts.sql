-- Faculty load warnings (2026-11-21).
-- 1) sched_load_inputs(): what the scheduler needs to compute faculty loads,
--    readable by every scheduler role, with NOTHING about pay or contracts
--    (the contracting tables themselves stay contracting-app / hub-admin only).
-- 2) load_alerts: one row each time a PM/dean/admin chose "Submit anyway" on an
--    over-the-limit assignment. Admins review them in Verification → Faculty
--    loads; the hourly load-alerts edge function flips status to 'made_over'
--    when enough sections MAKE that the overload is real (shown in the hub).

create or replace function public.sched_load_inputs()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if coalesce(public.current_sched_role()::text, '') not in ('program_manager', 'dean', 'registrar', 'admin') then
    raise exception 'Scheduler users only';
  end if;
  return jsonb_build_object(
    'faculty', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', f.id, 'first_name', f.first_name, 'last_name', f.last_name,
        'faculty_type', f.faculty_type, 'contracted_load', f.contracted_load))
      from public.ogc_faculty f where f.is_active is not false), '[]'::jsonb),
    'settings', coalesce((
      select jsonb_object_agg(s.key, s.value) from public.ogc_settings s
      where s.key in ('full_enrollment_threshold', 'full_time_load_credits', 'always_made_prefixes',
        'voucher_prefixes', 'voucher_courses', 'internship_courses', 'internship_title_match',
        'connections_courses', 'connections_title_match', 'fixed_faculty_hours',
        'credit_hour_subjects', 'ignored_delivery_codes', 'online_codes')), '{}'::jsonb),
    'ogc', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id, 'term_code', c.term_code, 'course_code', c.course_code, 'section', c.section,
        'title', c.title, 'credit_hours', c.credit_hours, 'course_type', c.course_type,
        'enrollment', c.enrollment, 'faculty_id', c.faculty_id, 'faculty_hours', c.faculty_hours,
        'pct_toward_load', c.pct_toward_load, 'delivery', c.delivery,
        'status_override', c.status_override, 'faculty_hours_override', c.faculty_hours_override,
        'load_hours_override', c.load_hours_override, 'start_date', c.start_date))
      from public.ogc_courses c), '[]'::jsonb),
    'onc', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', o.id, 'term_code', o.term_code, 'course_code', o.course_code, 'section', o.section,
        'delivery', o.delivery, 'title', o.title, 'credit_hours', o.credit_hours,
        'enrollment', o.enrollment, 'faculty_id', o.faculty_id, 'subterm', o.subterm,
        'start_date', o.start_date))
      from public.onc_sections o where o.excluded is not true), '[]'::jsonb),
    'owlnet', coalesce((
      select jsonb_agg(jsonb_build_object(
        'semester', w.semester, 'acad_year', w.acad_year, 'prefix', w.prefix,
        'course_number', w.course_number, 'section', w.section, 'division', w.division,
        'suffix', w.suffix, 'credits', w.credits))
      from public.owlnet_sections w), '[]'::jsonb)
  );
end;
$$;
revoke all on function public.sched_load_inputs() from public, anon;
grant execute on function public.sched_load_inputs() to authenticated;

create table if not exists public.load_alerts (
  id               uuid primary key default gen_random_uuid(),
  created_at       timestamptz not null default now(),
  semester         text not null,
  year             int  not null,
  instructor       text not null,
  faculty_id       uuid,
  limit_kind       text not null check (limit_kind in ('adjunct', 'full_time', 'full_time_summer')),
  unit             text not null default 'hours' check (unit in ('hours', 'sections')),
  over_by          numeric not null,          -- projected (every section counted) at submit time
  course_code      text,
  section          text,
  offering_id      uuid,
  request_id       uuid,
  action           text,                      -- submit | add_section | request | approve
  submitted_by     text,
  submitted_by_uid uuid default auth.uid(),
  made_sections    jsonb not null default '[]'::jsonb,  -- sections made at the last check
  status           text not null default 'projected' check (status in ('projected', 'made_over', 'back_under')),
  made_over_by     numeric,                   -- made-sections load minus the limit, last check
  made_over_at     timestamptz,
  crossed_sections jsonb,
  last_checked_at  timestamptz,
  checked_at       timestamptz,
  checked_by       text
);
create index if not exists load_alerts_open_idx on public.load_alerts (checked_at, semester, year);

alter table public.load_alerts enable row level security;

drop policy if exists load_alerts_insert on public.load_alerts;
create policy load_alerts_insert on public.load_alerts for insert to authenticated
  with check (coalesce(public.current_sched_role()::text, '') in ('program_manager', 'dean', 'registrar', 'admin')
              and submitted_by_uid = auth.uid());

drop policy if exists load_alerts_select_admin on public.load_alerts;
create policy load_alerts_select_admin on public.load_alerts for select to authenticated
  using (public.current_sched_role()::text = 'admin');

drop policy if exists load_alerts_update_admin on public.load_alerts;
create policy load_alerts_update_admin on public.load_alerts for update to authenticated
  using (public.current_sched_role()::text = 'admin')
  with check (public.current_sched_role()::text = 'admin');
