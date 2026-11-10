-- Applied 2026-11-10 as migration "owlnet_patch_offerings_rpc".
-- Server-side counterpart of the Verification panel's post-pass: the
-- owlnet-scrape Edge Function (apply.ts) calls this after each scraped term to
-- refresh the Owlnet fields on offerings (LIVE verification + enrollment). It
-- MERGES each patch into the row's data blob in one statement (data = data ||
-- patch), so it never overwrites a concurrent user edit to other fields.
-- Service role only.
create or replace function public.owlnet_patch_offerings(p jsonb)
returns integer
language sql
security definer
set search_path = public
as $$
  with x as (
    select (e->>'id')::uuid as id, e->'patch' as patch
      from jsonb_array_elements(coalesce(p, '[]'::jsonb)) as e
     where jsonb_typeof(e->'patch') = 'object'
  ), u as (
    update public.offerings o
       set data = coalesce(o.data, '{}'::jsonb) || x.patch
      from x
     where o.id = x.id
    returning 1
  )
  select count(*)::int from u;
$$;
revoke all on function public.owlnet_patch_offerings(jsonb) from public, anon, authenticated;
grant execute on function public.owlnet_patch_offerings(jsonb) to service_role;

-- The schedule itself (set up 2026-11-10 by the Degree Planner session):
--   pg_cron job 'owlnet-scrape-scheduled', '0,30 * * * *', fires only when
--   to_char(now() at time zone 'America/Chicago','HH24:MI') in ('07:30','12:00','17:00');
--   POSTs to /functions/v1/owlnet-scrape with x-cron-secret from Vault secret
--   'owlnet_cron_secret' (checked by public.owlnet_cron_ok(text)).
