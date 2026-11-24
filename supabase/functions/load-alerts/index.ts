// load-alerts — the hourly check behind the scheduler's faculty-load warnings.
//
// When a PM/dean/admin chooses "Submit anyway" on an over-the-limit assignment,
// the scheduler records it in public.load_alerts (status 'projected': over only
// if every section makes). This function re-checks every record an admin hasn't
// marked Checked, counting MADE sections only (8+ students, per the contracting
// apps' rules), with Owlnet's latest enrollment:
//   • made sections now put the person over the limit → status 'made_over'
//     (+ made_over_at and the section(s) that crossed). The Provost Hub shows
//     these to scheduler admins; Verification → Faculty loads lists them all.
//   • back within the limit after having crossed → 'back_under'.
// The load math is engine.js, GENERATED from the scheduler's index.html
// (LOAD-ENGINE block) by tools/build-load-engine.mjs — never edit it here.
//
// Callers: pg_cron job load-alerts-check (x-cron-secret, the same vault secret
// as owlnet-scrape, checked by public.owlnet_cron_ok) or a signed-in scheduler
// admin. Deployed with verify_jwt off; both paths authenticate here.
// Body (optional): { "dry": true, "terms": [["Spring", 2027], ...] } — report
// counts only, write nothing.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { _ldCompute, _ldOverBy, _ldMadeLabels, _ldFhIndex, _LD_DEFAULTS, canonicalCourseCode, engineFingerprint } from "./engine.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

// deno-lint-ignore no-explicit-any
async function selectAll(q: () => any): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q().range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < 1000) return out;
  }
}

// Labels in `now` that weren't in `before` (repeats counted).
function newlyMade(now: string[], before: string[]): string[] {
  const left = new Map<string, number>();
  (before || []).forEach((l) => left.set(l, (left.get(l) || 0) + 1));
  return now.filter((l) => {
    const n = left.get(l) || 0;
    if (n > 0) { left.set(l, n - 1); return false; }
    return true;
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (obj: unknown, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json" } });
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
    const svc = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // The scheduled job, or a signed-in scheduler admin.
    const cronSecret = req.headers.get("x-cron-secret");
    if (cronSecret) {
      const { data: ok } = await svc.rpc("owlnet_cron_ok", { p_secret: cronSecret });
      if (ok !== true) return json({ error: "Bad cron secret" }, 403);
    } else {
      const userClient = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: req.headers.get("Authorization") || "" } } });
      const { data: { user } } = await userClient.auth.getUser();
      if (!user) return json({ error: "Not signed in" }, 401);
      const { data: prof } = await svc.from("profiles").select("role").eq("id", user.id).maybeSingle();
      if (!prof || prof.role !== "admin") return json({ error: "Admins only" }, 403);
    }
    let body: Row = {};
    try { body = await req.json(); } catch { /* no body */ }
    const dry = body.dry === true;

    const open = await selectAll(() => svc.from("load_alerts").select("*").is("checked_at", null).order("created_at"));
    const termKeys = new Map<string, [string, number]>();
    open.forEach((a) => termKeys.set(`${a.semester}|${a.year}`, [a.semester, Number(a.year)]));
    if (dry && Array.isArray(body.terms)) body.terms.forEach((t: [string, number]) => termKeys.set(`${t[0]}|${t[1]}`, [t[0], Number(t[1])]));
    if (!termKeys.size) return json({ open: 0, updated: 0, engine: await engineFingerprint() });

    // Contracting-app inputs (all terms — the faculty-hours history needs them).
    const [faculty, settingsRows, ogc, onc] = await Promise.all([
      selectAll(() => svc.from("ogc_faculty").select("id, first_name, last_name, faculty_type, contracted_load, is_active").order("id")),
      selectAll(() => svc.from("ogc_settings").select("key, value").order("key")),
      selectAll(() => svc.from("ogc_courses").select("id, term_code, course_code, section, title, credit_hours, course_type, enrollment, faculty_id, faculty_hours, pct_toward_load, delivery, status_override, faculty_hours_override, load_hours_override, start_date").order("id")),
      selectAll(() => svc.from("onc_sections").select("id, term_code, course_code, section, delivery, title, credit_hours, enrollment, faculty_id, excluded, subterm, start_date").order("id")),
    ]);
    const settings: Row = { ..._LD_DEFAULTS };
    settingsRows.forEach((s) => { settings[s.key] = s.value; });
    const contract = { faculty: faculty.filter((f) => f.is_active !== false), settings, ogc, onc: onc.filter((o) => o.excluded !== true), fhIndex: null as unknown };
    contract.fhIndex = _ldFhIndex(ogc);

    const nowIso = new Date().toISOString();
    // Today in Central time: contracting-app sections that have started count only if made.
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
    const report: Row[] = [];
    let updated = 0;
    for (const [semester, year] of termKeys.values()) {
      const [offs, owlnet] = await Promise.all([
        selectAll(() => svc.from("offerings").select("id, course_code, instructor, modality, data")
          .eq("data->>semester", semester).eq("data->>year", String(year)).order("id")),
        selectAll(() => svc.from("owlnet_sections").select("semester, acad_year, prefix, course_number, section, division, suffix, credits")
          .eq("semester", semester).eq("acad_year", year).order("id")),
      ]);
      // The scheduler's sections, shaped like the browser's _ldSchedulerSections().
      const sections = offs.filter((o) => !o.data?.deleted && !o.data?.canceled).map((o) => {
        const d = o.data || {};
        const cap = d.owlnetSeatsCap, openSeats = d.owlnetSeatsOpen;
        return {
          id: o.id, code: canonicalCourseCode(o.course_code || d.courseCode || ""), sec: String(d.officialSection || "").trim(),
          prog: (o.modality || d.modality) === "On-Ground" ? "semester" : "online", lab: !!d.owlnetLab,
          title: d.owlnetTitle || "", sub: d.subterm, slot: d.rotationSlot,
          instructor: o.instructor ?? d.instructor ?? "",
          enrolled: (cap != null && openSeats != null) ? Math.max(0, Number(cap) - Number(openSeats)) : null,
          catalogCredits: null,
        };
      });
      const res = _ldCompute({ semester, year, today, sections, owlnet, contract });
      const termReport: Row = { semester, year, termSetUp: res.termSet, people: res.rows.length,
        overNow: res.rows.filter((r: Row) => _ldOverBy(r, "now") != null).length,
        overIfAllMake: res.rows.filter((r: Row) => _ldOverBy(r, "all") != null).length, alerts: 0, changed: 0 };

      for (const a of open.filter((x) => x.semester === semester && Number(x.year) === year)) {
        termReport.alerts++;
        const row = res.rows.find((r: Row) => a.faculty_id ? (r.fac && r.fac.id === a.faculty_id) : r.name.toLowerCase() === String(a.instructor).toLowerCase());
        const madeOver = _ldOverBy(row, "now");
        const made: string[] = _ldMadeLabels(row);
        const status = madeOver != null ? "made_over" : (a.status === "projected" ? "projected" : "back_under");
        const patch: Row = {
          status, made_sections: made, last_checked_at: nowIso,
          made_over_by: row && row.limitTotal != null ? Math.round((row.usedNow - row.limitTotal) * 100) / 100 : null,
        };
        if (status === "made_over" && a.status !== "made_over") {
          patch.made_over_at = nowIso;
          patch.crossed_sections = newlyMade(made, Array.isArray(a.made_sections) ? a.made_sections : []);
        }
        if (status !== a.status) termReport.changed++;
        if (!dry) {
          const { error } = await svc.from("load_alerts").update(patch).eq("id", a.id);
          if (error) throw new Error(`update ${a.id}: ${error.message}`);
          updated++;
        }
      }
      report.push(termReport);
    }
    return json({ dry, open: open.length, updated, engine: await engineFingerprint(), terms: report });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
