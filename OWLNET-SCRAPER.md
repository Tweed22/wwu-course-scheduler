# Owlnet Verification scraper

Feeds the admin-only **Verification** tab. It scrapes the public Owlnet course
search for the online sections (divisions **OU** = Online Undergraduate and
**OG** = Online Graduate, which covers masters + doctoral) and writes them to the
Supabase table `public.owlnet_sections`. The scheduler reconciles those against
its own offerings — **Owlnet's section number is the source of truth**, and a
section that's canceled in the scheduler but still live on Owlnet is flagged
critical.

## Primary: the in-app "Scrape Owlnet" button (no setup)

In the scheduler, **Verification** tab → **Scrape Owlnet**. It calls the Supabase
Edge Function `owlnet-scrape`, which does the whole scrape server-side (an HTTP
replay of the Jenzabar/ASP.NET form — no browser): GET the advanced form (cookies
+ `__VIEWSTATE`), POST the search per division, page through via the `ltrNav`
postback, parse rows, upsert to `owlnet_sections`, and prune stale rows so
cancellations propagate. Admin-only (verifies the caller's `profiles.role`).
Scrapes the selected term; the empty-state button scrapes the defaults.

- Function source: `supabase/functions/owlnet-scrape/index.ts` + `apply.ts`
  (deployed to the Supabase project with **verify_jwt off** — the function
  authenticates both callers itself; redeploy with
  `supabase functions deploy owlnet-scrape --no-verify-jwt`).
- It uses the project's built-in service role internally.
- Owlnet reachability from Supabase egress is confirmed.

### Scheduled runs (hourly, 6:00 AM – 6:00 PM Central)

- pg_cron job **`owlnet-scrape-scheduled`** runs at the top of every hour
  (`0 * * * *`) but only fires when the Chicago-local hour is 6 through 18
  (6 AM – 6 PM, 13 runs a day), so DST is handled. (Was 7:30 / noon / 5 PM until 2026-11-13.) It POSTs to the function with header `x-cron-secret` (Vault secret
  `owlnet_cron_secret`, checked by `public.owlnet_cron_ok()`, service-role only).
- With no body it scrapes every term in Owlnet's dropdown that hasn't ended and
  starts within ~9 months; one failing term (e.g. Fall 2026's HTTP 500) doesn't
  stop the others. Results: `select * from net._http_response order by id desc`.
- After each term, `apply.ts` refreshes the Owlnet fields Term Assignments shows
  (LIVE instructor check + enrollment) on sections that carry Owlnet's official
  section number, via `public.owlnet_patch_offerings` (server-side jsonb merge, so
  no user edit is overwritten). New/renumbered/ambiguous sections and all the
  flagging still come from the Verification panel.
- Pause: `select cron.alter_job(job_id := (select jobid from cron.job where jobname = 'owlnet-scrape-scheduled'), active := false);`

## Fallback: local Playwright scraper

`owlnet-scrape.mjs` + `com.wwuapps.owlnet-scrape.plist` still work if you ever
want a local/launchd scrape (needs `npm install playwright && npx playwright
install chromium` and the `SB_SERVICE_KEY` in `backups/.backup-env`). The Edge
Function is the primary path now and needs none of that.

## Notes

- Only two divisions cover every online course (OG includes masters + doctoral).
- `ALE 799` (voucher-arranged dissertation continuation) is skipped.
- Owlnet lists only LIVE sections, so "canceled" is detected by absence.
- A retired `owlnet-ping` probe function is inert (returns 410) — safe to delete
  from the Supabase dashboard.
