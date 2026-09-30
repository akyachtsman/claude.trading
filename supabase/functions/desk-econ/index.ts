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
//     CLOSE the same afternoon (~15:30-18:00 ET), never intraday. UNVERIFIED-AGAINST-LIVE:
//     home.treasury.gov was unreachable from the build sandbox (proxy policy),
//     so its parser was written against the documented layout and exercised on
//     CONSTRUCTED fixtures only. It is therefore never trusted on its own: a
//     Treasury observation is used only when it is NEWER than FRED's newest AND
//     the Treasury file agrees with FRED on every date the two share. Any fetch,
//     parse or agreement failure falls back to FRED automatically.
//
// Anon-callable PUBLIC feed, same family as desk-market / desk-maps: no caller
// input reaches an upstream URL (the roster is committed config, validated here;
// `range` is an allowlist token that only selects a slice of cached data). No
// service key, no database, no secrets. CORS is the quote-proxy ORIGIN ALLOWLIST
// (site origin only) — a browser-enforced speed-bump, not an auth wall.

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
// config) and nothing else. This function makes no Supabase REST call; if one is
// ever added it must NOT carry this header (CLAUDE.md: a browser-shaped UA makes
// the gateway refuse an sb_secret key with a 401 that a catch swallows).
const UA = { 'user-agent': 'Mozilla/5.0 (desk econ; +https://akyachtsman.github.io/claude.trading/)' };
const CONFIG_URL = 'https://akyachtsman.github.io/claude.trading/config/econ-indicators.json';
const FRED_CSV = 'https://fred.stlouisfed.org/graph/fredgraph.csv';
// UNVERIFIED-AGAINST-LIVE: the documented month-scoped CSV download of the par
// yield curve. Fetched for the current AND previous NY month so the tail never
// falls into a month boundary (FRED can lag across the 1st).
const treasuryCsvUrl = (yyyymm: string) =>
  'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/all/'
  + `${yyyymm}?type=daily_treasury_yield_curve&field_tdr_date_value_month=${yyyymm}&page&_format=csv`;

// Deno's fetch has no default timeout: every upstream call is bounded, so a
// stalled host costs its own row, never the invocation. The signal also bounds
// the body read (res.text()).
const CONFIG_TIMEOUT_MS = 5_000;
const FRED_TIMEOUT_MS = 8_000;
const TREASURY_TIMEOUT_MS = 5_000;
const CONFIG_TTL_MS = 3_600_000;       // same as desk-charts' roster: edits land within the hour
const TREASURY_BACKOFF_MS = 600_000;   // after a failed Treasury fetch, do not retry for 10 min
const TREASURY_KEEP_MS = 72 * 3_600_000; // a validated Treasury observation is a fact; keep it 72h
const TREASURY_TOL = 0.015;            // both publish 2 decimals: "agree" = equal after float noise

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
// a day behind its neighbours). Treasury's par-yield file is an END-OF-DAY close
// posted ~15:30-18:00 ET: same day AFTER the close, never intraday. The path is
// UNVERIFIED against the live host (tested on constructed fixtures only), which is
// why stitchTreasury uses it only when it agrees with FRED and is newer; any failure
// is a silent per-row fallback to FRED (the row's `source` says which). This roster
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

// UNVERIFIED-AGAINST-LIVE. Documented layout: a `Date` column (MM/DD/YYYY),
// then one column per tenor NAMED in the header ("2 Yr", "10 Yr", "20 Yr", ...),
// newest row first. Columns are looked up BY NAME, never by position — Treasury
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
// when it AGREES with FRED on every date both carry (this is the guard for an
// unverified parser: a misread column cannot agree with FRED by accident). No
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
// Validated Treasury observations per tenor column, merged across fetches.
let treasuryStore: { at: number; cols: Map<string, Obs[]> } | null = null;
let treasuryDownUntil = 0;
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

async function refreshTreasury(now: number, today: string): Promise<void> {
  if (now < treasuryDownUntil) return; // backing off: a blocked host must not tax every refresh
  const months = [today.slice(0, 7), shiftMonths(today, -1).slice(0, 7)].map((m) => m.replace('-', ''));
  const parsed = await Promise.all(months.map((m) =>
    getText(treasuryCsvUrl(m), TREASURY_TIMEOUT_MS)
      .then((t) => parseTreasuryCsv(t, today))
      .catch((e) => { console.warn(`desk-econ: Treasury ${m} failed: ${msg(e)}`); return null; })));
  const good = parsed.filter((p): p is Map<string, Obs[]> => p !== null);
  if (!good.length) { treasuryDownUntil = now + TREASURY_BACKOFF_MS; return; }
  // Merge into what is kept (newer fetch wins a date), pruning anything older
  // than the 70 days no FRED lag could ever need.
  const floor = shiftDays(today, -70);
  const merged = new Map<string, Map<string, number>>();
  const keptFresh = treasuryStore && now - treasuryStore.at < TREASURY_KEEP_MS;
  for (const src of [...(keptFresh ? [treasuryStore!.cols] : []), ...good.reverse()]) {
    for (const [c, obs] of src) {
      const m = merged.get(c) ?? new Map<string, number>();
      for (const [d, v] of obs) if (d >= floor) m.set(d, v);
      merged.set(c, m);
    }
  }
  const cols = new Map<string, Obs[]>();
  for (const [c, m] of merged) cols.set(c, [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  treasuryStore = { at: Date.now(), cols };
}

type Status = 'ok' | 'stale' | 'missing';
type RowFull = RosterRow & {
  series: Obs[]; source: 'treasury' | 'fred' | null; status: Status; fetchedAt: number | null; changed: boolean;
};
type Dataset = {
  fetchedAt: number; expiresAt: number; phase: string; rows: RowFull[];
  roster: { source: 'config' | 'default'; count: number; dropped: number };
};
let dataset: Dataset | null = null;
let inflight: Promise<Dataset> | null = null; // single-flight: a concurrent burst shares one sweep

function buildRow(r: RosterRow, freshNow: boolean, now: number): RowFull {
  const stored = fredStore.get(r.fred);
  const missing: RowFull = { ...r, series: [], source: null, status: 'missing', fetchedAt: null, changed: false };
  // Treasury is never served alone: without a FRED spine it cannot be
  // cross-checked, and its parser is unverified against the live host.
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
    // honestly says false.
    changed: before !== undefined && before !== key,
  };
}

async function refresh(): Promise<Dataset> {
  const now = Date.now();
  const roster = await loadRoster(now);
  const today = nyWall(now).date;
  const cosd = shiftMonths(today, -HISTORY_MONTHS);
  const ids = [...new Set(roster.rows.map((r) => r.fred))];
  const [fresh] = await Promise.all([
    Promise.all(ids.map(async (id) => [id, await refreshFred(id, cosd)] as [string, boolean])).then((p) => new Map(p)),
    roster.rows.some((r) => r.treasury) ? refreshTreasury(now, today) : Promise.resolve(),
  ]);
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
// at most once per 30s per isolate, the stamp handed back when it fails.
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
