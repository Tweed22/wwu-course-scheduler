-- Applied 2026-11-09 as migration "offerings_guard_regressions".
-- Backstop against stale browser tabs. The scheduler client upserts WHOLE rows,
-- so a tab holding an old copy of a section can write it back over newer state.
-- This trigger silently keeps three one-way states unless the writer is allowed
-- to reverse them; every other field in the same write still goes through.
--   1) registrar completion  -> only registrar/admin can undo it
--   2) soft delete           -> only admin can undo it (Verification "Restore")
--   3) cancel                -> registrar/admin, or whoever filed the cancel request
-- Service-role writes (auth.uid() is null) are never touched.
create or replace function public.scheduler_guard_offering_regressions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  uid   uuid := auth.uid();
  r     public.user_role;
  keep  text[] := '{}';
  patch jsonb;
begin
  if uid is null then return NEW; end if;
  r := public.current_sched_role();

  if coalesce(OLD.registrar_completed, false) and not coalesce(NEW.registrar_completed, false)
     and coalesce(r::text, '') not in ('registrar', 'admin') then
    NEW.registrar_completed    := OLD.registrar_completed;
    NEW.registrar_completed_at := OLD.registrar_completed_at;
    NEW.data := coalesce(NEW.data, '{}'::jsonb) || jsonb_build_object('registrarCompleted', true);
    keep := keep || array['registrarCompletedAt', 'registrarCompletedBy'];
    raise log 'offerings guard: kept registrar completion on % (writer %)', OLD.id, uid;
  end if;

  if coalesce(OLD.data->>'deleted', '') = 'true' and coalesce(NEW.data->>'deleted', '') <> 'true'
     and coalesce(r::text, '') <> 'admin' then
    keep := keep || array['deleted', 'deletedAt', 'deletedBy'];
    raise log 'offerings guard: kept soft delete on % (writer %)', OLD.id, uid;
  end if;

  if coalesce(OLD.data->>'canceled', '') = 'true' and coalesce(NEW.data->>'canceled', '') <> 'true'
     and coalesce(r::text, '') not in ('registrar', 'admin')
     and not exists (
       select 1 from public.change_requests cr
        where cr.id::text = OLD.data->>'cancelRequestId' and cr.created_by = uid
     ) then
    keep := keep || array['canceled', 'canceledAt', 'canceledBy', 'cancelRequestId'];
    raise log 'offerings guard: kept cancel on % (writer %)', OLD.id, uid;
  end if;

  if coalesce(array_length(keep, 1), 0) > 0 and OLD.data is not null then
    select coalesce(jsonb_object_agg(k, OLD.data -> k), '{}'::jsonb)
      into patch
      from unnest(keep) as k
     where OLD.data ? k;
    NEW.data := coalesce(NEW.data, '{}'::jsonb) || patch;
  end if;
  return NEW;
end
$$;

drop trigger if exists trg_offerings_guard on public.offerings;
create trigger trg_offerings_guard
  before update on public.offerings
  for each row execute function public.scheduler_guard_offering_regressions();
