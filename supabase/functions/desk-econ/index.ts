// ── desk-econ — the Economy panel: yields, jobs, inflation, keyless, on demand ──
// Deployed as a Supabase Edge Function (Deno). One self-contained file (settled
// owner ruling: no `_shared/` module). Owner request 2026-09-30: a table in the
// desk row's 4th slot with the most CURRENT economic statistics — Treasury 2Y /
// 10Y / 20Y, unemployment, CPI and PCE inflation — "updated as soon as that data
// changes", each row with its own small chart whose span is selectable. Spec:
// specs/economy-indicators/spec.md (the response contract lives there).
//
// SOURCES — keyless only (owner approved: no API key, no new secret):
//   * FRED public CSV (fredgraph.csv) is the SPINE of every row: full history,
//     every series. Verified reachable from the build sandbox 2026-09-30. It
//     LAGS the daily yields by ~1-2 business days (measured 2026-09-30: newest
//     DGS10 observation was 2026-09-28).
//   * U.S. Treasury "Daily Treasury Par Yield Curve Rates" CSV is a TAIL for the
//     three yields only (ON in the roster since 2026-09-30) — it posts the day's
//     RATE (a ~15:30 ET snapshot of bid-side quotes, not the actual close) the same afternoon
//     (~15:30-18:00 ET), never intraday. MEASURED from Supabase's servers 2026-10-01
//     (throwaway desk-probe, 3 runs): the file's layout matches the parser below and
//     its values equal FRED's DGS* on shared dates, but home.treasury.gov answers
//     SLOWLY — 17-20 s per request regardless of size, once past 20 s. And every
//     desk-econ request is served by a FRESH instance (measured the same day:
//     generatedAt differed on calls 4 s apart), so nothing kept in module memory
//     is ever seen again. Treasury's validated rows therefore live in the SHARED
//     store desk_feed_cache (key `econ:treasury`), which every request reads; one
//     request per interval takes a lease and does the slow fetch, AWAITED (see
//     treasuryCycle). It is still never trusted on its own: a Treasury observation
//     is used only when it is NEWER than FRED's newest AND agrees with FRED on
//     every date the two share. Any fetch, parse, store or agreement failure
//     leaves the row on FRED.
//
// Anon-callable PUBLIC feed, same family as desk-market / desk-maps: no caller
// input reaches an upstream URL (the roster is committed config, validated here;
// `range` is an allowlist token that only selects a slice of cached data). It
// holds the SERVICE KEY solely for desk_feed_cache (desk_006, RLS deny-all), which
// stores public Treasury yield observations only — exactly as desk-heatmap and
// desk-news do. No other database use, no other secret. CORS is the quote-proxy
// ORIGIN ALLOWLIST (site origin only) — a browser-enforced speed-bump, not an auth wall.

// ── CORS: origin allowlist (quote-proxy pattern) ─────────────────────────────
const ALLOWED_ORIGINS = new Set([
  'https://akyachtsman.github.io', // the live GitHub Pages site
]);
const ALLOW_HEADERS = 'authorization, x-client-info, apikey, content-type';
const ALLOW_METHODS = 'POST, OPTIONS';

function corsHeaders(origin: string, allowed: boolean): Record<string, string> {
  const h: Record<string, string> = {
    'Access-Control-Allow-Headers': ALLOW_HEADERS,
    'Access-Control-Allow-Methods': ALLOW_METHODS,
    Vary: 'Origin',
  };
  if (allowed) h['Access-Control-Allow-Origin'] = origin; // echo only allowed origins
  return h;
}
const reply = (status: number, body: unknown, cors: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });

// The UA is for OUTBOUND third-party fetches (FRED, Treasury, the Pages-served
// config) and nothing else. The desk_feed_cache REST calls (storeHeaders) must
// NEVER carry it (CLAUDE.md: a browser-shaped UA makes the gateway refuse an
// sb_secret key with a 401 that a catch swallows — the store would silently read
// as unavailable and the yields stay on FRED).
const UA = { 'user-agent': 'Mozilla/5.0 (desk econ; +https://akyachtsman.github.io/claude.trading/)' };
const CONFIG_URL = 'https://akyachtsman.github.io/claude.trading/config/econ-indicators.json';
const FRED_CSV = 'https://fred.stlouisfed.org/graph/fredgraph.csv';
// The month-scoped CSV download of the par yield curve (reached from Supabase
// 2026-10-01: HTTP 200 text/csv, 17-20 s). Fetched for the current AND previous NY
// month so the tail never falls into a month boundary (FRED can lag across the 1st).
const treasuryCsvUrl = (yyyymm: string) =>
  'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/all/'
  + `${yyyymm}?type=daily_treasury_yield_curve&field_tdr_date_value_month=${yyyymm}&page&_format=csv`;

// Deno's fetch has no default timeout: every upstream call is bounded, so a
// stalled host costs its own row, never the invocation. The signal also bounds
// the body read (res.text()).
const CONFIG_TIMEOUT_MS = 5_000;
const FRED_TIMEOUT_MS = 8_000;
// Treasury answers Supabase in 17-20 s (once past 20 s, 2026-10-01): the old 5 s
// limit failed every time. Only the one request holding the lease waits on it.
const TREASURY_TIMEOUT_MS = 45_000;
const CONFIG_TTL_MS = 3_600_000;       // same as desk-charts' roster: edits land within the hour
const TREASURY_BACKOFF_MS = 600_000;   // after a failed Treasury attempt, no instance retries for 10 min
const TREASURY_KEEP_MS = 72 * 3_600_000; // a validated Treasury observation is a fact; keep it 72h
const TREASURY_TOL = 0.015;            // both publish 2 decimals: "agree" = equal after float noise
const TREASURY_POSTING_EVERY_MS = 300_000;  // today's rate missing, weekday 15:25 ET to midnight: one attempt per 5 min
const TREASURY_IDLE_EVERY_MS = 3_600_000;   // outside it, only while nothing has landed since the window last opened: hourly
// The shared Treasury store (desk_feed_cache row). Bounded: a slow database costs
// the Treasury tail for one reply, never the reply.
const STORE_KEY = 'econ:treasury';
const STORE_TIMEOUT_MS = 3_000;
const STORE_SKEW_MS = 60_000;          // a stored stamp later than now + this is corrupt, not a lease

// Refresh policy (see refreshPolicy): 60s inside release windows, 15 min on a
// quiet weekday, a 60 min heartbeat at weekends, 2 min while any row is degraded.
const WINDOW_TTL_MS = 60_000;
const QUIET_TTL_MS = 900_000;
const WEEKEND_TTL_MS = 3_600_000;
const DEGRADED_TTL_MS = 120_000;
const MIN_REFRESH_SEC = 30;
const FORCE_MIN_GAP_MS = 30_000;

const MAX_ROWS = 12;
const MAX_POINTS = 120;
const MIN_POINTS = 6;
// 5y of display + 12 months of YoY base + ~4 months of publication lag.
const HISTORY_MONTHS = 76;

type Obs = [string, number]; // [YYYY-MM-DD, value], always oldest first
type Cadence = 'daily' | 'weekly' | 'monthly' | 'quarterly';
type Transform = 'level' | 'yoy' | 'mom';
type RosterRow = {
  id: string; label: string; fred: string; treasury: string | null;
  unit: string; transform: Transform; cadence: Cadence; decimals: number;
};

// ── roster (config/econ-indicators.json) ─────────────────────────────────────
// The committed default; the Pages-served config overrides it once published.
// Identical content, run through the same validator, so the fallback can never
// be a row the config would have rejected.
// CPI uses CPIAUCNS (NOT seasonally adjusted): BLS computes its headline 12-month
// change from the unadjusted index, and the adjusted one differs by up to ~0.1pp
// (measured on the 2026 captures: May 4.17 vs 4.25, Aug 3.35 vs 3.40). BEA's PCE
// headline is computed from the adjusted index, so PCE uses PCEPI / PCEPILFE.
// The Treasury same-day TAIL is ON for the three yields (owner request 2026-09-30:
// current 2Y and 10Y yields, superseding the same day's "FRED only to begin with";
// 20Y comes from the same Treasury file and is included so no yield in the table sits
// a day behind its neighbours). Treasury's par-yield file is a daily RATE (a
// snapshot of bid-side quotes taken ~15:30 ET, not the actual close) posted ~15:30-18:00 ET:
// same day, never intraday. The layout was verified against the live file from
// Supabase on 2026-10-01; the host is slow (17-20 s), so the tail lives in the shared
// store desk_feed_cache and only the request holding the lease waits on a fetch
// (treasuryCycle). stitchTreasury still uses it only when it
// agrees with FRED and is newer; any failure is a silent per-row fallback to FRED
// (the row's `source` says which). This roster
// and config/econ-indicators.json must stay IDENTICAL and name exactly these three
// Treasury columns — econ-check asserts both (the only reason this is exported).
export const DEFAULT_ROSTER: unknown[] = [
  { id: 'ust2y', label: '2Y Treasury', sources: { fred: 'DGS2', treasury: '2 Yr' }, unit: '%', transform: 'level', cadence: 'daily', decimals: 2 },
  { id: 'ust10y', label: '10Y Treasury', sources: { fred: 'DGS10', treasury: '10 Yr' }, unit: '%', transform: 'level', cadence: 'daily', decimals: 2 },
  { id: 'ust20y', label: '20Y Treasury', sources: { fred: 'DGS20', treasury: '20 Yr' }, unit: '%', transform: 'level', cadence: 'daily', decimals: 2 },
  { id: 'unrate', label: 'Unemployment', sources: { fred: 'UNRATE' }, unit: '%', transform: 'level', cadence: 'monthly', decimals: 1 },
  { id: 'cpi', label: 'CPI YoY', sources: { fred: 'CPIAUCNS' }, unit: '%', transform: 'yoy', cadence: 'monthly', decimals: 1 },
  { id: 'pce', label: 'PCE YoY', sources: { fred: 'PCEPI' }, unit: '%', transform: 'yoy', cadence: 'monthly', decimals: 1 },
  { id: 'corepce', label: 'Core PCE YoY', sources: { fred: 'PCEPILFE' }, unit: '%', transform: 'yoy', cadence: 'monthly', decimals: 1 },
];

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,23}$/;
const FRED_ID_RE = /^[A-Z0-9_]{1,30}$/;    // reaches an upstream URL: strict, and still encoded
const UNIT_RE = /^[%$A-Za-z]{0,4}$/;
const TREASURY_COLS = new Set([
  '1 Mo', '1.5 Month', '2 Mo', '3 Mo', '4 Mo', '6 Mo', '1 Yr', '2 Yr', '3 Yr', '5 Yr', '7 Yr', '10 Yr', '20 Yr', '30 Yr',
]);
const CADENCES = new Set(['daily', 'weekly', 'monthly', 'quarterly']);
const TRANSFORMS = new Set(['level', 'yoy', 'mom']);

// Never trusts the roster: a bad row is DROPPED (and counted), duplicates by id
// keep the first, and the list is capped at MAX_ROWS.
export function validateRoster(input: unknown): { rows: RosterRow[]; dropped: number } {
  const rows: RosterRow[] = [];
  let dropped = 0;
  if (!Array.isArray(input)) return { rows, dropped };
  const seen = new Set<string>();
  for (const raw of input) {
    const r = checkRow(raw);
    if (!r || seen.has(r.id) || rows.length >= MAX_ROWS) { dropped++; continue; }
    seen.add(r.id);
    rows.push(r);
  }
  return { rows, dropped };
}

function checkRow(raw: unknown): RosterRow | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  // deno-lint-ignore no-explicit-any
  const o = raw as any;
  const id = typeof o.id === 'string' ? o.id.trim() : '';
  const label = typeof o.label === 'string' ? o.label.trim() : '';
  const src = o.sources && typeof o.sources === 'object' ? o.sources : null;
  const fred = src && typeof src.fred === 'string' ? src.fred.trim().toUpperCase() : '';
  const treasury = src && src.treasury != null ? src.treasury : null;
  const transform = o.transform ?? 'level';
  const cadence = o.cadence;
  const decimals = o.decimals ?? 2;
  if (!ID_RE.test(id) || !label || label.length > 12 || !FRED_ID_RE.test(fred)) return null;
  if (!TRANSFORMS.has(transform) || !CADENCES.has(cadence)) return null;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 4) return null;
  if (transform === 'mom' && cadence !== 'monthly') return null;
  // Treasury is a same-day TAIL for a daily yield level, nothing else.
  if (treasury !== null && (typeof treasury !== 'string' || !TREASURY_COLS.has(treasury)
    || cadence !== 'daily' || transform !== 'level')) return null;
  let unit: string;
  if (transform === 'level') {
    unit = o.unit ?? '';
    if (typeof unit !== 'string' || !UNIT_RE.test(unit)) return null;
  } else {
    unit = '%'; // the math defines the unit: a change in percent
  }
  return { id, label, fred, treasury, unit, transform, cadence, decimals };
}

type Roster = { rows: RosterRow[]; source: 'config' | 'default'; dropped: number };
let rosterCache: (Roster & { at: number }) | null = null;

async function loadRoster(now: number): Promise<Roster> {
  if (rosterCache && now - rosterCache.at < CONFIG_TTL_MS) return rosterCache;
  try {
    const res = await fetch(CONFIG_URL, { headers: UA, signal: AbortSignal.timeout(CONFIG_TIMEOUT_MS) });
    if (res.ok) {
      const v = validateRoster(await res.json());
      if (v.rows.length) {
        rosterCache = { at: now, rows: v.rows, source: 'config', dropped: v.dropped };
        return rosterCache;
      }
    }
  } catch { /* fall through */ }
  // Unreachable or unusable config: keep a previously good one if we have it
  // (re-stamped, so a dead Pages host is not asked on every call), else the
  // committed default.
  if (rosterCache && rosterCache.source === 'config') {
    rosterCache = { ...rosterCache, at: now };
    return rosterCache;
  }
  const d = validateRoster(DEFAULT_ROSTER);
  rosterCache = { at: now, rows: d.rows, source: 'default', dropped: d.dropped };
  return rosterCache;
}

// ── the America/New_York wall clock ──────────────────────────────────────────
// ONE hoisted formatter (the NY_DATE rule — named NY_CLOCK here because it also
// yields the time of day). Building an Intl.DateTimeFormat per call is what cost
// desk-charts its CPU budget. Timezone-aware on purpose: the release windows are
// NY wall-clock times, and a fixed UTC offset is wrong for half the year.
const NY_CLOCK = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', weekday: 'short',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
function nyWall(ms: number): { date: string; dow: string; sec: number } {
  const parts = NY_CLOCK.formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    dow: get('weekday'),
    sec: (Number(get('hour')) % 24) * 3600 + Number(get('minute')) * 60 + Number(get('second')),
  };
}

// Release windows, weekdays, NY wall clock, [from, to):
//   08:25-09:15  BLS / BEA releases at 08:30 (jobs, CPI, PCE) — FRED mirrors them
//                within minutes to an hour; the quiet TTL catches a late mirror.
//   15:25-18:30  Treasury posts the day's par yield curve in the afternoon.
// Federal holidays are NOT excluded (no release happens, so a holiday window
// costs a few extra cached fetches — cheaper than a holiday table to maintain).
const WINDOWS = [
  { from: 8 * 3600 + 25 * 60, to: 9 * 3600 + 15 * 60 },
  { from: 15 * 3600 + 25 * 60, to: 18 * 3600 + 30 * 60 },
];
export function refreshPolicy(ms: number): { phase: 'release' | 'quiet' | 'weekend'; ttlMs: number } {
  const w = nyWall(ms);
  if (w.dow === 'Sat' || w.dow === 'Sun') return { phase: 'weekend', ttlMs: WEEKEND_TTL_MS };
  for (const win of WINDOWS) {
    if (w.sec >= win.from && w.sec < win.to) return { phase: 'release', ttlMs: WINDOW_TTL_MS };
  }
  // Quiet: never sleep THROUGH the opening of today's next window. Same-day only
  // is enough — DST moves on a Sunday, and every cross-day gap is longer than
  // the quiet TTL anyway.
  let ttl = QUIET_TTL_MS;
  for (const win of WINDOWS) {
    if (win.from > w.sec) { ttl = Math.min(ttl, (win.from - w.sec) * 1000); break; }
  }
  return { phase: 'quiet', ttlMs: Math.max(1000, ttl) };
}

// ── calendar arithmetic on YYYY-MM-DD (pure dates, no timezone) ──────────────
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const pad = (n: number, w = 2) => String(n).padStart(w, '0');
export function shiftMonths(iso: string, k: number): string {
  const y = Number(iso.slice(0, 4)), m = Number(iso.slice(5, 7)), d = Number(iso.slice(8, 10));
  const t = y * 12 + (m - 1) + k;
  const ny = Math.floor(t / 12), nm = t - ny * 12 + 1;
  const dim = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${pad(ny, 4)}-${pad(nm)}-${pad(Math.min(d, dim))}`;
}
function shiftDays(iso: string, k: number): string {
  const t = Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) + k * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

// ── parsers ──────────────────────────────────────────────────────────────────
// FRED fredgraph.csv: `observation_date,SERIES` (older files: `DATE,SERIES`).
// A missing observation is "." (documented) — and, MEASURED 2026-09-30, the
// current endpoint writes an EMPTY field instead (`2026-09-07,` on Labor Day;
// `2025-10-01,` for the shutdown month's CPI and unemployment). Number('') is 0,
// so both markers are caught BEFORE Number(): a hole is a hole, never a 0% yield.
export function parseFredCsv(text: string): Obs[] {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
  const head = (lines[0] ?? '').split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
  if (head.length < 2 || !/^(observation_date|date)$/i.test(head[0])) throw new Error('FRED: not a series CSV');
  const byDate = new Map<string, number>();
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue; // trailing blank lines
    const cells = line.split(',');
    const d = (cells[0] ?? '').trim();
    const raw = (cells[1] ?? '').trim();
    if (!ISO_RE.test(d)) continue;
    const v = raw === '' || raw === '.' ? NaN : Number(raw);
    if (!Number.isFinite(v)) continue;
    byDate.set(d, v);
  }
  return [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

// A quote-aware CSV field splitter (Treasury quotes its header names).
function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '', q = false;
  for (const ch of line) {
    if (q) { if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}
function treasuryDate(s: string | undefined): string | null {
  const t = (s ?? '').trim();
  let y: number, m: number, d: number;
  let mm = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (mm) { m = +mm[1]; d = +mm[2]; y = +mm[3]; }
  else if ((mm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t))) { y = +mm[1]; m = +mm[2]; d = +mm[3]; }
  else return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

// Layout (documented, and VERIFIED against the live file fetched from Supabase on
// 2026-10-01 — tools/fixtures/econ/treasury-real-20260930-head.csv): a `Date` column
// (MM/DD/YYYY), then one column per tenor NAMED in the quoted header ("2 Yr",
// "10 Yr", "20 Yr", ...), newest row first; \n or \r\n line endings both parse. Columns are looked up BY NAME, never by position — Treasury
// inserted "1.5 Month" in 2025, which shifted every later column by one. A row
// dated after `today` (NY) is dropped (a day/month swap produces exactly that),
// as is any value outside a plausible yield range.
export function parseTreasuryCsv(text: string, today: string): Map<string, Obs[]> {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
  const head = splitCsv(lines[0] ?? '');
  if ((head[0] ?? '').toLowerCase() !== 'date') throw new Error('Treasury: not a par-yield CSV');
  const idx = new Map(head.map((h, i) => [h, i] as [string, number]));
  const cols = new Map<string, Map<string, number>>();
  for (const c of TREASURY_COLS) if (idx.has(c)) cols.set(c, new Map());
  if (!cols.size) throw new Error('Treasury: no known tenor column');
  for (const line of lines.slice(1)) {
    const cells = splitCsv(line);
    const d = treasuryDate(cells[0]);
    if (!d || d > today) continue;
    for (const [c, byDate] of cols) {
      const raw = (cells[idx.get(c)!] ?? '').trim();
      const v = raw === '' || raw.toUpperCase() === 'N/A' ? NaN : Number(raw);
      if (!Number.isFinite(v) || v < -5 || v > 30) continue;
      byDate.set(d, v);
    }
  }
  const out = new Map<string, Obs[]>();
  for (const [c, byDate] of cols) out.set(c, [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  return out;
}

// ── Treasury tail onto the FRED spine ────────────────────────────────────────
// PREFER Treasury only when it is newer than FRED's newest observation, and only
// when it AGREES with FRED on every date both carry (the guard against a future
// layout change: a misread column cannot agree with FRED by accident). No
// overlap = nothing to cross-check = not used. Only STRICTLY newer dates are
// appended, so the result has no duplicate and no out-of-order date.
export function stitchTreasury(spine: Obs[], tail: Obs[] | null | undefined):
  { obs: Obs[]; fromTreasury: number; reason: string | null } {
  if (!tail || !tail.length) return { obs: spine, fromTreasury: 0, reason: tail ? 'treasury: column empty' : null };
  if (!spine.length) return { obs: spine, fromTreasury: 0, reason: 'treasury: no FRED spine to cross-check' };
  const fredLast = spine[spine.length - 1][0];
  const fred = new Map(spine);
  let overlap = 0;
  for (const [d, v] of tail) {
    const f = fred.get(d);
    if (f === undefined) continue;
    overlap++;
    if (Math.abs(f - v) > TREASURY_TOL) return { obs: spine, fromTreasury: 0, reason: `treasury disagrees with FRED on ${d}` };
  }
  if (!overlap) return { obs: spine, fromTreasury: 0, reason: 'treasury: no overlap with FRED to cross-check' };
  const newer = tail.filter(([d]) => d > fredLast);
  if (!newer.length) return { obs: spine, fromTreasury: 0, reason: null };
  return { obs: spine.concat(newer), fromTreasury: newer.length, reason: null };
}

// ── transforms: computed POINT BY POINT, never interpolated ──────────────────
// yoy/mom are % changes against the observation 12 (or 1) months earlier. For a
// monthly/quarterly series the base must exist on that EXACT date — a missing
// base month (2025-10, the shutdown month) yields NO point rather than a guess.
// Daily/weekly series take the last observation on or before the target date,
// within 7 days.
function onOrBefore(obs: Obs[], target: string, maxDays: number): number | undefined {
  let lo = 0, hi = obs.length - 1, hit = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (obs[mid][0] <= target) { hit = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (hit < 0 || obs[hit][0] < shiftDays(target, -maxDays)) return undefined;
  return obs[hit][1];
}
export function transformSeries(obs: Obs[], transform: Transform, cadence: Cadence): Obs[] {
  if (transform === 'level') return obs;
  const exact = new Map(obs);
  const back = transform === 'yoy' ? -12 : -1;
  const out: Obs[] = [];
  for (const [d, v] of obs) {
    const baseDate = shiftMonths(d, back);
    const base = cadence === 'monthly' || cadence === 'quarterly' ? exact.get(baseDate) : onOrBefore(obs, baseDate, 7);
    if (base === undefined || !(base > 0)) continue;
    const pct = (v / base - 1) * 100;
    if (Number.isFinite(pct)) out.push([d, pct]);
  }
  return out;
}

// ── ranges, slicing, downsampling ────────────────────────────────────────────
// The span is measured back from the row's OWN newest observation (a lagging
// series still shows a full window), start inclusive. Validated against this
// allowlist; an unknown token degrades to DEFAULT_RANGE (desk-watchlist rule).
const RANGES: Record<string, { days?: number; months?: number }> = {
  '1w': { days: 7 }, '1m': { months: 1 }, '3m': { months: 3 },
  '6m': { months: 6 }, '1y': { months: 12 }, '5y': { months: 60 },
};
const DEFAULT_RANGE = '3m';
export const rangeKey = (raw: unknown): string =>
  typeof raw === 'string' && Object.hasOwn(RANGES, raw) ? raw : DEFAULT_RANGE;

// Keeps the first and last point plus the min and max of each of 59 equal
// buckets in between: <= 120 points, every one of them a REAL observation, and
// every local extreme a bucket can hold survives (a spike is never averaged away).
export function downsample(pts: Obs[], max = MAX_POINTS): Obs[] {
  const n = pts.length;
  if (n <= max) return pts.slice();
  const keep = new Set<number>([0, n - 1]);
  const buckets = Math.floor((max - 2) / 2);
  const inner = n - 2;
  for (let b = 0; b < buckets; b++) {
    const lo = 1 + Math.floor((b * inner) / buckets);
    const hi = 1 + Math.floor(((b + 1) * inner) / buckets);
    if (hi <= lo) continue;
    let mn = lo, mx = lo;
    for (let i = lo; i < hi; i++) {
      if (pts[i][1] < pts[mn][1]) mn = i;
      if (pts[i][1] > pts[mx][1]) mx = i;
    }
    keep.add(mn);
    keep.add(mx);
  }
  return [...keep].sort((a, b) => a - b).map((i) => pts[i]);
}

// GRANULARITY: one observation per business day (yields) or per month (jobs,
// inflation) is the finest data that EXISTS. A span holding fewer than
// MIN_POINTS observations returns the latest MIN_POINTS instead and says so in
// `note`; fewer than 2 observations in total draws nothing.
export function pointsFor(series: Obs[], range: string, cadence: Cadence): { points: Obs[]; note: string | null } {
  if (series.length < 2) return { points: [], note: null };
  const last = series[series.length - 1][0];
  const r = RANGES[range] ?? RANGES[DEFAULT_RANGE];
  const start = r.days ? shiftDays(last, -r.days) : shiftMonths(last, -(r.months as number));
  let slice = series.filter(([d]) => d >= start);
  let note: string | null = null;
  if (slice.length < MIN_POINTS) {
    slice = series.slice(-MIN_POINTS);
    note = `${cadence} - ${slice.length} latest`;
  }
  return { points: downsample(slice).map(([d, v]) => [d, Number(v.toFixed(4))] as Obs), note };
}

// ── upstream + module state ──────────────────────────────────────────────────
async function getText(url: string, ms: number): Promise<string> {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}
const msg = (e: unknown) => String((e as Error)?.message ?? e);

// Raw FRED history per series id, replaced only by a successful parse, so a
// failed refresh leaves the last good history in place (stale-while-error).
const fredStore = new Map<string, { at: number; obs: Obs[] }>();
// This request's working copy of the shared Treasury store (desk_feed_cache),
// set by every refresh() from the row it read (plus, for the lease holder, what it
// just fetched); null = no usable store this request. buildRow stitches from it.
let treasuryStore: { at: number; cols: Map<string, Obs[]> } | null = null;
// Newest (date|value) per row id as of the previous refresh — the `changed` bit.
const lastNewest = new Map<string, string>();

async function refreshFred(id: string, cosd: string): Promise<boolean> {
  try {
    const obs = parseFredCsv(await getText(`${FRED_CSV}?id=${encodeURIComponent(id)}&cosd=${cosd}`, FRED_TIMEOUT_MS));
    if (!obs.length) throw new Error('0 usable rows');
    fredStore.set(id, { at: Date.now(), obs });
    return true;
  } catch (e) {
    console.warn(`desk-econ: FRED ${id} failed: ${msg(e)}`);
    return false;
  }
}

// ── Treasury: one shared store, refreshed under a lease (v3, 2026-10-01) ─────
// MEASURED 2026-10-01: every desk-econ request runs on a FRESH instance, so the
// v2 idea of a per-instance background fetch could never be seen by a later
// request. The validated Treasury rows therefore live in desk_feed_cache under
// `econ:treasury`: payload { cols: {"2 Yr": [[date, value], ...], ...},
// fetchedAt (last successful merge), attemptedAt (last attempt start = the
// lease), failedAt (last total failure, or null), lease (the holder's id) }.
// Every request reads it; at most one request per interval does the slow fetch.

type StoreRow = {
  cols: Map<string, Obs[]>; fetchedAt: number; attemptedAt: number; failedAt: number | null; lease: string | null;
};
const emptyRow = (): StoreRow => ({ cols: new Map(), fetchedAt: 0, attemptedAt: 0, failedAt: null, lease: null });

// Service-key headers for the desk_feed_cache REST calls. NO user-agent, ever (see UA).
function storeHeaders(): Record<string, string> {
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  return { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' };
}
// Logs must never carry the service key: a PostgREST error body can echo request context.
function scrubbed(s: unknown): string {
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const t = String(s);
  return key ? t.split(key).join('[key]') : t;
}

// The stored payload is UNTRUSTED: re-validated field by field, never thrown on.
// A foreign shape reads as an empty store (so the next lease rewrites it clean);
// a column keeps only known tenor names, ISO dates no later than today (NY) and no
// older than the 70-day window, and plausible yields. Even a well-formed but WRONG
// value cannot reach a reply: rows only ever use it through stitchTreasury.
function storeRowFrom(p: unknown, now: number, today: string): StoreRow {
  const row = emptyRow();
  if (!p || typeof p !== 'object' || Array.isArray(p)) return row;
  // deno-lint-ignore no-explicit-any
  const o = p as any;
  const stamp = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= now + STORE_SKEW_MS ? v : null);
  row.fetchedAt = stamp(o.fetchedAt) ?? 0;
  row.attemptedAt = stamp(o.attemptedAt) ?? 0;
  row.failedAt = stamp(o.failedAt);
  row.lease = typeof o.lease === 'string' ? o.lease.slice(0, 64) : null;
  const floor = shiftDays(today, -70);
  if (o.cols && typeof o.cols === 'object' && !Array.isArray(o.cols)) {
    for (const [c, obs] of Object.entries(o.cols)) {
      if (!TREASURY_COLS.has(c) || !Array.isArray(obs)) continue;
      const byDate = new Map<string, number>();
      for (const pt of obs) {
        if (!Array.isArray(pt) || pt.length !== 2) continue;
        const [d, v] = pt;
        if (typeof d !== 'string' || !ISO_RE.test(d) || d > today || d < floor) continue;
        if (typeof v !== 'number' || !Number.isFinite(v) || v < -5 || v > 30) continue;
        byDate.set(d, v);
      }
      if (byDate.size) row.cols.set(c, [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
    }
  }
  return row;
}

// Resolves null ONLY for "no row yet". A failed read (HTTP error, timeout, a body
// that is not a row list) THROWS — the caller treats that as "no store this
// request": FRED only, and no Treasury attempt (an attempt it could not record
// would be repeated by every request, each one ~20 s slow).
async function readTreasuryRow(now: number, today: string): Promise<StoreRow | null> {
  const url = Deno.env.get('SUPABASE_URL');
  if (!url) throw new Error('SUPABASE_URL is not set');
  const res = await fetch(`${url}/rest/v1/desk_feed_cache?select=at,payload&key=eq.${STORE_KEY}`,
    { headers: storeHeaders(), signal: AbortSignal.timeout(STORE_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error('unexpected body');
  return rows.length ? storeRowFrom(rows[0]?.payload, now, today) : null;
}
// An upsert of the WHOLE row (merge-duplicates replaces the payload column, so a
// write always carries the cols it means to keep). true = stored. Never throws.
async function writeTreasuryRow(row: StoreRow): Promise<boolean> {
  const url = Deno.env.get('SUPABASE_URL');
  if (!url) return false;
  try {
    const res = await fetch(`${url}/rest/v1/desk_feed_cache?on_conflict=key`, {
      method: 'POST',
      headers: { ...storeHeaders(), prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify([{
        key: STORE_KEY, at: new Date().toISOString(),
        payload: {
          cols: Object.fromEntries(row.cols), fetchedAt: row.fetchedAt, attemptedAt: row.attemptedAt,
          failedAt: row.failedAt, lease: row.lease,
        },
      }]),
      signal: AbortSignal.timeout(STORE_TIMEOUT_MS),
    });
    // fetch RESOLVES on 401/409/5xx: a rejected write must be visible, not swallowed.
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error(`desk-econ: Treasury store write failed HTTP ${res.status} ${scrubbed(detail).slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`desk-econ: Treasury store write failed ${scrubbed(msg(e))}`);
    return false;
  }
}

// Both months, in parallel; a month that fails is logged and skipped.
async function fetchTreasuryMonths(today: string): Promise<Map<string, Obs[]>[]> {
  const months = [today.slice(0, 7), shiftMonths(today, -1).slice(0, 7)].map((m) => m.replace('-', ''));
  const parsed = await Promise.all(months.map((m) =>
    getText(treasuryCsvUrl(m), TREASURY_TIMEOUT_MS)
      .then((t) => parseTreasuryCsv(t, today))
      .catch((e) => { console.warn(`desk-econ: Treasury ${m} failed: ${msg(e)}`); return null; })));
  return parsed.filter((p): p is Map<string, Obs[]> => p !== null);
}
// Union per column (a later source wins a date), pruned to the 70 days no FRED lag
// could ever need. `kept` first, then `good` with the CURRENT month last, so it wins.
function mergeTreasury(kept: Map<string, Obs[]> | null, good: Map<string, Obs[]>[], today: string): Map<string, Obs[]> {
  const floor = shiftDays(today, -70);
  const merged = new Map<string, Map<string, number>>();
  for (const src of [...(kept ? [kept] : []), ...good.slice().reverse()]) {
    for (const [c, obs] of src) {
      const m = merged.get(c) ?? new Map<string, number>();
      for (const [d, v] of obs) if (d >= floor) m.set(d, v);
      merged.set(c, m);
    }
  }
  const cols = new Map<string, Obs[]>();
  for (const [c, m] of merged) cols.set(c, [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  return cols;
}

// Treasury posts the day's rate from about 15:30 ET (2026-09-30's was out by ~20:50
// ET at the latest); from the afternoon window's opening to midnight NY, a missing
// today's row is worth one attempt every 5 minutes. Weekends never post.
function treasuryPosting(ms: number): boolean {
  const w = nyWall(ms);
  return w.dow !== 'Sat' && w.dow !== 'Sun' && w.sec >= WINDOWS[1].from;
}
// Today's rate is held — and FINAL — when every Treasury column the roster names
// has an observation dated today (NY) that agrees with this request's FRED (a
// column with no FRED spine this request cannot be checked, so its date decides).
function treasuryHeld(row: StoreRow, rows: RosterRow[], today: string): boolean {
  return rows.every((r) => {
    if (!r.treasury) return true;
    const col = row.cols.get(r.treasury);
    if (!col || col[col.length - 1][0] !== today) return false;
    const spine = fredStore.get(r.fred)?.obs;
    return !spine || stitchTreasury(spine, col).reason === null;
  });
}
// The opening of the most recent posting window at or before `ms` — a weekday at
// 15:25 ET: on a weekday before 15:25 it is the previous weekday's, on Sat/Sun and on
// Monday before 15:25 it is Friday's. Walks back one NY day at a time from just before
// each local midnight, so a DST Sunday (23 or 25 h long) cannot trip it.
function lastPostingStart(ms: number): number {
  let t = ms;
  for (let i = 0; i < 9; i++) {
    const w = nyWall(t);
    if (w.dow !== 'Sat' && w.dow !== 'Sun' && w.sec >= WINDOWS[1].from) return t - (w.sec - WINDOWS[1].from) * 1000;
    t -= (w.sec + 1) * 1000;   // the previous NY day, 23:59:59
  }
  return 0;
}
// Whether THIS request should attempt a fetch, judged on the shared row (never on
// instance memory). attemptedAt is the lease: one attempt per interval, whichever
// instance makes it; failedAt is a 10-minute back-off every instance honours.
function treasuryWanted(now: number, today: string, rows: RosterRow[], row: StoreRow): boolean {
  // No FRED spine for any Treasury row this request: a fetched file could not be
  // checked, so it could not be stored — do not spend ~20 s (or a lease) on it.
  if (!rows.some((r) => r.treasury && fredStore.has(r.fred))) return false;
  if (row.failedAt !== null && now - row.failedAt < TREASURY_BACKOFF_MS) return false; // backing off
  if (treasuryPosting(now)) {
    if (treasuryHeld(row, rows, today)) return false;                                // today's rate is final
    return now - row.attemptedAt >= TREASURY_POSTING_EVERY_MS;                       // the lease is free
  }
  // Outside the window nothing can have been published since it last opened: ask only
  // if no fetch has SUCCEEDED since then (an empty store has fetchedAt 0, so the first
  // request after a deploy asks at once). A host that keeps failing is asked hourly.
  if (row.fetchedAt >= lastPostingStart(now)) return false;
  return now - row.attemptedAt >= TREASURY_IDLE_EVERY_MS;
}
const working = (row: StoreRow) => ({ at: row.fetchedAt, cols: row.cols });

// One request's Treasury step, run AFTER the FRED sweep (it validates against
// FRED) on the row read beside that sweep. Never throws. Usually it just hands the
// store to buildRow. When an attempt is due it takes the lease, fetches AWAITED —
// on purpose: detached background work proved unreliable on this runtime
// (desk-heatmap), and a fresh instance would never see its result anyway — so
// THIS reply already carries what it fetched. Every other request meanwhile finds
// the lease taken and serves the store as it is.
async function treasuryCycle(now: number, today: string, rows: RosterRow[], seen: StoreRow): Promise<{ at: number; cols: Map<string, Obs[]> }> {
  if (!treasuryWanted(now, today, rows, seen)) return working(seen);
  // Re-read just before taking the lease: the first read ran beside the FRED
  // sweep, and another instance may have taken the lease since.
  const latest = await readTreasuryRow(now, today).then((r) => r ?? emptyRow(), () => null);
  if (!latest) return working(seen);
  if (!treasuryWanted(now, today, rows, latest)) return working(latest);
  const lease: StoreRow = { ...latest, attemptedAt: now, lease: `${now}-${Math.random().toString(36).slice(2, 10)}` };
  // The lease is written BEFORE the fetch. If it cannot be written, do not fetch:
  // an attempt nobody can see would be repeated by every request, ~20 s each.
  if (!(await writeTreasuryRow(lease))) return working(latest);
  // Confirm it is ours: two instances that both read a free lease both write one,
  // and only the last write survives — the other backs off here.
  const mine = await readTreasuryRow(now, today).catch(() => null);
  if (!mine || mine.lease !== lease.lease) return working(mine ?? latest);
  const good = await fetchTreasuryMonths(today);
  // Validate BEFORE writing: only a column that parsed AND agrees with this
  // request's FRED (stitchTreasury's own check) is stored. A blocked, HTML or
  // mislabelled file never reaches the store.
  const fetched = mergeTreasury(null, good, today);
  const agreed = new Map<string, Obs[]>();
  for (const r of rows) {
    if (!r.treasury) continue;
    const col = fetched.get(r.treasury);
    const spine = fredStore.get(r.fred)?.obs;
    if (!col || !spine) continue;
    const s = stitchTreasury(spine, col);
    if (s.reason === null) agreed.set(r.treasury, col);
    else console.warn(`desk-econ: Treasury ${r.treasury} not stored: ${s.reason}`);
  }
  // Re-read before writing: in the rare race where two instances both won a lease,
  // the other may have stored rows since ours — a write here must not undo them.
  const cur = await readTreasuryRow(now, today).catch(() => null);
  if (!agreed.size) {
    // Nothing usable: record the failure so EVERY instance backs off for 10 min —
    // but only while the lease is still ours. If anyone has written since, their
    // row is the fresher truth: serve it, and never overwrite it with a failure.
    if (cur?.lease === lease.lease) await writeTreasuryRow({ ...cur, failedAt: Date.now() });
    return working(cur ?? latest);
  }
  const base = cur ?? latest;   // a success merges onto whatever is stored NOW
  const kept = now - base.fetchedAt < TREASURY_KEEP_MS ? base.cols : null;
  const next: StoreRow = { cols: mergeTreasury(kept, [agreed], today), fetchedAt: Date.now(), attemptedAt: now, failedAt: null, lease: lease.lease };
  await writeTreasuryRow(next);   // best effort: a failed write still serves THIS reply
  return working(next);
}

type Status = 'ok' | 'stale' | 'missing';
type RowFull = RosterRow & {
  series: Obs[]; source: 'treasury' | 'fred' | null; status: Status; fetchedAt: number | null; changed: boolean;
};
type Dataset = {
  fetchedAt: number; expiresAt: number; phase: string; rows: RowFull[];
  roster: { source: 'config' | 'default'; count: number; dropped: number };
};
// Per-instance cache + single-flight: kept because they are free and correct, but
// best effort only — every request was MEASURED (2026-10-01) to land on a fresh
// instance, so in practice each request sweeps FRED.
let dataset: Dataset | null = null;
let inflight: Promise<Dataset> | null = null; // single-flight: a concurrent burst shares one sweep

function buildRow(r: RosterRow, freshNow: boolean, now: number): RowFull {
  const stored = fredStore.get(r.fred);
  const missing: RowFull = { ...r, series: [], source: null, status: 'missing', fetchedAt: null, changed: false };
  // Treasury is never served alone: without a FRED spine it cannot be
  // cross-checked, and the cross-check is what makes a misread column harmless.
  if (!stored) return missing;
  let spine = stored.obs;
  let fromTreasury = 0;
  if (r.treasury) {
    const keep = treasuryStore && now - treasuryStore.at < TREASURY_KEEP_MS ? treasuryStore.cols.get(r.treasury) : null;
    const s = stitchTreasury(spine, keep);
    if (s.reason) console.warn(`desk-econ: ${r.id}: ${s.reason} — FRED only`);
    spine = s.obs;
    fromTreasury = s.fromTreasury;
  }
  const series = transformSeries(spine, r.transform, r.cadence);
  if (!series.length) return missing;
  const [d, v] = series[series.length - 1];
  const key = `${d}|${v}`;
  const before = lastNewest.get(r.id);
  lastNewest.set(r.id, key);
  return {
    ...r, series,
    source: fromTreasury > 0 ? 'treasury' : 'fred',
    status: freshNow ? 'ok' : 'stale',
    fetchedAt: stored.at,
    // Best effort, per isolate: a cold isolate has nothing to compare with and
    // honestly says false — and since every request MEASURED on 2026-10-01 ran on a
    // fresh instance, it is false in practice; the client's NEW marker (from asOf)
    // is what actually works.
    changed: before !== undefined && before !== key,
  };
}

async function refresh(): Promise<Dataset> {
  const now = Date.now();
  const roster = await loadRoster(now);
  const today = nyWall(now).date;
  const cosd = shiftMonths(today, -HISTORY_MONTHS);
  const ids = [...new Set(roster.rows.map((r) => r.fred))];
  // The shared Treasury row is read BESIDE the FRED sweep (no added latency); a
  // failed read is "no store this request" — FRED only, no Treasury attempt.
  const wantsTreasury = roster.rows.some((r) => r.treasury);
  const [fresh, seen] = await Promise.all([
    Promise.all(ids.map(async (id) => [id, await refreshFred(id, cosd)] as [string, boolean])).then((p) => new Map(p)),
    wantsTreasury
      ? readTreasuryRow(now, today).then((r) => r ?? emptyRow(), (e) => {
        console.warn(`desk-econ: Treasury store read failed (${scrubbed(msg(e))}) — FRED only`);
        return null;
      })
      : Promise.resolve(null),
  ]);
  // After FRED (the step validates against it). Usually instant; the one request
  // holding the lease waits here for Treasury, and its reply carries the result.
  treasuryStore = seen ? await treasuryCycle(now, today, roster.rows, seen) : null;
  const rows = roster.rows.map((r) => buildRow(r, fresh.get(r.fred) === true, now));
  const policy = refreshPolicy(now);
  const degraded = rows.some((r) => r.status !== 'ok');
  const ttl = degraded ? Math.min(policy.ttlMs, DEGRADED_TTL_MS) : policy.ttlMs;
  const fetchedAt = Date.now();
  const ds: Dataset = {
    fetchedAt, expiresAt: fetchedAt + ttl, phase: policy.phase, rows,
    roster: { source: roster.source, count: roster.rows.length, dropped: roster.dropped },
  };
  dataset = ds;
  return ds;
}

const roundTo = (v: number, dec: number) => Number(v.toFixed(dec));

// The per-request view: the cached dataset SLICED to `range` — another span is
// a slice, never an upstream call. `wholeStale` marks the path where the whole
// refresh threw and the last good dataset is served instead.
function shape(ds: Dataset, range: string, now: number, wholeStale = false) {
  const rows = ds.rows.map((r) => {
    const status: Status = wholeStale && r.status === 'ok' ? 'stale' : r.status;
    const n = r.series.length;
    const last = n ? r.series[n - 1] : null;
    const prev = n > 1 ? r.series[n - 2] : null;
    // Absent is NEVER 0: every unknown is null.
    const value = last ? roundTo(last[1], r.decimals) : null;
    const prevV = prev ? roundTo(prev[1], r.decimals) : null;
    const delta = value !== null && prevV !== null ? roundTo(value - prevV, r.decimals) : null;
    const { points, note } = pointsFor(r.series, range, r.cadence);
    const row: Record<string, unknown> = {
      id: r.id, label: r.label, unit: r.unit, decimals: r.decimals, transform: r.transform, cadence: r.cadence,
      value, prev: prevV, delta,
      asOf: last ? last[0] : null, prevAsOf: prev ? prev[0] : null,
      source: last ? r.source : null,
      status, changed: r.changed,
      staleSec: status === 'stale' && r.fetchedAt !== null ? Math.max(0, Math.round((now - r.fetchedAt) / 1000)) : null,
      points,
    };
    if (note) row.pointsNote = note;
    return row;
  });
  const ok = rows.some((r) => r.status !== 'missing');
  const stale = rows.filter((r) => r.status === 'stale').map((r) => r.staleSec as number);
  const refreshInSec = wholeStale
    ? Math.ceil(DEGRADED_TTL_MS / 1000)
    : Math.max(MIN_REFRESH_SEC, Math.ceil((ds.expiresAt - now) / 1000));
  return {
    ok,
    // Per request (desk-charts rule): the client measures poller health on it.
    generatedAt: new Date(now).toISOString(),
    fetchedAt: new Date(ds.fetchedAt).toISOString(),
    range, refreshInSec, phase: ds.phase,
    stale: stale.length > 0,
    staleSec: stale.length ? Math.max(...stale) : null,
    roster: ds.roster,
    rows,
    ...(ok ? {} : { error: 'no economic series available from upstream' }),
  };
}

// `force` ("Refresh now") is anon-callable and re-sweeps every series: honoured
// at most once per 30s per isolate, the stamp handed back when it fails. Per
// isolate = best effort only: every request was MEASURED (2026-10-01) to land on a
// fresh instance, so this guard rarely holds. The cost it bounds is FRED's (a
// forced request does not bypass the shared Treasury lease).
let lastForceAt = 0;

async function handle(req: Request, allowed: boolean, cors: Record<string, string>): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (!allowed) return reply(403, { ok: false, error: 'forbidden origin' }, cors);
  if (req.method !== 'POST') return reply(405, { ok: false, error: 'POST only' }, cors);

  const body = await req.json().catch(() => ({}));
  const range = rangeKey(body?.range);
  let force = body?.force === true;
  let stampedFrom: number | null = null;
  const now = Date.now();
  if (force) {
    if (now - lastForceAt >= FORCE_MIN_GAP_MS) { stampedFrom = lastForceAt; lastForceAt = now; }
    else force = false;
  }

  // One status rule on every path: 200 while any row has data, else 502 (a
  // cached all-missing dataset must not turn into a 200 on the second call).
  const send = (out: ReturnType<typeof shape>) => reply(out.ok ? 200 : 502, out, cors);
  if (!force && dataset && now < dataset.expiresAt) return send(shape(dataset, range, now));

  const previous = dataset;
  try {
    inflight ??= refresh().finally(() => { inflight = null; });
    const ds = await inflight;
    const out = shape(ds, range, Date.now());
    if (!out.ok && stampedFrom !== null) lastForceAt = stampedFrom;
    return send(out);
  } catch (e) {
    console.error('desk-econ: refresh threw', msg(e));
    if (stampedFrom !== null) lastForceAt = stampedFrom;
    // Stale-while-error: the last good body, flagged, never a blank panel.
    if (previous) return send(shape(previous, range, Date.now(), true));
    return reply(502, { ok: false, error: 'econ feed unavailable — try again' }, cors);
  }
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get('origin') ?? '';
  const allowed = ALLOWED_ORIGINS.has(origin);
  const cors = corsHeaders(origin, allowed);
  try {
    return await handle(req, allowed, cors);
  } catch (e) {
    // Always JSON with the CORS headers: a bare platform 500 reads as a CORS
    // failure in the browser, indistinguishable from a blocked origin.
    console.error('desk-econ: unhandled', msg(e));
    return reply(502, { ok: false, error: 'econ feed failed — try again' }, cors);
  }
});
