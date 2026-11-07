// Owlnet course-search scraper → Supabase public.owlnet_sections.
// Feeds the admin-only "Verification" panel in the scheduler, which reconciles
// these official sections against the scheduler's offerings (Owlnet's section
// number is the source of truth; a canceled section drops off Owlnet entirely).
//
// Owlnet (Jenzabar ICS) is a stateful ASP.NET WebForms app, so we drive it with
// a headless browser (Playwright) exactly as a person would: open the advanced
// search, pick Term + Division, Search, page through results.
//
// SETUP (one time, in this repo dir):
//   npm install playwright
//   npx playwright install chromium
//   # service key lives in the SAME file the backup script uses:
//   #   backups/.backup-env   with   SB_SERVICE_KEY=<supabase-service-role-key>
//
// RUN (manually, to verify, or from launchd — see com.wwuapps.owlnet-scrape.plist):
//   node owlnet-scrape.mjs                 # default terms
//   node owlnet-scrape.mjs "Spring 2027" "Fall 2026"
//   HEADFUL=1 node owlnet-scrape.mjs "Spring 2027"   # watch the browser (debug)

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __dir = dirname(fileURLToPath(import.meta.url));

// --- config -----------------------------------------------------------------
const SB_URL = 'https://xyissgatpbldeedhomol.supabase.co';
const OWLNET_URL = 'https://owlnet.williamwoods.edu/ICS/Course_Search.jnz';
// Only two divisions cover every online course (OG includes masters + doctoral).
const DIVISIONS = [
  { value: 'OU', label: '(Course) Online Undergraduate' },
  { value: 'OG', label: '(Course) Online Graduate' },
];
const DEFAULT_TERMS = ['Spring 2027', 'Fall 2026'];
// Courses handled outside the scheduler (voucher-arranged) — never stored.
const HIDDEN_COURSES = new Set(['ALE 799', 'DIS 781', 'DIS 790', 'DIS 791']);
const TERMS = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_TERMS;
const HEADFUL = !!process.env.HEADFUL;

// --- service key (same env file as backup-schedule.mjs) ----------------------
const envPath = join(__dir, 'backups', '.backup-env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const [k, ...v] = line.split('=');
    if (k && v.length) process.env[k.trim()] = v.join('=').trim();
  }
}
const SB_KEY = process.env.SB_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_KEY) {
  console.error('Missing SB_SERVICE_KEY (set it in backups/.backup-env or the env).');
  process.exit(1);
}

// --- helpers -----------------------------------------------------------------
function termToSemesterYear(label) {
  // "Spring 2027" -> { semester: "Spring", acad_year: 2027 }
  const m = String(label).match(/^(Fall|Spring|Summer)\s+(\d{4})$/i);
  if (!m) return { semester: null, acad_year: null };
  const semester = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  return { semester, acad_year: Number(m[2]) };
}
function isoDate(d) {
  const m = String(d || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}
function intOrNull(s) {
  const n = parseInt(String(s).replace(/[^0-9]/g, ''), 10);
  return isNaN(n) ? null : n;
}
function numOrNull(s) {
  const n = parseFloat(String(s).replace(/[^0-9.]/g, ''));
  return isNaN(n) ? null : n;
}

// Extract every result row on the current page (same shape the panel expects).
async function extractRows(page) {
  return page.$$eval("a[href*='lnkCourse']", (links) =>
    links.map((a) => {
      const tr = a.closest('tr');
      if (!tr) return null;
      const tds = Array.from(tr.children).map((td) => td.textContent.replace(/\s+/g, ' ').trim());
      const code = a.textContent.replace(/\s+/g, ' ').trim();
      let ci = tds.findIndex((t) => t === code);
      if (ci < 0) ci = 2;
      return {
        raw_code: code,
        name: tds[ci + 1] || '',
        faculty: tds[ci + 2] || '',
        seats: tds[ci + 3] || '',
        status: tds[ci + 4] || '',
        credits: tds[ci + 6] || '',
        begin: tds[ci + 7] || '',
        end: tds[ci + 8] || '',
      };
    }).filter(Boolean)
  );
}

async function openAdvancedForm(page) {
  await page.goto(OWLNET_URL, { waitUntil: 'domcontentloaded' });
  // The Advanced form must be opened via the content "Course Search" link — a
  // direct URL can render a form whose Division/Search controls aren't wired,
  // which makes the search fall back to the default (grad) division. Click each
  // "Course Search" link until the Division dropdown (with an OU option) appears.
  const ready = () => page.locator('select option[value="OU"]').count().then(n => n > 0).catch(() => false);
  if (await ready()) return;
  const links = page.getByRole('link', { name: /Course Search/i });
  const n = await links.count();
  for (let i = 0; i < n; i++) {
    await links.nth(i).click({ timeout: 5000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    if (await ready()) return;
  }
  // Last resort: the direct advanced-screen URL.
  await page.goto(OWLNET_URL + '?portlet=Course_Schedules&screen=Advanced+Course+Search&screenType=next',
    { waitUntil: 'domcontentloaded' }).catch(() => {});
}

function termSelect(page, termLabel) {
  // The <select> that has an <option> exactly equal to the plain term label.
  return page.locator('select', { has: page.locator(`option:text-is(${JSON.stringify(termLabel)})`) }).first();
}
function divisionSelect(page) {
  return page.locator('select', { has: page.locator('option[value="OU"]') }).first();
}
async function clickSearch(page) {
  // The form's Search submit — NOT the site-nav search box (id ~ searchBox/siteNav).
  const inp = page.locator('input[type="submit"][value~="Search" i], input[type="submit"][value="Search" i]');
  if (await inp.count()) { await inp.last().click(); return; }
  const btns = page.getByRole('button', { name: /^\s*Search\s*$/ });
  const n = await btns.count();
  for (let i = n - 1; i >= 0; i--) {
    const id = (await btns.nth(i).getAttribute('id')) || '';
    if (/searchBox|siteNav/i.test(id)) continue;
    await btns.nth(i).click();
    return;
  }
  if (n) await btns.last().click();
}

async function scrapeTermDivision(page, termLabel, division) {
  await openAdvancedForm(page);
  // Set the term (may trigger an ASP.NET postback), then the division — re-query
  // each fresh and VERIFY the division took, because a silent miss makes the
  // search run with the default (grad) division.
  await termSelect(page, termLabel).selectOption({ label: termLabel }).catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {});
  const div = divisionSelect(page);
  await div.selectOption({ value: division.value }).catch(() => {});
  let got = await div.inputValue().catch(() => '');
  if (got !== division.value) {
    await div.selectOption({ value: division.value }).catch(() => {});
    got = await div.inputValue().catch(() => '');
  }
  console.log(`    division select = "${got}" (wanted ${division.value})`);
  await clickSearch(page);
  await page.waitForLoadState('networkidle').catch(() => {});

  const rows = [];
  const seen = new Set();
  for (let guard = 0; guard < 60; guard++) {
    const pageRows = await extractRows(page);
    if (guard === 0) console.log(`    first result: ${pageRows[0] ? pageRows[0].raw_code : '(none)'} (${pageRows.length} on page 1)`);
    for (const r of pageRows) {
      const key = r.raw_code + '|' + r.begin;
      if (!seen.has(key)) { seen.add(key); rows.push(r); }
    }
    const next = page.getByRole('link', { name: /Next page/ });
    if (!(await next.count()) || !(await next.first().isVisible().catch(() => false))) break;
    await next.first().click();
    await page.waitForLoadState('networkidle').catch(() => {});
  }
  return rows;
}

function toRecord(r, termLabel, division, runId) {
  const parts = r.raw_code.split(/\s+/); // [PREFIX, NUMBER, SECTION, SUFFIX...]
  const { semester, acad_year } = termToSemesterYear(termLabel);
  const seats = String(r.seats).split('/');
  return {
    term_label: termLabel,
    semester,
    acad_year,
    division: division.value,
    prefix: parts[0] || '',
    course_number: parts[1] || '',
    section: parts[2] || '',
    suffix: parts.slice(3).join(' ') || '',
    raw_code: r.raw_code,
    title: r.name || null,
    instructor: r.faculty || null,
    seats_open: intOrNull(seats[0]),
    seats_cap: intOrNull(seats[1]),
    status: r.status || null,
    begin_date: isoDate(r.begin),
    end_date: isoDate(r.end),
    credits: numOrNull(r.credits),
    source_run: runId,
  };
}

async function sbUpsert(records) {
  if (!records.length) return;
  const url = `${SB_URL}/rest/v1/owlnet_sections?on_conflict=term_label,prefix,course_number,section,suffix`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(records),
  });
  if (!res.ok) throw new Error(`upsert ${res.status}: ${await res.text()}`);
}

// Delete rows for this term that this run did NOT refresh — i.e. sections that
// are no longer live on Owlnet (canceled/removed), plus any older seed rows.
async function sbPruneStale(termLabel, runId) {
  const q = `term_label=eq.${encodeURIComponent(termLabel)}&or=(source_run.neq.${runId},source_run.is.null)`;
  const res = await fetch(`${SB_URL}/rest/v1/owlnet_sections?${q}`, {
    method: 'DELETE',
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, Prefer: 'return=minimal' },
  });
  if (!res.ok) throw new Error(`prune ${res.status}: ${await res.text()}`);
}

// --- main --------------------------------------------------------------------
(async () => {
  const runId = new Date().toISOString();
  const browser = await chromium.launch({ headless: !HEADFUL });
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  let total = 0;
  try {
    for (const termLabel of TERMS) {
      const { semester } = termToSemesterYear(termLabel);
      if (!semester) { console.warn(`Skipping unrecognized term "${termLabel}"`); continue; }
      const records = [];
      for (const division of DIVISIONS) {
        const rows = await scrapeTermDivision(page, termLabel, division);
        console.log(`  ${termLabel} / ${division.value}: ${rows.length} sections`);
        for (const r of rows) {
          const rec = toRecord(r, termLabel, division, runId);
          if (HIDDEN_COURSES.has(`${rec.prefix} ${rec.course_number}`.trim())) continue;
          records.push(rec);
        }
      }
      // Upsert in chunks, then prune anything this run didn't touch for the term.
      for (let i = 0; i < records.length; i += 500) await sbUpsert(records.slice(i, i + 500));
      await sbPruneStale(termLabel, runId);
      total += records.length;
      console.log(`${termLabel}: upserted ${records.length} sections, pruned stale.`);
    }
    console.log(`Done. ${total} sections across ${TERMS.length} term(s). run=${runId}`);
  } catch (e) {
    console.error('Scrape failed:', e && e.message ? e.message : e);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
