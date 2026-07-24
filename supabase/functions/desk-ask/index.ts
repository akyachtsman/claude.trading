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
  'Use get_quote(symbol) for a live price + fundamentals on any ticker, get_technicals(symbol) for a real computed RSI(14) / Stochastic(14-3-3) oscillator reading — never estimate, recall, or web-search for an RSI/stochastic/overbought/oversold number, always call get_technicals for it — and web_search / web_fetch for anything not on the page (earnings, news, current events). PRIVACY: never put the owner\'s real position sizes, share counts, dollar balances, or account identifiers into a web_search or web_fetch query — search by ticker or topic only.',
  "Keep answers focused and skimmable. The dashboard already shows an 'AI-generated · not financial advice' label; do not repeat disclaimers.",
].join(' ');

const TOOLS = [
  { type: 'web_search_20260209', name: 'web_search', max_uses: 5 },
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
    description: 'Real computed technical-oscillator reading for one ticker on DAILY bars: RSI(14, Wilder-smoothed) and the slow Stochastic %K/%D (14-3-3 — the identical calculation and timeframe as the dashboard\'s own Pro 1 chart). Use this whenever asked about RSI, stochastic, overbought, or oversold — never estimate or guess these from memory, the dashboard snapshot, or a web search; this computes them directly from live OHLC data.',
    input_schema: {
      type: 'object',
      properties: { symbol: { type: 'string', description: 'Ticker, e.g. AAPL' } },
      required: ['symbol'],
    },
  },
];
const CLIENT_TOOL_NAMES = new Set(['get_quote', 'get_technicals']);

const MAX_TOOL_CALLS = 6;      // client tool executions (get_quote + get_technicals) per turn
const MAX_RESUMES = 3;         // pause_turn resumptions
const MAX_ITERS = 12;         // overall loop safety net (tool calls + resumes + wrap-up)
const REPLAY_ROWS = 20;        // prior exchanges considered
const REPLAY_DAYS = 30;
const REPLAY_CHAR_BUDGET = 32000;  // ~8k tokens of history

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply(405, { ok: false, error: 'POST only' });

  let payload: { pin?: unknown; question?: unknown; context?: unknown };
  try { payload = await req.json(); } catch { return reply(400, { ok: false, error: 'invalid JSON body' }); }
  const pin = String(payload.pin ?? '');
  const question = String(payload.question ?? '').slice(0, 2000).trim();
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
  const model = Deno.env.get('ASK_MODEL') || 'claude-opus-4-8';

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
  // slow Stochastic(14-3-3) server-side — the exact algorithm scripts/data.js's
  // stochSeries() uses for the Pro 1 daily chart, ported here so the reading
  // the model quotes matches what the owner sees on-screen.
  const STOCH_K = 14, STOCH_K_SMOOTH = 3, STOCH_D = 3, RSI_LEN = 14;
  const STOCH_WARMUP = STOCH_K + STOCH_K_SMOOTH + STOCH_D - 2; // 18
  async function getTechnicals(symbol: string): Promise<Record<string, unknown>> {
    try {
      const qr = await fetch(`${supaUrl}/functions/v1/quote-proxy`, {
        method: 'POST',
        headers: { ...svc, 'content-type': 'application/json', origin: SITE_ORIGIN },
        body: JSON.stringify({ symbol, kind: 'daily' }),
      });
      const j = await qr.json();
      if (!qr.ok || !j.ok) return { ok: false, error: j.error || `daily bars fetch failed (HTTP ${qr.status})` };
      const s = j.series as { t: string[]; h: number[]; l: number[]; c: number[] };
      const n = s.c.length;
      if (n < Math.max(STOCH_WARMUP, RSI_LEN + 1)) {
        return { ok: false, error: `not enough price history for ${symbol} to compute a reading` };
      }

      // fast %K over a 14-bar high/low window, then two 3-period SMA smooths
      // (slow %K, then %D) — identical to stochSeries() in scripts/data.js.
      const raw: (number | null)[] = new Array(n).fill(null);
      for (let i = STOCH_K - 1; i < n; i++) {
        let hi = -Infinity, lo = Infinity;
        for (let k = i - STOCH_K + 1; k <= i; k++) { if (s.h[k] > hi) hi = s.h[k]; if (s.l[k] < lo) lo = s.l[k]; }
        raw[i] = hi === lo ? 50 : (s.c[i] - lo) / (hi - lo) * 100;
      }
      const sma = (arr: (number | null)[], len: number) => arr.map((_, i) => {
        if (i < len - 1) return null;
        let sum = 0;
        for (let k = i - len + 1; k <= i; k++) { if (arr[k] == null) return null; sum += arr[k] as number; }
        return sum / len;
      });
      const kLine = sma(raw, STOCH_K_SMOOTH);
      const dLine = sma(kLine, STOCH_D);
      const stochK = kLine[n - 1], stochD = dLine[n - 1];

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

      return {
        ok: true, symbol, asOf: s.t[n - 1],
        stochK: stochK != null ? Number(stochK.toFixed(2)) : null,
        stochD: stochD != null ? Number(stochD.toFixed(2)) : null,
        rsi14: Number(rsi14.toFixed(2)),
        note: 'stochK/stochD: slow Stochastic 14-3-3 on daily bars, same as the dashboard\'s Pro 1 chart. rsi14: standard 14-period RSI (Wilder). Conventional zones: stochastic <20 oversold / >80 overbought; RSI <30 oversold / >70 overbought.',
      };
    } catch (e) {
      return { ok: false, error: 'technicals fetch error: ' + (e instanceof Error ? e.message : String(e)) };
    }
  }

  const contextJson = JSON.stringify(payload.context ?? {}).slice(0, 30000);
  messages.push({ role: 'user', content: `Dashboard snapshot (JSON):\n${contextJson}\n\nQuestion: ${question}` });

  // ── agentic loop (FR-WEB/FR-DATA) ──────────────────────────────────────────
  const sources: { title: string; url: string }[] = [];
  const seenUrls = new Set<string>();
  // deno-lint-ignore no-explicit-any
  let finalMsg: any = null;
  let toolCalls = 0, resumes = 0, iters = 0;

  for (;;) {
    if (iters++ >= MAX_ITERS) break;   // hard stop; finalMsg holds the last response
    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 2048, system: SYSTEM, tools: TOOLS, messages }),
    });
    if (!apiRes.ok) return reply(502, { ok: false, error: `model call failed (HTTP ${apiRes.status})` });
    const msg = await apiRes.json();
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
      }
      messages.push({ role: 'assistant', content: msg.content });
      messages.push({ role: 'user', content: results });
      continue;
    }

    break; // end_turn or other terminal reason
  }

  const answer = (finalMsg?.content ?? [])
    .filter((b: { type: string }) => b.type === 'text')
    .map((b: { text: string }) => b.text).join('\n').trim();
  if (!answer) return reply(502, { ok: false, error: 'empty model response' });

  // ── memory append (FR-MEM1) — non-fatal ────────────────────────────────────
  try {
    await fetch(`${supaUrl}/rest/v1/desk_chat_memory`, {
      method: 'POST',
      headers: { ...svc, 'content-type': 'application/json', prefer: 'return=minimal' },
      body: JSON.stringify({ user_id: userId, question, answer, model: finalMsg?.model ?? model, sources }),
    });
  } catch (_e) { /* append is best-effort */ }

  return reply(200, { ok: true, answer, sources, model: finalMsg?.model ?? model });
});
