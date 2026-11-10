// Server-side counterpart of the scheduler Verification panel's post-pass
// (index.html reconcileOwlnet / reconcileOnGround, "Record the verification on
// every online offering…"). After a term is scraped, refresh the Owlnet fields
// Term Assignments shows on each section — the instructor check behind the LIVE
// badge and the enrollment bar — so they stay current on the scheduled runs
// without an admin opening Verification.
//
// Narrower than the panel on purpose: it only touches sections that already
// carry Owlnet's official section number (the panel adopts it on a clean match —
// about 99% of matched sections), and only when exactly one Owlnet row has that
// course + program + section. New, renumbered or ambiguous sections are left for
// the panel, which also does all the flagging.
//
// Writes go through public.owlnet_patch_offerings, which merges each patch into
// the row's data blob in SQL (data = data || patch), so a user's concurrent edit
// to any other field is never overwritten.
//
// The instructor-name helpers are copied from index.html — keep them in sync.

type Owl = {
  prefix: string; course_number: string; section: string; suffix: string; division: string;
  instructor: string | null; seats_open: number | null; seats_cap: number | null;
};

const ONLINE_SUFFIXES = new Set(["OLC", "GPS"]);   // OWLNET_ONLINE_SUFFIXES in index.html
const IGNORED_SUFFIXES = new Set(["CIC"]);         // OWLNET_IGNORED_SUFFIXES (consortium)

// _owlProgram: OU/OG = online program; SU = semester program, except online
// sections the registrar filed under SU (they keep the OLC/GPS suffix).
function program(r: Owl) {
  if (String(r.division || "").toUpperCase() !== "SU") return "online";
  return ONLINE_SUFFIXES.has(String(r.suffix || "").trim().toUpperCase()) ? "online" : "semester";
}
const normSec = (s: unknown) => String(s == null ? "" : s).replace(/\D/g, "").replace(/^0+/, "") || "0";
const canonCode = (s: unknown) => String(s || "").trim().toUpperCase().replace(/\s+/g, " ");

// ---- instructor matching (copied from index.html) ----
function isStaff(name: unknown) {
  const n = String(name || "").trim().toLowerCase();
  return !n || /^staff\b/.test(n) || n === "tba" || n === "faculty";
}
function nameParts(name: unknown) {
  const s = String(name || "").replace(/\./g, "").trim();
  if (!s) return null;
  if (s.includes(",")) {
    const i = s.indexOf(",");
    const given = s.slice(i + 1).trim().toLowerCase().split(/\s+/).filter(Boolean);
    return { last: s.slice(0, i).trim().toLowerCase().split(/[\s-]+/).filter(Boolean), first: given[0] || "", given };
  }
  const t = s.toLowerCase().split(/\s+/).filter(Boolean);
  if (t.length === 1) return { last: [t[0]], first: "", given: [] as string[] };
  return { last: t.slice(1).flatMap((x) => x.split("-")).filter(Boolean), first: t[0], given: [t[0]] };
}
const NICK: Record<string, string> = {
  bob: "robert", rob: "robert", robbie: "robert", bobby: "robert", bert: "robert",
  bill: "william", billy: "william", will: "william", liam: "william",
  jim: "james", jimmy: "james", jamie: "james", dick: "richard", rick: "richard", rich: "richard",
  ted: "edward", ed: "edward", eddie: "edward", ned: "edward", jack: "john", johnny: "john",
  dave: "david", joe: "joseph", joey: "joseph", andy: "andrew", drew: "andrew",
  steve: "steven", chuck: "charles", charlie: "charles", hank: "henry", harry: "henry",
  peggy: "margaret", maggie: "margaret", meg: "margaret", liz: "elizabeth", betty: "elizabeth",
  kate: "katherine", katie: "katherine", kathy: "katherine", becky: "rebecca", patty: "patricia",
  jennie: "jennifer", jenny: "jennifer", sandy: "sandra", sue: "susan", trish: "patricia",
  tony: "anthony", toni: "antoinette", lisa: "elizabeth", bess: "elizabeth", polly: "mary",
  nancy: "ann", sasha: "alexander", xander: "alexander", gus: "augustus",
  sheb: "gulsebnem",
};
function firstCompatible(x: string, y: string) {
  if (!x || !y) return true;
  if (x === y || x[0] === y[0]) return true;
  if (x.startsWith(y) || y.startsWith(x)) return true;
  const [s, l] = x.length <= y.length ? [x, y] : [y, x];
  if (s.length >= 3 && l.endsWith(s)) return true;
  const fx = NICK[x] || x, fy = NICK[y] || y;
  return fx === fy || fx.startsWith(fy) || fy.startsWith(fx);
}
function edit1(x: string, y: string) {
  if (x === y) return true;
  if (Math.abs(x.length - y.length) > 1) return false;
  let i = 0, j = 0, diffs = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { i++; j++; continue; }
    if (++diffs > 1) return false;
    if (x.length > y.length) i++; else if (y.length > x.length) j++; else { i++; j++; }
  }
  return diffs + (x.length - i) + (y.length - j) <= 1;
}
function sameInstructor(schedName: unknown, owlName: unknown) {
  const schedBlank = isStaff(schedName), owlStaff = isStaff(owlName);
  if (schedBlank || owlStaff) return schedBlank && owlStaff;
  const a = nameParts(schedName), b = nameParts(owlName);
  if (!a || !b) return false;
  const firstOk = !a.first || !b.given.length || b.given.some((g) => firstCompatible(a.first, g));
  if (a.last.some((x) => b.last.includes(x))) return firstOk;
  const exactFirst = a.first && b.given.some((g) => g === a.first);
  return !!exactFirst && a.last.some((x) => b.last.some((y) => x.length >= 4 && y.length >= 4 && edit1(x, y)));
}

export async function applyOwlnetToOfferings(svc: any, semester: string, year: number, records: Owl[]) {
  const idx = new Map<string, Owl[]>();
  for (const r of records) {
    if (IGNORED_SUFFIXES.has(String(r.suffix || "").trim().toUpperCase())) continue;
    const k = `${canonCode(`${r.prefix} ${r.course_number}`)}|${program(r)}|${normSec(r.section)}`;
    if (!idx.has(k)) idx.set(k, []);
    idx.get(k)!.push(r);
  }
  const { data: offs, error } = await svc.from("offerings")
    .select("id, course_code, modality, data").eq("semester", semester).eq("year", year);
  if (error) throw new Error("offerings read: " + error.message);

  const nowIso = new Date().toISOString();
  const patches: { id: string; patch: Record<string, unknown> }[] = [];
  let matched = 0;
  for (const o of offs || []) {
    const d = o.data || {};
    if (d.deleted === true) continue;
    const sec = String(d.officialSection || "").trim();
    if (!sec) continue;
    const prog = o.modality === "Online" ? "online" : "semester";
    const rows = idx.get(`${canonCode(o.course_code)}|${prog}|${normSec(sec)}`) || [];
    if (rows.length !== 1) continue;            // gone, renumbered or ambiguous — leave for the panel
    matched++;
    const r = rows[0];
    const canceled = d.canceled === true;
    const isV = !canceled && sameInstructor(d.instructor, r.instructor);
    const wantInstr = isV ? String(d.instructor || "") : "";
    const wantOwl = isV ? String(r.instructor || "") : "";
    const wantOpen = canceled || r.seats_open == null ? null : Number(r.seats_open);
    const wantCap = canceled || r.seats_cap == null ? null : Number(r.seats_cap);
    const patch: Record<string, unknown> = {};
    if (!!d.owlnetVerified !== isV || String(d.owlnetVerifiedInstructor || "") !== wantInstr ||
        String(d.owlnetInstructor || "") !== wantOwl) {
      patch.owlnetVerified = isV;
      patch.owlnetVerifiedInstructor = wantInstr;
      patch.owlnetInstructor = wantOwl;
      patch.owlnetVerifiedAt = isV ? nowIso : "";
    }
    if ((d.owlnetSeatsOpen ?? null) !== wantOpen || (d.owlnetSeatsCap ?? null) !== wantCap) {
      patch.owlnetSeatsOpen = wantOpen;
      patch.owlnetSeatsCap = wantCap;
    }
    if (Object.keys(patch).length) patches.push({ id: o.id, patch });
  }

  let updated = 0;
  for (let i = 0; i < patches.length; i += 200) {
    const { data: n, error: e2 } = await svc.rpc("owlnet_patch_offerings", { p: patches.slice(i, i + 200) });
    if (e2) throw new Error("patch: " + e2.message);
    updated += Number(n) || 0;
  }
  return { matched, updated };
}
