// Daily automated backup of WWU Course Scheduler assignments from Supabase.
// Run via launchd (com.wwuapps.scheduler-backup.plist) — no npm deps needed.
//
// Requires backups/.backup-env (gitignored) with:
//   SB_SERVICE_KEY=<your-supabase-service-role-key>

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dir, 'backups', '.backup-env');
if (!existsSync(envPath)) {
  console.error(`Missing ${envPath} — create it with SB_SERVICE_KEY=<service-role-key>`);
  process.exit(1);
}
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const [k, ...v] = line.split('=');
  if (k && v.length) process.env[k.trim()] = v.join('=').trim();
}

const SB_URL = "https://xyissgatpbldeedhomol.supabase.co";
const SB_KEY = process.env.SB_SERVICE_KEY;

const SCHOOL_BY_PREFIX = {
  ACC:"B&T", BUS:"B&T", CIS:"B&T", CSS:"B&T", ECN:"B&T", HLT:"B&T", LDR:"B&T", MGT:"B&T", ORL:"B&T", SBA:"B&T", SMG:"B&T",
  MIL:"B&T", MSL:"B&T", ICS:"B&T",
  ART:"AD&M", FLM:"AD&M", MUS:"AD&M", THA:"AD&M",
  ASL:"SS&H", ITP:"SS&H", CMJ:"SS&H", COM:"SS&H", HIS:"SS&H", HSV:"SS&H", HUM:"SS&H", PHL:"SS&H", PLS:"SS&H", PSY:"SS&H", SPA:"SS&H", SWK:"SS&H", WWU:"SS&H",
  ENG:"SS&H", IFL:"SS&H", PRL:"SS&H",
  BIO:"S&H", CHM:"S&H", GEO:"S&H", MAT:"S&H", PHY:"S&H", SCI:"S&H",
  ALE:"EDU", EDC:"EDU", EDU:"EDU", RDG:"EDU",
  EHP:"EQS", EXS:"EQS", PED:"EQS", NUR:"EQS", ATR:"EQS", FLD:"EQS",
  EPD:"EQS", EQA:"EQS", EQE:"EQS", EQR:"EQS", EQS:"EQS", EQU:"EQS", DIS:"EQS",
};
const DEAN_BY_SCHOOL = {
  "B&T":  "Miriam O'Callaghan",
  "EDU":  "Jim Concannon",
  "AD&M": "Krista Frohling",
  "S&H":  "Sean Baldridge",
  "EQS":  "Jennie Petterson",
  "SS&H": "Zach Dowdle",
};

async function fetchAll(table) {
  const rows = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const resp = await fetch(`${SB_URL}/rest/v1/${table}?select=*&limit=${pageSize}&offset=${from}`, {
      headers: {
        'apikey': SB_KEY,
        'Authorization': `Bearer ${SB_KEY}`,
      }
    });
    if (!resp.ok) throw new Error(`${table}: ${resp.status} ${await resp.text()}`);
    const batch = await resp.json();
    if (!batch || !batch.length) break;
    rows.push(...batch);
    if (batch.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

function csvCell(v) {
  v = String(v ?? '');
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

async function main() {
  const [offerings, pmRows] = await Promise.all([
    fetchAll('offerings'),
    fetchAll('course_program_managers'),
  ]);

  const pmByCourse = {};
  const deanByCourse = {};
  for (const row of pmRows) {
    const key = (row.course_code || '').trim().toUpperCase();
    if (!key) continue;
    if (!pmByCourse[key]) pmByCourse[key] = row.program_manager || '';
    if (row.dean && !deanByCourse[key]) deanByCourse[key] = row.dean;
  }

  const SEM_ORD = { Fall: 0, Spring: 1, Summer: 2 };
  offerings.sort((a, b) => {
    if ((a.year || 0) !== (b.year || 0)) return (a.year || 0) - (b.year || 0);
    if (a.semester !== b.semester) return (SEM_ORD[a.semester] || 0) - (SEM_ORD[b.semester] || 0);
    return (a.subterm || '').localeCompare(b.subterm || '');
  });

  function sectionNum(o) {
    const code = o.course_code || '';
    const siblings = offerings.filter(x =>
      x.course_code === code && x.semester === o.semester &&
      x.subterm === o.subterm && x.year === o.year
    );
    const idx = siblings.findIndex(x => x.id === o.id);
    return String(idx < 0 ? 1 : idx + 1).padStart(2, '0');
  }

  function deanFor(code) {
    const key = (code || '').trim().toUpperCase();
    if (deanByCourse[key]) return deanByCourse[key];
    const school = SCHOOL_BY_PREFIX[key.split(' ')[0]] || '';
    return DEAN_BY_SCHOOL[school] || '';
  }

  const cols = [
    'Course', 'Section', 'Semester', 'Subterm', 'Year',
    'Length', 'School', 'Dean', 'Program Manager',
    'Instructor', 'Submitted', 'Submitted At',
    'Registrar Completed', 'Completed At', 'Canceled', 'Notes',
  ];

  const lines = [cols.join(',')];
  for (const o of offerings) {
    const blob = (o.data && typeof o.data === 'object') ? o.data : o;
    const code = o.course_code || '';
    const prefix = code.split(' ')[0];
    const key = code.trim().toUpperCase();
    const submittedAt = (o.submitted_at || blob.submittedAt || '');
    const completedAt = (o.registrar_completed_at || blob.registrarCompletedAt || '');
    lines.push([
      code,
      sectionNum(o),
      o.semester || '',
      o.subterm || '',
      o.year || '',
      blob.length || o.length || '',
      SCHOOL_BY_PREFIX[prefix] || '',
      deanFor(code),
      pmByCourse[key] || blob.programManager || '',
      blob.instructor || o.instructor || '',
      o.submitted ? 'Yes' : 'No',
      submittedAt ? submittedAt.slice(0, 10) : '',
      o.registrar_completed ? 'Yes' : 'No',
      completedAt ? completedAt.slice(0, 10) : '',
      blob.canceled ? 'Yes' : 'No',
      blob.notes || o.notes || '',
    ].map(csvCell).join(','));
  }

  const today = new Date().toISOString().slice(0, 10);
  const dir = join(__dir, 'backups');
  mkdirSync(dir, { recursive: true });
  const outPath = join(dir, `wwu-schedule-backup-${today}.csv`);
  writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.log(`[${new Date().toISOString()}] Saved ${offerings.length} rows → ${outPath}`);
}

main().catch(err => {
  console.error(`[${new Date().toISOString()}] BACKUP FAILED:`, err.message);
  process.exit(1);
});
