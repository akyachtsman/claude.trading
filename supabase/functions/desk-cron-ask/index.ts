// ── desk-cron-ask — the desk wakes itself up and asks its own questions ──────
//
// Owner ruling 2026-08-11: "the only value a cron task has for me is to be able
// to wake ITSELF up at a certain time each day and give me a market summary."
// The old scheduler was a setInterval in app.js, so it only ran while the tab
// was open — which is precisely the case where the owner is already at the desk
// and could just type the question.
//
// This runs on pg_cron every 5 minutes, finds whichever roster row in
// desk_ask_schedule is due (Pacific wall clock — see dueSlot below), assembles
// the WHOLE dashboard as context server-side, and hands it to desk-ask. The
// answer is appended to desk_chat_memory by desk-ask itself, which is the same
// table the Ask thread replays from — so the 8am summary is sitting there when
// the desk is opened. It is ALSO emailed (see sendBrief), which is what reaches
// the owner when they are not at the desk.
//
// NOT public surface: requires the x-cron-secret header (CRON_SECRET env), the
// same gate desk-ibkr-sync and desk-brief use.
//
// Secrets (function env): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// SUPABASE_ANON_KEY, CRON_SECRET, and — for delivery — RESEND_API_KEY +
// DESK_EMAIL_TO (DESK_EMAIL_FROM optional, defaults to onboarding@resend.dev).
// The address lives in env, never in this repo: the repo is public.

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const PT = 'America/Los_Angeles';

// How late a missed slot may still fire. pg_cron ticking every 5 minutes will
// normally land inside the slot's own minute, but a cron hiccup, a cold isolate
// or a slow upstream should not silently drop the morning summary altogether —
// 90 minutes late is still useful, three hours late is a different question.
// It doubles as the guard against a NEWLY ADDED row back-firing: a row written
// at 10am for an 8am slot is 120 minutes behind and waits for tomorrow.
const CATCHUP_MIN = 90;

// ONE row per tick, never a burst. Two rows coming due together would fire
// back-to-back Claude tool loops; the second simply lands on the next 5-minute
// tick, which is invisible against a schedule measured in hours.
const MAX_PER_TICK = 1;

type Row = {
  id: number;
  prompt: string;
  cadence: 'hourly' | 'every_n_hours' | 'daily' | 'weekdays';
  every_hours: number;
  at_hour: number;
  at_min: number;
  market_only: boolean;
  enabled: boolean;
  last_run_at: string | null;
};

// ── Pacific wall clock ───────────────────────────────────────────────────────
// Resolved through Intl rather than a UTC offset, so DST is handled by the
// timezone database: an 8:00am row is 8:00am in July and 8:00am in January.
// ONE hoisted formatter — building an ICU formatter per call is what cost
// desk-charts its whole CPU budget (2026-08-05).
const PT_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: PT, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
});

type Pt = { date: string; hour: number; min: number; weekday: string };

function ptParts(d: Date): Pt {
  const p: Record<string, string> = {};
  for (const part of PT_FMT.formatToParts(d)) p[part.type] = part.value;
  // en-CA with hour12:false renders midnight as "24" in some ICU builds.
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hour: Number(p.hour) % 24,
    min: Number(p.minute),
    weekday: p.weekday,
  };
}

const isWeekday = (pt: Pt) => pt.weekday !== 'Sat' && pt.weekday !== 'Sun';

// Pre-market open (4:00am ET = 1:00am PT) through the after-hours close
// (8:00pm ET = 5:00pm PT). Exchange HOLIDAYS are not excluded: this is a noise
// filter on the roster, not a trading calendar, and saying so beats implying a
// precision it does not have.
const marketWindow = (pt: Pt) => isWeekday(pt) && pt.hour >= 1 && pt.hour < 17;

/* The slot (minutes since PT midnight) this row is currently owed, or null if
   it owes nothing right now. Deliberately expressed in wall-clock minutes
   rather than absolute instants: constructing an instant from a PT wall time is
   ambiguous on the two DST days a year, whereas "has the clock passed 8:00 and
   did we already answer at or after 8:00 today" is exact on every day. */
function dueSlot(row: Row, pt: Pt, lastPt: Pt | null): number | null {
  if (!row.enabled) return null;
  if (row.market_only && !marketWindow(pt)) return null;

  const nowMin = pt.hour * 60 + pt.min;
  let slot: number | null = null;

  if (row.cadence === 'daily' || row.cadence === 'weekdays') {
    if (row.cadence === 'weekdays' && !isWeekday(pt)) return null;
    slot = row.at_hour * 60 + row.at_min;
    if (nowMin < slot) return null;                 // not there yet today
  } else {
    const step = row.cadence === 'hourly' ? 1 : row.every_hours;
    for (let h = pt.hour; h >= 0; h--) {
      if (h % step !== 0) continue;
      const s = h * 60 + row.at_min;
      if (s <= nowMin) { slot = s; break; }
    }
    if (slot === null) return null;                 // before the day's first slot
  }

  if (nowMin - slot > CATCHUP_MIN) return null;     // too far behind to be useful

  if (lastPt) {
    // Already answered this slot (or a later one) on this PT day. The date
    // comparison is what makes a daily row fire exactly once: elapsed-time
    // arithmetic would drift an hour twice a year and either double-fire or
    // skip a day.
    if (lastPt.date > pt.date) return null;         // clock skew — do nothing
    if (lastPt.date === pt.date && lastPt.hour * 60 + lastPt.min >= slot) return null;
  }
  return slot;
}

// ── context assembly ────────────────────────────────────────────────────────
// The browser builds this from what is rendered (app.js buildAskContext). Here
// there is no browser, so every panel is re-derived from its own source. Each
// piece is best-effort: a feed that is down costs its own section, never the
// whole summary — an 8am brief that arrives without the heatmap is worth far
// more than one that does not arrive.

// deno-lint-ignore no-explicit-any
type Any = any;

async function liveFeed(name: string, body: Record<string, unknown> = {}): Promise<Any> {
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const anon = Deno.env.get('SUPABASE_ANON_KEY')!;
    const res = await fetch(`${url}/functions/v1/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: anon, authorization: `Bearer ${anon}` },
      body: JSON.stringify(body),
    });
    const out = await res.json().catch(() => null);
    return out?.ok ? out : null;
  } catch { return null; }
}

// Stochastic 14-3-3 (Pro 1 SWING) and 92-15-15 (Pro 2 LONG-TERM weekly-scale),
// plus RSI(14) Wilder — the SAME algorithms as scripts/data.js's stochSeries /
// rsiSeries and desk-ask's get_technicals, run over desk-charts' daily bars.
// Computed here rather than left to the model's get_technicals tool because the
// tool loop is capped at 12 calls and the charted roster is 25 symbols: a
// morning question about "the watchlist" would otherwise get oscillator
// readings for the first handful of names and silence for the rest.
const STOCH = { k: 14, kSmooth: 3, d: 3 };
const WSTOCH = { k: 92, kSmooth: 15, d: 15 };

type Bars = { t: string[]; o: number[]; h: number[]; l: number[]; c: number[]; v: number[] };

function stochLatest(s: Bars, cfg: { k: number; kSmooth: number; d: number }) {
  const n = s.c.length;
  const raw: (number | null)[] = new Array(n).fill(null);
  for (let i = cfg.k - 1; i < n; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - cfg.k + 1; j <= i; j++) { if (s.h[j] > hi) hi = s.h[j]; if (s.l[j] < lo) lo = s.l[j]; }
    raw[i] = hi === lo ? 50 : (s.c[i] - lo) / (hi - lo) * 100;
  }
  const sma = (arr: (number | null)[], len: number) => arr.map((_, i) => {
    if (i < len - 1) return null;
    let sum = 0;
    for (let j = i - len + 1; j <= i; j++) { if (arr[j] == null) return null; sum += arr[j] as number; }
    return sum / len;
  });
  const kLine = sma(raw, cfg.kSmooth);
  const dLine = sma(kLine, cfg.d);
  const r2 = (v: number | null) => (v == null ? null : Number(v.toFixed(2)));
  return { k: r2(kLine[n - 1]), d: r2(dLine[n - 1]) };
}

function rsiLatest(c: number[], len = 14): number | null {
  const n = c.length;
  if (n <= len) return null;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= len; i++) {
    const diff = c[i] - c[i - 1];
    if (diff >= 0) avgGain += diff; else avgLoss -= diff;
  }
  avgGain /= len; avgLoss /= len;
  let rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = len + 1; i < n; i++) {
    const diff = c[i] - c[i - 1];
    avgGain = (avgGain * (len - 1) + Math.max(diff, 0)) / len;
    avgLoss = (avgLoss * (len - 1) + Math.max(-diff, 0)) / len;
    rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return Number(rsi.toFixed(2));
}

function technicalsFrom(charts: Any): Any {
  const syms = charts?.symbols;
  if (!syms) return null;
  const out: Any[] = [];
  for (const sym of Object.keys(syms)) {
    const s = syms[sym] as Bars;
    if (!s?.c?.length) continue;
    const swing = stochLatest(s, STOCH);
    const long = s.c.length >= WSTOCH.k + WSTOCH.kSmooth + WSTOCH.d ? stochLatest(s, WSTOCH) : { k: null, d: null };
    out.push({
      sym,
      lastClose: Number(s.c[s.c.length - 1].toFixed(2)),
      // Named for the panes the owner reads them on, so the model can say
      // "Pro 2 is crossed down" rather than inventing its own vocabulary.
      pro1SwingStochK: swing.k, pro1SwingStochD: swing.d, pro1Scale: 'STOCH 14-3-3 · DAILY',
      pro2LongStochK: long.k, pro2LongStochD: long.d, pro2Scale: 'STOCH 92-15-15 · WEEKLY-SCALE',
      rsi14: rsiLatest(s.c),
    });
  }
  return out.length ? { asOf: charts.asOf ?? null, count: out.length, readings: out } : null;
}

function heatmapFrom(hm: Any): Any {
  if (!hm || !Array.isArray(hm.sectors)) return null;
  const tiles: Any[] = [];
  const sectors: Any[] = [];
  for (const sec of hm.sectors) {
    const list = (sec.tiles || []).filter((t: Any) => Number.isFinite(t.pct));
    if (!list.length) continue;
    const avg = list.reduce((a: number, t: Any) => a + t.pct, 0) / list.length;
    sectors.push({ name: sec.name, avgChgPct: Number(avg.toFixed(2)), names: list.length });
    for (const t of list) tiles.push({ sym: t.sym, chgPct: t.pct, sector: sec.name });
  }
  if (!sectors.length) return null;
  const byMove = [...tiles].sort((a, b) => b.chgPct - a.chgPct);
  return {
    // The cron has no on-screen cut to mirror, so it always reads the default
    // S&P 500 universe — named, so the model never implies it looked wider.
    cut: 'S&P 500',
    /* Period is stated even though this path can only ever be daily: it reads
       the raw desk-heatmap payload and never applies the dashboard's
       recolorForPeriod(), so `pct` really is a day move here. The FIELD NAMES
       nonetheless match the browser's buildHeatmapContext() exactly — two
       shapes for one panel would be a worse trap than the mislabelling this
       replaces, since the model would have to know which path built the
       snapshot to read either correctly. */
    period: '1d',
    periodLabel: '1-Day Performance',
    measures: 'chgPct is each name\'s move on the day',
    asOf: hm.asOf ?? null,
    names: tiles.length,
    sectors: sectors.sort((a, b) => b.avgChgPct - a.avgChgPct),
    topGainers: byMove.slice(0, 10),
    topLosers: byMove.slice(-10).reverse(),
  };
}

// ── delivery ────────────────────────────────────────────────────────────────
// The answer also goes out by email (owner request 2026-08-12). A scheduled ask
// whose only output is a row in the dashboard's own thread still requires the
// owner to open the dashboard, which defeats the point of scheduling it.
//
// Resend rather than SMTP because Supabase/Deno Deploy BLOCK outbound ports 25
// and 587 (465 is inconsistent), so "just use Gmail's SMTP" is closed off at the
// platform level — an edge function's only wire out is HTTPS.
//
// Returns the status string to stamp, so "answered but the email failed" is a
// DISTINCT outcome from both success and a failed ask. Collapsing it into `ok`
// would stamp a brief that never arrived as healthy, which is the one state the
// owner cannot detect from the inbox.
async function sendBrief(prompt: string, answer: string, pt: Any): Promise<string> {
  const key = Deno.env.get('RESEND_API_KEY');
  const to = Deno.env.get('DESK_EMAIL_TO');
  const from = Deno.env.get('DESK_EMAIL_FROM') || 'onboarding@resend.dev';
  // Not configured is not an error: the scheduler predates email and must keep
  // working (thread-only) if the secrets are absent.
  if (!key || !to) return 'ok (no email configured)';
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from, to: [to],
        subject: `Desk · ${prompt.slice(0, 80)} · ${pt.date}`,
        // TEXT, not html: the system prompt already bans markdown, so answers
        // arrive clean with no conversion — and no conversion means no escaping
        // bug turning a price into markup.
        text: answer,
      }),
    });
    if (!res.ok) return `ok, email failed: HTTP ${res.status} ${(await res.text()).slice(0, 90)}`;
    return 'ok (emailed)';
  } catch (e) {
    return 'ok, email failed: ' + String((e as Any)?.message ?? e).slice(0, 90);
  }
}

async function buildContext(userId: string, headers: Record<string, string>): Promise<Any> {
  const url = Deno.env.get('SUPABASE_URL')!;

  const snapshots = (async () => {
    try {
      const rows = await (await fetch(
        `${url}/rest/v1/desk_account_snapshots?select=account_key,label,as_of,nav,day_pnl,total_unrl,cash,positions` +
        `&user_id=eq.${userId}&order=as_of.desc&limit=40`,
        { headers },
      )).json();
      const latest = new Map<number, Any>();
      for (const r of rows || []) if (!latest.has(r.account_key)) latest.set(r.account_key, r);
      return [...latest.values()].sort((a, b) => a.account_key - b.account_key);
    } catch { return []; }
  })();

  const [accounts, market, news, watchlist, heat, charts] = await Promise.all([
    snapshots,
    liveFeed('desk-market'),
    liveFeed('desk-news'),
    liveFeed('desk-watchlist'),
    liveFeed('desk-heatmap'),
    liveFeed('desk-charts'),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    // Said out loud so the model never claims the owner "just asked" this.
    origin: 'scheduled run — the owner is not at the desk; write it to be read later',
    // HOLDINGS ARE TICKERS ONLY (owner ruling 2026-08-12) — the same rule the
    // dashboard's buildAskContext() follows. nav, day_pnl, total_unrl, cash and
    // the per-position mkt/unrl are all withheld: the owner wants a call on the
    // stock, not a read on their liquidity, and withholding the numbers is the
    // enforcement point rather than a line in the system prompt. dayPct stays
    // because it is the ticker's own market move, not a fact about the account.
    accounts: (accounts || []).map((s: Any) => ({
      account: 'Account ' + s.account_key,
      label: s.label ?? null,
      asOf: s.as_of,
      positions: (Array.isArray(s.positions) ? s.positions : [])
        .map((p: Any) => ({ sym: p.sym, dayPct: p.dayPct })),
    })),
    market: (market?.tiles || []).map((t: Any) => ({ name: t.name, last: t.last, dayChgPct: t.chg })),
    // Ticker association comes from `chips` — desk-news emits
    // { t, src, h, url, chips: [[sym, dayPct], ...] } and has NO `sym` field.
    // Reading one silently produced `sym: null` on every headline, stripping
    // exactly the link that lets the model tie news to a holding or a
    // watchlist name (Codex review, PR #241).
    headlines: (news?.items || []).slice(0, 12).map((n: Any) => ({
      headline: n.h,
      source: n.src ?? null,
      at: n.t ?? null,
      symbols: (Array.isArray(n.chips) ? n.chips : []).map((c: Any) => ({ sym: c[0], dayPct: c[1] ?? null })),
    })),
    // The watchlist goes in FULL — it is the curated focus list, and summarising
    // it would defeat the point of curating it (the PR #241 ruling).
    watchlist: (watchlist?.lists || []).map((l: Any) => ({
      title: l.title,
      symbols: (l.rows || []).map((r: Any) => ({ sym: r.sym, last: r.last, dayChgPct: r.pct, extended: r.ext === true })),
      unresolved: (l.symbols || []).filter((s: string) => !(l.rows || []).some((r: Any) => r.sym === s)),
    })),
    heatmap: heatmapFrom(heat),
    // The oscillator readings the Pro panes draw, for the whole charted roster.
    technicals: technicalsFrom(charts),
  };
}

// ── entrypoint ──────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method !== 'POST') return reply(405, { ok: false, error: 'POST only' });
  const secret = Deno.env.get('CRON_SECRET');
  if (!secret || req.headers.get('x-cron-secret') !== secret) {
    return reply(401, { ok: false, error: 'cron secret required' });
  }

  const url = Deno.env.get('SUPABASE_URL')!;
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  // NO browser-shaped user-agent on our own REST calls: the sb_secret_… key is
  // refused outright ("Forbidden use of secret API key in browser") the moment
  // the request looks like a browser. Learned the hard way on desk-watchlist.
  const headers = { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' };

  try {
    const res = await fetch(
      `${url}/rest/v1/desk_ask_schedule?select=*&enabled=eq.true&order=pos,id`,
      { headers },
    );
    if (!res.ok) throw new Error(`schedule read ${res.status}: ${(await res.text()).slice(0, 120)}`);
    const rows: Row[] = await res.json();

    const now = new Date();
    const pt = ptParts(now);
    const due = rows
      .map((r) => ({ r, slot: dueSlot(r, pt, r.last_run_at ? ptParts(new Date(r.last_run_at)) : null) }))
      .filter((x) => x.slot !== null)
      .slice(0, MAX_PER_TICK);

    if (!due.length) return reply(200, { ok: true, status: 'idle', checked: rows.length, pt: `${pt.date} ${pt.hour}:${String(pt.min).padStart(2, '0')}` });

    const users = await (await fetch(`${url}/rest/v1/desk_users?select=id&is_test=eq.false&limit=1`, { headers })).json();
    if (!users?.length) throw new Error('no owner row in desk_users');
    const userId = users[0].id;

    /* Returns whether the write actually landed. This is NOT defensive
       tidiness: PostgREST answers a rejected PATCH with a 4xx/5xx, which
       `fetch` RESOLVES rather than throwing, so the old bare `.catch(() => {})`
       could not see a failure at all. The pre-run stamp is what claims the
       slot, so a silently-lost one leaves the row still due and it re-fires on
       every tick for the whole CATCHUP_MIN window — up to 18 duplicate briefs,
       emails and Claude tool loops from a single failed write (Codex review,
       PR #241). */
    const stamp = async (id: number, status: string): Promise<boolean> => {
      try {
        const res = await fetch(`${url}/rest/v1/desk_ask_schedule?id=eq.${id}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ last_run_at: new Date().toISOString(), last_status: status.slice(0, 200) }),
        });
        return res.ok;
      } catch { return false; }
    };

    const context = await buildContext(userId, headers);
    const out: Any[] = [];

    for (const { r } of due) {
      // Stamp BEFORE the call, and treat it as CLAIMING the slot. desk-ask runs
      // a bounded tool loop that can take a minute or more; without this, a run
      // that outlives the next 5-minute tick would be started again, and a run
      // that throws would be retried on every tick inside the catch-up window —
      // both spend real Claude quota.
      //
      // If the claim does not land we must NOT proceed: the whole protection
      // above rests on last_run_at having been written, so running anyway would
      // send the brief AND leave the row due to send it again five minutes
      // later. Skipping costs one delayed brief; proceeding costs up to 18
      // duplicates. The next tick retries the claim, so a transient PostgREST
      // blip self-heals well inside the catch-up window.
      if (!await stamp(r.id, 'running')) {
        out.push({ id: r.id, status: 'skipped: could not claim the slot' });
        continue;
      }
      let status = 'ok';
      try {
        const ar = await fetch(`${url}/functions/v1/desk-ask`, {
          method: 'POST',
          headers: { ...headers, 'x-cron-secret': secret },
          body: JSON.stringify({ question: r.prompt, context }),
        });
        const aj = await ar.json().catch(() => null);
        if (!ar.ok || !aj?.ok) status = `failed: ${String(aj?.error ?? `HTTP ${ar.status}`).slice(0, 160)}`;
        // Deliver it. The thread copy is the archive; the email is what reaches
        // the owner when they are not at the desk — which is the whole point of
        // a scheduled ask. Only on a real answer: mailing a blank on a failed
        // run would train the owner to ignore the 8am message.
        else if (aj.answer) status = await sendBrief(r.prompt, aj.answer, pt);
      } catch (e) {
        status = 'failed: ' + String((e as Any)?.message ?? e).slice(0, 160);
      }
      /* The post-run stamp is best-effort, unlike the claim above: last_run_at
         was already written, so a failure here cannot re-fire the row — it only
         loses the status text. Said out loud in the response rather than
         swallowed, because the editor's status line is how the owner sees the
         scheduler is healthy, and a stale one should not read as a clean run. */
      const recorded = await stamp(r.id, status);
      out.push(recorded ? { id: r.id, status } : { id: r.id, status, statusNotRecorded: true });
    }

    return reply(200, { ok: true, status: 'ran', ran: out });
  } catch (e) {
    const detail = String((e as Any)?.message ?? e);
    console.error('desk-cron-ask failed:', detail);
    return reply(200, { ok: false, status: 'failed', detail });
  }
});
