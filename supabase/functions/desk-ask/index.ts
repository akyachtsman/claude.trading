// ── desk-ask — PIN-gated agentic Claude assistant over the desk ─────────────
// Deployed as a Supabase Edge Function (Deno). The browser sends {pin, question,
// context}; the PIN is validated against desk_users with the SAME
// hex(sha256(salt || pin)) scheme as the desk_login RPC. The question then runs
// through an agentic Anthropic loop with: prior-conversation replay from
// desk_chat_memory (continuity), web_search/web_fetch (research), a get_quote
// tool that pulls live quote+fundamentals via quote-proxy, and a get_technicals
// tool that pulls daily OHLC via quote-proxy and computes RSI/Stochastic
// server-side (owner report 2026-07-24: the model had no way to back a
// mechanical oversold/overbought reading — get_quote carries no bars, and
// guessing one from a web search isn't verifiable — so we compute it directly
// from the same feed the charts use). The owner opted into directional views
// on their own positions. All server-side secrets (ANTHROPIC_API_KEY, service
// role, anon) live ONLY in function secrets.

const SITE_ORIGIN = 'https://akyachtsman.github.io';   // for the quote-proxy origin gate

const CORS = {
  'Access-Control-Allow-Origin': '*', // PIN is the gate; the page is public anyway
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } });

// DEFAULT_SYSTEM is the fallback if the live desk_system_prompt table (desk_009)
// is unreadable — the owner's actual, current prompt lives in that table and is
// self-editable from the dashboard's system-prompt panel (lock icon → edit →
// Submit), so changing behavior no longer requires a code edit + redeploy here.
const DEFAULT_SYSTEM = [
  "You are the desk assistant embedded in the owner's private, PIN-gated two-account trading dashboard. You are speaking to the owner about their own real accounts.",
  'You MAY give direct, opinionated, directional views — buy / sell / hold / trim / add — on the owner\'s positions and on any ticker they ask about. Do NOT refuse on the grounds that this is financial advice; the owner has explicitly asked for your view on their own money.',
  'Ground every directional call in data you actually have this turn: the dashboard snapshot, a live quote you fetched with get_quote, or a web result. Never invent numbers — quote them as they appear. If you lack the data for a call, fetch it or say what you would need.',
  'Attribute provenance inline so the owner can weigh each claim: mark snapshot-derived facts, live-fetched figures (with the fetch time), and web facts (name the source).',
  "The snapshot's `market` array and `marketAsOf` are the LIVE, continuously-refreshing feed — treat that timestamp as the current moment. When asked for anything 'live', 'current', or 'today', answer from `market`/`marketAsOf` (or a fresh get_quote), and say so if it's not fresh enough to answer confidently.",
  'Use get_quote(symbol) for a live price + fundamentals on any ticker, get_technicals(symbol) for real computed oscillator readings — RSI(14), the daily Stochastic 14-3-3 (Pro 1 SWING: stochK/stochD), and the weekly-scale Stochastic 92-15-15 (Pro 2 LONG-TERM: stochWK/stochWD) — never estimate, recall, or web-search for an RSI/stochastic/overbought/oversold number, always call get_technicals for it — and web_search / web_fetch for anything not on the page (earnings, news, current events). PRIVACY: never put the owner\'s real position sizes, share counts, dollar balances, or account identifiers into a web_search or web_fetch query — search by ticker or topic only.',
  "The dashboard already shows the owner everything visible on it — your value is what it CAN'T show: outside news, analyst commentary, catalysts, and context. For any directional or technical call, also run a web_search for relevant recent news or analyst commentary on that ticker BEFORE answering — don't wait to be asked.",
  "Keep answers short and direct — single-idea sentences, not long clauses stacked together with dashes or 'and'. When comparing or ranking several tickers, put each on its own line led by the plain ticker name (e.g. 'NVDA: ...'), followed by 1-2 tight sentences (the verdict, then the number backing it) — never markdown bold or asterisks, since answers render as plain text and asterisks would show up literally; a real line break between items is fine. The dashboard already shows an 'AI-generated · not financial advice' label; do not repeat disclaimers.",
].join(' ');

const TOOLS = [
  // max_uses raised from 5 (owner report 2026-07-27): the system prompt tells
  // the model to search before every directional/technical call, so a
  // multi-ticker question was hitting Anthropic's own per-turn search cap
  // almost immediately — a separate limit from MAX_TOOL_CALLS below, which
  // only counts get_quote/get_technicals.
  { type: 'web_search_20260209', name: 'web_search', max_uses: 25 },
  { type: 'web_fetch_20260209', name: 'web_fetch' },
  {
    name: 'get_quote',
    description: 'Live quote and fundamentals for one ticker (last, day change, bid/ask, next earnings, market cap, P/E, 52-week range, dividend yield). Use for any symbol, on or off the page.',
    input_schema: {
      type: 'object',
      properties: { symbol: { type: 'string', description: 'Ticker, e.g. AAPL' } },
      required: ['symbol'],
    },
  },
  {
    name: 'get_technicals',
    description: 'Real computed technical-oscillator reading for one ticker: RSI(14, Wilder-smoothed), the slow Stochastic %K/%D (14-3-3 — Pro 1 SWING), and the weekly-scale Stochastic %K/%D (92-15-15, same bars — Pro 2 LONG-TERM). During market hours this folds in the still-forming session, same as the charts (reflectsLiveSession: true when it does; false means the last completed session only — say so if asked for a live/current read while false). Covers both the swing and long-term mechanical reads in one call. Use this whenever asked about RSI, stochastic, overbought, or oversold — never estimate or guess these from memory, the dashboard snapshot, or a web search; this computes them directly from live OHLC data.',
    input_schema: {
      type: 'object',
      properties: { symbol: { type: 'string', description: 'Ticker, e.g. AAPL' } },
      required: ['symbol'],
    },
  },
];
const CLIENT_TOOL_NAMES = new Set(['get_quote', 'get_technicals']);

const MAX_TOOL_CALLS = 12;     // client tool executions (get_quote + get_technicals) per turn —
                                // raised from 6 (owner report 2026-07-25): a multi-ticker question
                                // (quote + technicals per symbol) burned through 6 fast; this is a
                                // per-turn CALL-COUNT safety cap against a runaway loop, unrelated
                                // to the Anthropic account's dollar balance.
// Opus 5 spends this budget on thinking AND the visible answer — it is ONE
// ceiling over both, not two. The old 2048 was sized for Opus 4.8, where
// omitting the `thinking` parameter meant no thinking at all; on Opus 5,
// omitting it runs adaptive thinking, so the same number would have left the
// reply whatever thinking didn't consume. Raised with the model swap, never
// separately (owner ruling 2026-08-05).
const MAX_ANSWER_TOKENS = 8192;
// Owner ruling 2026-08-05: the grounding check is BUILT BUT NOT ARMED. It
// spends tokens on every question whether or not anything is wrong, and the
// owner would rather hold that cost until the failure recurs. Set the
// ASK_VERIFY function secret to '1' to arm it — a secret change, not a code
// change, so it can go live in a minute without a PR or a deploy.
const VERIFY_ALWAYS = Deno.env.get('ASK_VERIFY') === '1';
// Typed by the owner to check ONE answer: "/verify", "ask_verify" or
// "!verify", anywhere in the question, any case.
const VERIFY_MARK = /(?:^|\s)[/!]?ask[_-]?verify\b|(?:^|\s)[/!]verify\b/i;
const VERIFY_TOKENS = 1500;
// Sent back when a terminal answer arrived with no web search behind it. The
// system prompt has demanded a search before every answer since 2026-07 and
// was ignored, so this is stated as a fact about what happens next rather than
// as another instruction the model may weigh.
const NO_SEARCH_NOTE =
  'You produced that answer without running a single web_search this turn. That is not permitted — ' +
  'anything you believe from training data may be out of date, and this desk has already been wrong ' +
  'that way. Run the search now and answer again. If the search shows your draft was wrong, say so ' +
  'plainly rather than quietly correcting it.';
const MAX_RESUMES = 3;         // pause_turn resumptions
const MAX_ITERS = 18;         // overall loop safety net (tool calls + resumes + wrap-up) — raised
                                // alongside MAX_TOOL_CALLS so a sequential (non-batched) run through
                                // the higher call cap isn't cut short by the iteration cap first
const REPLAY_ROWS = 20;        // prior exchanges considered
const REPLAY_DAYS = 30;
const REPLAY_CHAR_BUDGET = 32000;  // ~8k tokens of history

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply(405, { ok: false, error: 'POST only' });

  let payload: { pin?: unknown; question?: unknown; context?: unknown; verify?: unknown };
  try { payload = await req.json(); } catch { return reply(400, { ok: false, error: 'invalid JSON body' }); }
  const pin = String(payload.pin ?? '');
  const rawQuestion = String(payload.question ?? '').slice(0, 2000).trim();
  // Per-question opt-in (owner request 2026-08-05: "sometimes if I have a
  // really important question, can I say ask_verify"). Typed into the question
  // itself, so it works against the deployed dashboard with no client change
  // and no cache-bust. The marker is STRIPPED before the question reaches the
  // model or desk_chat_memory — otherwise it would sit in the replayed history
  // and teach the desk that the word is part of how the owner talks.
  // A bare "verify" is deliberately NOT a trigger: "verify my thesis on NVDA"
  // is an ordinary question, and a marker that fires by accident is one the
  // owner stops trusting.
  // Two ways in: the composer's toggle sends a clean flag, and the typed
  // marker below still works for anyone reaching for the keyboard.
  const askedToVerify = payload.verify === true || VERIFY_MARK.test(rawQuestion);
  const question = rawQuestion.replace(VERIFY_MARK, ' ').replace(/\s+/g, ' ').trim();
  const verifyThisTurn = VERIFY_ALWAYS || askedToVerify;
  if (!pin || !question) return reply(400, { ok: false, error: 'pin and question are required' });

  const supaUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const svc = { apikey: serviceKey, authorization: `Bearer ${serviceKey}` };

  // PIN check — same salted-hash scheme as desk_login; capture the matched user id.
  const usersRes = await fetch(`${supaUrl}/rest/v1/desk_users?select=id,salt,pin_hash`, { headers: svc });
  if (!usersRes.ok) return reply(502, { ok: false, error: 'auth backend unavailable' });
  const users: { id: string; salt: string; pin_hash: string }[] = await usersRes.json();
  const enc = new TextEncoder();
  let userId: string | null = null;
  for (const u of users) {
    const digest = await crypto.subtle.digest('SHA-256', enc.encode(u.salt + pin));
    const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
    if (hex === u.pin_hash) userId = u.id; // check every row — no early exit
  }
  if (!userId) return reply(401, { ok: false, error: 'PIN not recognized.' });

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) {
    return reply(503, { ok: false, error: 'Ask service not configured yet — the owner needs to add the ANTHROPIC_API_KEY function secret.' });
  }
  // Owner ruling 2026-08-05. Opus 5 THINKS BY DEFAULT (Opus 4.8 did not), and
  // max_tokens is ONE ceiling over thinking + the visible answer — so the old
  // 2048 would have starved the reply the moment the model began reasoning.
  // Model and budget therefore ship together; either alone is a regression.
  const model = Deno.env.get('ASK_MODEL') || 'claude-opus-5';

  // desk_009: the owner's live-edited system prompt — non-fatal read, falls
  // back to DEFAULT_SYSTEM on any failure (table unreachable, empty, etc).
  let SYSTEM = DEFAULT_SYSTEM;
  try {
    const spRes = await fetch(`${supaUrl}/rest/v1/desk_system_prompt?select=content&id=eq.true`, { headers: svc });
    if (spRes.ok) {
      const rows: { content: string }[] = await spRes.json();
      if (rows[0]?.content) SYSTEM = rows[0].content;
    }
  } catch (_e) { /* keep DEFAULT_SYSTEM */ }

  // ── memory replay (FR-MEM2) — non-fatal ────────────────────────────────────
  const messages: Array<{ role: string; content: unknown }> = [];
  try {
    const since = new Date(Date.now() - REPLAY_DAYS * 864e5).toISOString();
    const memRes = await fetch(
      `${supaUrl}/rest/v1/desk_chat_memory?user_id=eq.${userId}&created_at=gte.${since}` +
      `&select=question,answer&order=created_at.desc&limit=${REPLAY_ROWS}`,
      { headers: svc });
    if (memRes.ok) {
      const rows: { question: string; answer: string }[] = await memRes.json();
      rows.reverse(); // oldest → newest
      let budget = REPLAY_CHAR_BUDGET;
      const turns: Array<{ role: string; content: unknown }> = [];
      for (let i = rows.length - 1; i >= 0; i--) {   // keep newest, drop oldest when over budget
        const cost = rows[i].question.length + rows[i].answer.length;
        if (budget - cost < 0) break;
        budget -= cost;
        turns.unshift({ role: 'assistant', content: rows[i].answer });
        turns.unshift({ role: 'user', content: rows[i].question });
      }
      messages.push(...turns);
    }
  } catch (_e) { /* replay is best-effort; continue without history */ }

  // Live get_quote via quote-proxy (server-side; forge the site Origin to pass its gate).
  async function getQuote(symbol: string): Promise<Record<string, unknown>> {
    try {
      const qr = await fetch(`${supaUrl}/functions/v1/quote-proxy`, {
        method: 'POST',
        headers: { ...svc, 'content-type': 'application/json', origin: SITE_ORIGIN },
        body: JSON.stringify({ symbol, kind: 'info' }),
      });
      const j = await qr.json();
      if (!qr.ok || !j.ok) return { ok: false, error: j.error || `quote fetch failed (HTTP ${qr.status})` };
      return { ok: true, symbol: j.symbol, asOf: j.asOf, info: j.info };
    } catch (e) {
      return { ok: false, error: 'quote fetch error: ' + (e instanceof Error ? e.message : String(e)) };
    }
  }

  // get_technicals: fetch DAILY OHLC via quote-proxy and compute RSI(14) +
  // TWO stochastic readings server-side, both on the same daily bars — the
  // exact algorithms scripts/data.js's stochSeries() uses for Pro 1 (STOCH,
  // 14-3-3) and Pro 2's weekly-scale overlay (WSTOCH, 92-15-15 — literally the
  // same stochSeries() call with a longer/heavier-smoothed config on the same
  // daily bars, per app.js's weeklyStochOnDaily), so one fetch covers both the
  // SWING (Pro 1) and LONG-TERM (Pro 2) mechanical reads (owner report
  // 2026-07-25: the tool only covered Pro 1's daily read; Pro 2's weekly-scale
  // stoch needed no new data, just a second pass over the same bars).
  //
  // During market hours the charts don't compute on the completed-session
  // daily series alone — app.js's graftTodayBar() appends an aggregated
  // in-progress "today" bar (built from the intraday feed) before running
  // stochSeries()/rsiSeries(), so the on-screen Pro 1/Pro 2 reads already
  // move through the live session. Ported the identical graft here (Codex
  // review on PR #180, 2026-07-25: without it, this tool's numbers could be
  // one bar stale and visibly disagree with the dashboard on a volatile
  // day) — a best-effort second fetch of the intraday feed; any failure
  // there falls back to the plain completed-session daily series rather
  // than failing the whole call.
  const STOCH_K = 14, STOCH_K_SMOOTH = 3, STOCH_D = 3, RSI_LEN = 14;
  const WSTOCH_K = 92, WSTOCH_K_SMOOTH = 15, WSTOCH_D = 15;
  const STOCH_WARMUP = STOCH_K + STOCH_K_SMOOTH + STOCH_D - 2; // 18
  type Series = { t: string[]; o: number[]; h: number[]; l: number[]; c: number[]; v: number[] };
  function stochLatest(s: { h: number[]; l: number[]; c: number[] }, n: number, k: number, kSmooth: number, d: number) {
    const raw: (number | null)[] = new Array(n).fill(null);
    for (let i = k - 1; i < n; i++) {
      let hi = -Infinity, lo = Infinity;
      for (let j = i - k + 1; j <= i; j++) { if (s.h[j] > hi) hi = s.h[j]; if (s.l[j] < lo) lo = s.l[j]; }
      raw[i] = hi === lo ? 50 : (s.c[i] - lo) / (hi - lo) * 100;
    }
    const sma = (arr: (number | null)[], len: number) => arr.map((_, i) => {
      if (i < len - 1) return null;
      let sum = 0;
      for (let j = i - len + 1; j <= i; j++) { if (arr[j] == null) return null; sum += arr[j] as number; }
      return sum / len;
    });
    const kLine = sma(raw, kSmooth);
    const dLine = sma(kLine, d);
    return { k: kLine[n - 1], d: dLine[n - 1] };
  }
  // Direct port of app.js's graftTodayBar(): aggregate the intraday feed's
  // bars for its latest session into one OHLCV bar and append it, UNLESS
  // that session is already the daily series' last (completed) entry.
  function graftToday(daily: Series, intra: Series): Series | null {
    const n = intra.t.length;
    if (!n || !daily.t.length) return null;
    const day = intra.t[n - 1].slice(0, 10);
    if (day <= daily.t[daily.t.length - 1]) return null;
    let o: number | null = null, h = -Infinity, l = Infinity, c: number | null = null, v = 0;
    for (let i = 0; i < n; i++) {
      if (intra.t[i].slice(0, 10) !== day) continue;
      if (o === null) o = intra.o[i];
      if (intra.h[i] > h) h = intra.h[i];
      if (intra.l[i] < l) l = intra.l[i];
      c = intra.c[i]; v += intra.v[i] || 0;
    }
    if (o === null || c === null) return null;
    return {
      t: [...daily.t, day], o: [...daily.o, o], h: [...daily.h, h],
      l: [...daily.l, l], c: [...daily.c, c], v: [...daily.v, v],
    };
  }
  async function getTechnicals(symbol: string): Promise<Record<string, unknown>> {
    try {
      const qr = await fetch(`${supaUrl}/functions/v1/quote-proxy`, {
        method: 'POST',
        headers: { ...svc, 'content-type': 'application/json', origin: SITE_ORIGIN },
        body: JSON.stringify({ symbol, kind: 'daily' }),
      });
      const j = await qr.json();
      if (!qr.ok || !j.ok) return { ok: false, error: j.error || `daily bars fetch failed (HTTP ${qr.status})` };
      let s = j.series as Series;
      let live = false;
      try {
        // No `prepost` here, deliberately: quote-proxy defaults to the regular
        // session, and this graft must stay byte-for-byte the same bar set
        // app.js's graftTodayBar() uses (which drops pre/post via regularOnly).
        // Turning extended hours on here would fold 4am prints into today's
        // high/low and silently walk this tool's Stochastic/RSI numbers off the
        // Pro 1 / Pro 2 panes the owner reads them against.
        const ir = await fetch(`${supaUrl}/functions/v1/quote-proxy`, {
          method: 'POST',
          headers: { ...svc, 'content-type': 'application/json', origin: SITE_ORIGIN },
          body: JSON.stringify({ symbol, kind: 'intraday' }),
        });
        const ij = await ir.json();
        if (ir.ok && ij.ok && ij.series?.t?.length) {
          const grafted = graftToday(s, ij.series);
          if (grafted) { s = grafted; live = true; }
        }
      } catch { /* keep the completed-session daily series */ }
      const n = s.c.length;
      if (n < Math.max(STOCH_WARMUP, RSI_LEN + 1)) {
        return { ok: false, error: `not enough price history for ${symbol} to compute a reading` };
      }

      // Stochastic 14-3-3 (Pro 1 SWING) — slow %K, then %D, over a 14-bar high/low window.
      const { k: stochK, d: stochD } = stochLatest(s, n, STOCH_K, STOCH_K_SMOOTH, STOCH_D);
      // Stochastic 92-15-15 (Pro 2 LONG-TERM weekly-scale) — same daily bars, longer/heavier
      // window; null (not an error) if the ticker has under ~120 bars of history.
      const { k: stochWK, d: stochWD } = stochLatest(s, n, WSTOCH_K, WSTOCH_K_SMOOTH, WSTOCH_D);

      // RSI(14), Wilder's smoothing (standard formula).
      let avgGain = 0, avgLoss = 0;
      for (let i = 1; i <= RSI_LEN; i++) {
        const diff = s.c[i] - s.c[i - 1];
        if (diff >= 0) avgGain += diff; else avgLoss -= diff;
      }
      avgGain /= RSI_LEN; avgLoss /= RSI_LEN;
      for (let i = RSI_LEN + 1; i < n; i++) {
        const diff = s.c[i] - s.c[i - 1];
        avgGain = (avgGain * (RSI_LEN - 1) + Math.max(diff, 0)) / RSI_LEN;
        avgLoss = (avgLoss * (RSI_LEN - 1) + Math.max(-diff, 0)) / RSI_LEN;
      }
      const rsi14 = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

      const round = (v: number | null) => v != null ? Number(v.toFixed(2)) : null;
      return {
        ok: true, symbol, asOf: s.t[n - 1], reflectsLiveSession: live,
        stochK: round(stochK), stochD: round(stochD),
        stochWK: round(stochWK), stochWD: round(stochWD),
        rsi14: Number(rsi14.toFixed(2)),
        note: 'stochK/stochD: slow Stochastic 14-3-3 on daily bars — the Pro 1 SWING read. stochWK/stochWD: the SAME daily bars run through a 92-15-15 config — the Pro 2 LONG-TERM weekly-scale read (null if the ticker has under ~120 bars of history). rsi14: standard 14-period RSI (Wilder), not otherwise charted on the dashboard. reflectsLiveSession: true if today\'s still-forming session was folded in (matching what the charts show live), false if this is the last completed session only. Conventional zones: stochastic <20 oversold / >80 overbought (weekly-scale strip draws its band at 30, not 20); RSI <30 oversold / >70 overbought.',
      };
    } catch (e) {
      return { ok: false, error: 'technicals fetch error: ' + (e instanceof Error ? e.message : String(e)) };
    }
  }

  const contextJson = JSON.stringify(payload.context ?? {}).slice(0, 30000);
  // Second cache breakpoint. Everything up to and including this turn is fixed
  // for the whole tool loop — system, tools, the replayed memory, the snapshot
  // and the question — while only the assistant/tool_result pairs appended
  // below it grow. The snapshot alone can be 30k characters, so this is the
  // larger of the two savings.
  messages.push({
    role: 'user',
    content: [{
      type: 'text',
      text: `Dashboard snapshot (JSON):\n${contextJson}\n\nQuestion: ${question}`,
      cache_control: { type: 'ephemeral' },
    }],
  });

  // ── agentic loop (FR-WEB/FR-DATA) ──────────────────────────────────────────
  const sources: { title: string; url: string }[] = [];
  const seenUrls = new Set<string>();
  // Raw tool payloads for this turn. These are what an answer is SUPPOSED to
  // be built from, so they are the only thing worth auditing it against: on
  // 2026-07-31 the desk reported HOOD at 118.98 with a 26.66 52-week low while
  // the payload sitting in this very array said 92.39 and 63.515-153.86.
  const receipts: { tool: string; input: unknown; out: Record<string, unknown> }[] = [];
  // deno-lint-ignore no-explicit-any
  let finalMsg: any = null;
  let toolCalls = 0, resumes = 0, iters = 0;
  let searchForced = false, verified = false;
  let unsupported: string[] = [];
  /* What this question actually cost, summed over every Anthropic call in the
     turn — the tool loop, the forced-search retry, and the grounding check when
     armed. Reporting only the last call would undercount a 12-tool-call
     question by an order of magnitude.
     cacheWrite/cacheRead are the proof that the prompt-cache breakpoints are
     landing: the prefix should be written once and read back on every later
     iteration, so cacheRead should dwarf cacheWrite. Both sitting at 0 means
     caching silently isn't working and the prefix is being re-billed in full. */
  const usage = { in: 0, out: 0, cacheWrite: 0, cacheRead: 0, calls: 0 };
  // deno-lint-ignore no-explicit-any
  const addUsage = (u: any) => {
    if (!u) return;
    usage.in += u.input_tokens || 0;
    usage.out += u.output_tokens || 0;
    usage.cacheWrite += u.cache_creation_input_tokens || 0;
    usage.cacheRead += u.cache_read_input_tokens || 0;
    usage.calls++;
  };

  // deno-lint-ignore no-explicit-any
  const textOf = (m: any) => (m?.content ?? [])
    .filter((b: { type: string }) => b.type === 'text')
    .map((b: { text: string }) => b.text).join('\n').trim();

  // Grounding check. Deliberately a MATCHING task, not an opinion task: it is
  // never asked whether the answer is good, only which claims fail to appear in
  // the payloads. Asking a model to judge its own output invites it to agree
  // with itself — the failure the owner named when this was scoped ("how do we
  // know it isn't just coming up with the same answer twice"). Extraction and
  // lookup are far less prone to that than evaluation, because a number is
  // either in the JSON or it is not.
  async function auditDraft(draft: string): Promise<string[]> {
    if (!receipts.length && !sources.length) return [];   // nothing to check against
    const evidence = JSON.stringify({ tool_payloads: receipts, web_sources: sources }).slice(0, 60000);
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey!, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model,
        max_tokens: VERIFY_TOKENS,
        // Low effort on purpose — this is lookup, not reasoning.
        output_config: { effort: 'low' },
        system:
          'You check whether a draft answer is supported by the evidence gathered to produce it. ' +
          'You are NOT judging whether the answer is good, well-written, or correct in your own opinion — ' +
          'only whether each specific factual claim appears in the evidence. ' +
          'Reply with a JSON array of strings and nothing else. Each string quotes one claim from the draft ' +
          'that is NOT supported by the evidence, and says what the evidence shows instead. ' +
          'Include every price, percentage, date, range and named fact that is absent from or contradicted by ' +
          'the evidence. Do NOT flag opinions, forecasts, or directional views — those are the desk\'s job. ' +
          'If every checkable claim is supported, reply exactly [].',
        messages: [{ role: 'user', content: `EVIDENCE:\n${evidence}\n\nDRAFT ANSWER:\n${draft}` }],
      }),
    });
    if (!res.ok) return [];   // never block an answer on the checker failing
    try {
      const j = await res.json();
      addUsage(j.usage);   // the check is not free — count it with everything else
      const raw = textOf(j).replace(/^```(?:json)?|```$/g, '').trim();
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
    } catch { return []; }
  }

  for (;;) {
    if (iters++ >= MAX_ITERS) break;   // hard stop; finalMsg holds the last response
    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model,
        max_tokens: MAX_ANSWER_TOKENS,
        // Cached, not a bare string. Render order is tools -> system ->
        // messages, so one breakpoint on the system block covers the tool
        // definitions too. The tool loop re-sends this entire prefix on every
        // iteration (up to MAX_ITERS), and before this it was re-billed at
        // full price each time; reads are ~0.1x. A second breakpoint sits on
        // the snapshot turn below.
        system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
        tools: TOOLS,
        messages,
        // Adaptive is the only on-mode; a fixed budget_tokens is a 400 here.
        // Stated explicitly rather than left to the model default so that a
        // future default change cannot silently re-tune the desk.
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high' },
      }),
    });
    if (!apiRes.ok) return reply(502, { ok: false, error: `model call failed (HTTP ${apiRes.status})` });
    const msg = await apiRes.json();
    addUsage(msg.usage);
    finalMsg = msg;   // always track the latest response for text extraction
    if (msg.stop_reason === 'refusal') return reply(200, { ok: false, error: 'The model declined this question.' });

    // collect web sources from any search-result blocks
    for (const b of msg.content ?? []) {
      if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
        for (const r of b.content) {
          if (r.type === 'web_search_result' && r.url && !seenUrls.has(r.url)) {
            seenUrls.add(r.url);
            sources.push({ title: r.title || r.url, url: r.url });
          }
        }
      }
    }

    if (msg.stop_reason === 'pause_turn') {
      if (++resumes > MAX_RESUMES) break;
      messages.push({ role: 'assistant', content: msg.content });
      continue;
    }

    if (msg.stop_reason === 'tool_use') {
      // deno-lint-ignore no-explicit-any
      const clientUses = (msg.content ?? []).filter((b: any) => b.type === 'tool_use' && CLIENT_TOOL_NAMES.has(b.name));
      if (!clientUses.length) break;   // no client tool to satisfy — extract text
      // ALWAYS emit one tool_result per tool_use (the API requires matched counts);
      // over-budget calls get an error result instead of a live fetch.
      const results: unknown[] = [];
      for (const tu of clientUses) {
        let out: Record<string, unknown>;
        if (toolCalls >= MAX_TOOL_CALLS) {
          out = { ok: false, error: 'tool-call budget reached for this turn — answer with what you have and note it' };
        } else {
          toolCalls++;
          const symbol = String(tu.input?.symbol ?? '');
          out = tu.name === 'get_technicals' ? await getTechnicals(symbol) : await getQuote(symbol);
        }
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out), is_error: out.ok === false });
        receipts.push({ tool: tu.name, input: tu.input, out });
      }
      messages.push({ role: 'assistant', content: msg.content });
      messages.push({ role: 'user', content: results });
      continue;
    }

    // ── terminal answer: gate it before accepting ──────────────────────────
    // Enforced here rather than asked for in the prompt. The live system
    // prompt has said "you must run at least one web_search first — no
    // exceptions, regardless of how confident you are" since 2026-07, and the
    // desk still answered a question about a company's listing status from
    // memory. A requirement the model can decline is not a requirement.
    if (!searchForced && !sources.length) {
      searchForced = true;
      messages.push({ role: 'assistant', content: msg.content });
      messages.push({ role: 'user', content: NO_SEARCH_NOTE });
      continue;
    }

    if (verifyThisTurn && !verified) {
      verified = true;   // one revision pass, never a loop
      const draft = textOf(msg);
      const gaps = draft ? await auditDraft(draft) : [];
      if (gaps.length) {
        unsupported = gaps;
        messages.push({ role: 'assistant', content: msg.content });
        messages.push({
          role: 'user',
          content:
            'These claims in your answer are not supported by the data you actually gathered:\n' +
            gaps.map((g) => `- ${g}`).join('\n') +
            '\n\nRewrite the answer using only what the evidence supports. Correct the numbers to what the ' +
            'payloads say, or drop the claim and state that you could not verify it. Do not repeat an ' +
            'unsupported figure.',
        });
        continue;
      }
    }

    break; // end_turn or other terminal reason
  }

  const answer = textOf(finalMsg);
  if (!answer) return reply(502, { ok: false, error: 'empty model response' });

  // ── memory append (FR-MEM1) — non-fatal ────────────────────────────────────
  try {
    await fetch(`${supaUrl}/rest/v1/desk_chat_memory`, {
      method: 'POST',
      headers: { ...svc, 'content-type': 'application/json', prefer: 'return=minimal' },
      body: JSON.stringify({ user_id: userId, question, answer, model: finalMsg?.model ?? model, sources, usage }),
    });
  } catch (_e) { /* append is best-effort */ }

  // `checked` is reported even while the verifier is dormant, so the flag can
  // be armed later without a client change — and so a run that answered with
  // no search behind it is visible rather than indistinguishable.
  return reply(200, {
    ok: true,
    answer,
    sources,
    model: finalMsg?.model ?? model,
    usage,
    checked: {
      searched: sources.length > 0,
      forcedSearch: searchForced,
      verified: verifyThisTurn,
      requested: askedToVerify,   // typed on this question, vs armed globally
      unsupported,
    },
  });
});
