# Owlnet Verification scraper

Feeds the admin-only **Verification** tab in the scheduler. It scrapes the public
Owlnet course search for the online sections and writes them to the Supabase
table `public.owlnet_sections`. The scheduler reconciles those against its own
offerings — **Owlnet's section number is the source of truth**, and because a
canceled section drops off Owlnet entirely, a section that's canceled in the
scheduler but still live on Owlnet is flagged critical.

## One-time setup (on the Mac that runs the backups)

```bash
cd "WWU Course Scheduling"
npm install playwright
npx playwright install chromium
```

The Supabase service key is read from the **same file the backup job uses**:
`backups/.backup-env`, line `SB_SERVICE_KEY=<supabase-service-role-key>` (already
present if the nightly backup works). No GitHub secret or extra config needed.

## Run it

```bash
node owlnet-scrape.mjs                      # default terms: Spring 2027, Fall 2026
node owlnet-scrape.mjs "Spring 2027"        # one term
HEADFUL=1 node owlnet-scrape.mjs "Spring 2027"   # watch the browser (debugging)
```

Run it once by hand first to confirm the counts look right (it prints
`Spring 2027 / OU: N sections`, etc.). Then open the scheduler → **Verification**
and hit **Refresh**.

## Schedule it (nightly, after the 4 AM rotation sync)

```bash
cp com.wwuapps.owlnet-scrape.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.wwuapps.owlnet-scrape.plist
```

Logs land in `backups/owlnet-scrape.log`. Adjust the node path / repo path in the
plist if yours differ.

## How it works / tuning

Owlnet is a stateful ASP.NET (Jenzabar) site, so the script drives a headless
Chromium the way a person would: open Advanced Course Search, pick the term, pick
the division (**OU** = Online Undergraduate, **OG** = Online Graduate — OG already
includes masters *and* doctoral), Search, and page through with "Next page →".

Each run upserts the live sections for a term and then **prunes** any rows it
didn't see (so cancellations propagate). Only courses Owlnet actually returns are
reconciled in the panel, so a partial or failed run never produces false "missing"
flags.

If the first run scrapes 0 sections, Owlnet likely tweaked a control's markup —
the selectors to check are in `owlnet-scrape.mjs`: `termSelect`, `divisionSelect`,
`clickSearch`, and the "Next page" locator. Run with `HEADFUL=1` to watch where it
stalls.
