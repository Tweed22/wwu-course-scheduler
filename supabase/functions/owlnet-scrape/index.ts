// Supabase Edge Function: scrape Owlnet course search → public.owlnet_sections.
// Server-side HTTP replay of the stateful Jenzabar/ASP.NET form (no browser) —
// GET the advanced form (cookies + __VIEWSTATE), POST the search with the term +
// division, page through via the ltrNav postback. Admin-only (checks the
// caller's profiles.role). Invoked on-demand by the Verification panel's
// "Scrape Owlnet" button.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { DOMParser } from "https://deno.land/x/deno_dom@v0.1.45/deno-dom-wasm.ts";

const OWLNET = "https://owlnet.williamwoods.edu/ICS/Course_Search.jnz";
const ADV = OWLNET + "?portlet=Course_Schedules&screen=Advanced+Course+Search&screenType=next";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
// OU/OG = online undergrad/grad. SU = Semester Undergraduate (on-ground) — also
// catches online-program sections the registrar filed under SU; the panel tells
// them apart by suffix (OLC/GPS = online program). `meeting` = location column.
const DIVISIONS = [{ value: "OU" }, { value: "OG" }, { value: "SU" }];
const HIDDEN = new Set(["ALE 799", "DIS 781", "DIS 790", "DIS 791"]);
const DEFAULT_TERMS = ["Spring 2027", "Fall 2026"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
}

class Jar {
  cookies = new Map<string, string>();
  update(res: Response) {
    const list = (res.headers as any).getSetCookie?.() ?? [];
    for (const c of list) {
      const pair = c.split(";")[0];
      const i = pair.indexOf("=");
      if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }
  header() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "); }
}

async function httpGet(jar: Jar, url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": UA, "Cookie": jar.header() }, redirect: "follow" });
  jar.update(res);
  return await res.text();
}
async function httpPost(jar: Jar, url: string, fields: Record<string, string>): Promise<string> {
  const body = Object.entries(fields).map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&");
  const res = await fetch(url, {
    method: "POST",
    headers: { "User-Agent": UA, "Cookie": jar.header(), "Content-Type": "application/x-www-form-urlencoded" },
    body, redirect: "follow",
  });
  jar.update(res);
  return await res.text();
}

function parseForm(html: string): Record<string, string> {
  const f: Record<string, string> = {};
  for (const m of html.matchAll(/<input[^>]*type="hidden"[^>]*>/gi)) {
    const t = m[0];
    const n = (t.match(/name="([^"]*)"/) || [])[1];
    const v = (t.match(/value="([^"]*)"/) || [])[1] || "";
    if (n) f[n] = decodeEntities(v);
  }
  for (const sm of html.matchAll(/<select[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/select>/gi)) {
    const name = sm[1], sbody = sm[2];
    const sel = sbody.match(/<option[^>]*\bselected\b[^>]*value="([^"]*)"/i) ||
                sbody.match(/<option[^>]*value="([^"]*)"[^>]*\bselected\b/i);
    f[name] = sel ? decodeEntities(sel[1]) : "";
  }
  return f;
}
function termOptions(html: string): Record<string, string> {
  const map: Record<string, string> = {};
  const sm = html.match(/<select[^>]*name="pg0\$V\$ddlTerm"[^>]*>([\s\S]*?)<\/select>/i);
  if (!sm) return map;
  for (const om of sm[1].matchAll(/<option[^>]*value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/gi)) {
    map[decodeEntities(om[2].replace(/<[^>]*>/g, "").trim())] = decodeEntities(om[1]);
  }
  return map;
}
function extractRows(html: string) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (!doc) return [];
  const out: any[] = [];
  doc.querySelectorAll("a[href*='lnkCourse']").forEach((a: any) => {
    const tr = a.closest("tr");
    if (!tr) return;
    const tds = Array.from(tr.children).map((td: any) => (td.textContent || "").replace(/\s+/g, " ").trim());
    const code = (a.textContent || "").replace(/\s+/g, " ").trim();
    let ci = tds.findIndex((t) => t === code);
    if (ci < 0) ci = 2;
    out.push({
      raw_code: code, name: tds[ci + 1] || "", faculty: tds[ci + 2] || "",
      seats: tds[ci + 3] || "", status: tds[ci + 4] || "", meeting: tds[ci + 5] || "", credits: tds[ci + 6] || "",
      begin: tds[ci + 7] || "", end: tds[ci + 8] || "",
    });
  });
  return out;
}
function nextPageArg(html: string): string | null {
  const m = html.match(/__doPostBack\('pg0\$V\$ltrNav','(\d+)'\)[^>]*>[^<]*Next page/i) ||
            html.match(/Next page[\s\S]{0,160}?__doPostBack\('pg0\$V\$ltrNav','(\d+)'\)/i);
  return m ? m[1] : null;
}

async function scrapeTermDivision(jar: Jar, termLabel: string, divisionValue: string) {
  await httpGet(jar, OWLNET);               // establish session
  let html = await httpGet(jar, ADV);        // advanced form
  const termValue = termOptions(html)[termLabel];
  if (!termValue) throw new Error(`Term "${termLabel}" not found in Owlnet`);
  const fields = parseForm(html);
  fields["pg0$V$ddlTerm"] = termValue;
  fields["pg0$V$ddlDivision"] = divisionValue;
  fields["pg0$V$btnSearch"] = "Search";
  delete fields["pg0$V$btnReset"];
  html = await httpPost(jar, ADV, fields);

  const rows: any[] = [];
  const seen = new Set<string>();
  for (let guard = 0; guard < 80; guard++) {
    for (const r of extractRows(html)) {
      const k = r.raw_code + "|" + r.begin;
      if (!seen.has(k)) { seen.add(k); rows.push(r); }
    }
    const arg = nextPageArg(html);
    if (!arg) break;
    const pf = parseForm(html);
    pf["__EVENTTARGET"] = "pg0$V$ltrNav";
    pf["__EVENTARGUMENT"] = arg;
    delete pf["pg0$V$btnSearch"];
    delete pf["pg0$V$btnReset"];
    html = await httpPost(jar, ADV, pf);
  }
  return rows;
}

function termToSemYear(label: string) {
  const m = label.match(/^(Fall|Spring|Summer)\s+(\d{4})$/i);
  if (!m) return { semester: null as any, acad_year: null as any };
  return { semester: m[1][0].toUpperCase() + m[1].slice(1).toLowerCase(), acad_year: Number(m[2]) };
}
function isoDate(d: string) {
  const m = String(d || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
}
function intOrNull(s: string) { const n = parseInt(String(s).replace(/[^0-9]/g, ""), 10); return isNaN(n) ? null : n; }
function numOrNull(s: string) { const n = parseFloat(String(s).replace(/[^0-9.]/g, "")); return isNaN(n) ? null : n; }

function toRecord(r: any, termLabel: string, divisionValue: string, runId: string) {
  const parts = r.raw_code.split(/\s+/);
  const { semester, acad_year } = termToSemYear(termLabel);
  const seats = String(r.seats).split("/");
  return {
    term_label: termLabel, semester, acad_year, division: divisionValue,
    prefix: parts[0] || "", course_number: parts[1] || "", section: parts[2] || "",
    suffix: parts.slice(3).join(" ") || "", raw_code: r.raw_code,
    title: r.name || null, instructor: r.faculty || null,
    seats_open: intOrNull(seats[0]), seats_cap: intOrNull(seats[1]),
    status: r.status || null, begin_date: isoDate(r.begin), end_date: isoDate(r.end),
    credits: numOrNull(r.credits), meeting: r.meeting || null, source_run: runId,
    // Explicit, so an upsert of an already-known section refreshes it (the
    // column default only fires on insert).
    scraped_at: new Date().toISOString(),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (obj: unknown, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json" } });
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Admin-only.
    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "Not signed in" }, 401);
    const svc = createClient(SUPABASE_URL, SERVICE);
    const { data: prof } = await svc.from("profiles").select("role").eq("id", user.id).maybeSingle();
    if (!prof || prof.role !== "admin") return json({ error: "Admins only" }, 403);

    let terms = DEFAULT_TERMS;
    try { const b = await req.json(); if (Array.isArray(b?.terms) && b.terms.length) terms = b.terms; } catch { /* no body */ }

    const runId = Date.now().toString();
    const summary: any[] = [];
    for (const termLabel of terms) {
      const { semester } = termToSemYear(termLabel);
      if (!semester) { summary.push({ term: termLabel, error: "unrecognized term" }); continue; }
      const jar = new Jar();
      const records: any[] = [];
      const seenKey = new Set<string>();   // one row per unique key — a section listed
      for (const d of DIVISIONS) {        // under two divisions would break the upsert
        const rows = await scrapeTermDivision(jar, termLabel, d.value);
        for (const r of rows) {
          const rec = toRecord(r, termLabel, d.value, runId);
          if (HIDDEN.has(`${rec.prefix} ${rec.course_number}`.trim())) continue;
          const key = [rec.prefix, rec.course_number, rec.section, rec.suffix].join("|");
          if (seenKey.has(key)) continue;
          seenKey.add(key);
          records.push(rec);
        }
        summary.push({ term: termLabel, division: d.value, scraped: rows.length });
      }
      for (let i = 0; i < records.length; i += 500) {
        const { error } = await svc.from("owlnet_sections")
          .upsert(records.slice(i, i + 500), { onConflict: "term_label,prefix,course_number,section,suffix" });
        if (error) throw new Error("upsert: " + error.message);
      }
      // Prune sections this run didn't refresh (canceled/removed, or old seed rows).
      const { error: delErr } = await svc.from("owlnet_sections").delete()
        .eq("term_label", termLabel).or(`source_run.neq.${runId},source_run.is.null`);
      if (delErr) throw new Error("prune: " + delErr.message);
    }
    return json({ ok: true, runId, summary });
  } catch (e) {
    return json({ ok: false, error: String((e as any)?.message ?? e) }, 500);
  }
});
