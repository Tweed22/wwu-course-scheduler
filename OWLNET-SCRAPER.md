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

- Function source: `supabase/functions/owlnet-scrape/index.ts` (deployed to the
  Supabase project — redeploy with `supabase functions deploy owlnet-scrape`).
- No secrets to manage: it uses the project's built-in service role internally.
- Owlnet reachability from Supabase egress is confirmed.

### Scheduled (optional)

To refresh nightly without a click, call the function on a schedule with pg_cron
+ pg_net (POST to `/functions/v1/owlnet-scrape` with a service-role bearer), or
just click the button when you want fresh data.

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
