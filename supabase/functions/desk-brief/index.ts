// ── desk-brief — AI daily brief → desk_ai_briefs, on the Supabase Cron ───────
// Replaces the nightly generate-brief.js step (retire-nightly-pipeline plan,
// Group B). Same forced-tool-call structure, same FR-AI4 grounding guard
// VERBATIM (every cited dollar figure must trace to the grounding set or the
// brief is not stored) — only two things changed: the scheduler (pg_cron
// 23:05/10:05 UTC via net.http_post) and the market/news grounding source
// (the live desk-market/desk-news functions instead of committed data/*.json).
//
// NOT public surface: requires the x-cron-secret header (CRON_SECRET env).
// Secrets (function env): ANTHROPIC_API_KEY, CRON_SECRET; optional BRIEF_MODEL.

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// claude-api skill default — never downgrade for cost; override via BRIEF_MODEL.
const MODEL = () => Deno.env.get('BRIEF_MODEL') || 'claude-opus-4-8';

const BRIEF_TOOL = {
  name: 'record_brief',
  description: 'Record the daily portfolio brief in its exact display structure.',
  input_schema: {
    type: 'object',
    properties: {
      state: { type: 'string', description: 'Portfolio state: 2-3 sentences — total net liquidation, day P&L direction with the leading account, notable concentration. Cite only numbers from the grounding data.' },
      levels: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 4, description: 'Key levels/facts: largest open P&L position, cash %, one market-level observation from the market data.' },
      scenarios: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 3, description: 'Forward scenarios grounded in the news/market data, phrased as risk observations, never advice.' },
    },
    required: ['state', 'levels', 'scenarios'],
  },
};

// ── FR-AI4 grounding guard (verbatim ports of generate-brief.js) ────────────
// deno-lint-ignore no-explicit-any
export function groundingNumbers(snapshots: any[], market: any): number[] {
  const nums: number[] = [];
  for (const s of snapshots) {
    nums.push(s.nav, s.day_pnl, s.total_unrl, s.cash);
    for (const p of (Array.isArray(s.positions) ? s.positions : [])) nums.push(p.mkt, p.unrl);
  }
  nums.push(
    // deno-lint-ignore no-explicit-any
    snapshots.reduce((t: number, s: any) => t + Number(s.nav), 0),
    // deno-lint-ignore no-explicit-any
    snapshots.reduce((t: number, s: any) => t + Number(s.day_pnl), 0),
    // deno-lint-ignore no-explicit-any
    snapshots.reduce((t: number, s: any) => t + Number(s.cash), 0),
  );
  for (const t of market?.tiles || []) nums.push(Number(String(t.last).replace(/[,%]/g, '')));
  return nums.map(Number).filter(Number.isFinite).map(Math.abs);
}

// deno-lint-ignore no-explicit-any
export function validateGrounding(brief: any, allowed: number[]): { ok: boolean; bad: number[] } {
  const text = [brief.state, ...brief.levels, ...brief.scenarios].join(' ');
  const cited = [...text.matchAll(/\$([\d,]+(?:\.\d+)?)\s*([KkMm])?/g)]
    .map((m) => Number(m[1].replace(/,/g, '')) * (/[Kk]/.test(m[2] || '') ? 1e3 : /[Mm]/.test(m[2] || '') ? 1e6 : 1));
  const bad = cited.filter((v) => !allowed.some((a) => a > 0 && Math.abs(v - a) / a <= 0.005 || Math.abs(v - a) <= 1));
  return { ok: bad.length === 0, bad };
}

// deno-lint-ignore no-explicit-any
export function buildPrompt(snapshots: any[], market: any, news: any, asOf: string): string {
  const grounding = {
    as_of: asOf,
    // deno-lint-ignore no-explicit-any
    accounts: snapshots.map((s: any) => ({
      account: 'Account ' + s.account_key,
      nav: Number(s.nav), day_pnl: Number(s.day_pnl), total_unrealized: Number(s.total_unrl), cash: Number(s.cash),
      // deno-lint-ignore no-explicit-any
      positions: (Array.isArray(s.positions) ? s.positions : []).map((p: any) => ({ sym: p.sym, mkt: p.mkt, unrl: p.unrl, dayPct: p.dayPct })),
    })),
    // deno-lint-ignore no-explicit-any
    market: (market?.tiles || []).map((t: any) => ({ name: t.name, last: t.last, day_change_pct: t.chg })),
    // deno-lint-ignore no-explicit-any
    headlines: (news?.items || []).slice(0, 8).map((n: any) => n.h),
  };
  return 'You are the analyst for a private two-account trading desk. Write today\'s brief from ONLY the grounding data below — never invent a number, never give advice, keep the register factual and terse.\n\n<grounding>\n'
    + JSON.stringify(grounding, null, 1) + '\n</grounding>\n\nRecord the brief with the record_brief tool.';
}

// deno-lint-ignore no-explicit-any
async function callAnthropic(prompt: string): Promise<any> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': Deno.env.get('ANTHROPIC_API_KEY')!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL(),
      max_tokens: 4000,
      tools: [BRIEF_TOOL],
      tool_choice: { type: 'tool', name: 'record_brief' },
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const msg = await res.json();
  if (msg.stop_reason === 'refusal') throw new Error('model declined the request (stop_reason=refusal)');
  // deno-lint-ignore no-explicit-any
  const call = (msg.content || []).find((b: any) => b.type === 'tool_use' && b.name === 'record_brief');
  if (!call) throw new Error('no record_brief tool call in response (stop_reason=' + msg.stop_reason + ')');
  return call.input;
}

// live grounding feeds (anon-callable siblings on this same project)
// deno-lint-ignore no-explicit-any
async function liveFeed(name: string): Promise<any> {
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const anon = Deno.env.get('SUPABASE_ANON_KEY')!;
    const res = await fetch(`${url}/functions/v1/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: anon, authorization: `Bearer ${anon}` },
      body: '{}',
    });
    const out = await res.json().catch(() => null);
    return out?.ok ? out : null; // brief tolerates a missing feed — fewer grounding numbers, guard unchanged
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return reply(405, { ok: false, error: 'POST only' });
  const secret = Deno.env.get('CRON_SECRET');
  if (!secret || req.headers.get('x-cron-secret') !== secret) {
    return reply(401, { ok: false, error: 'cron secret required' });
  }
  if (!Deno.env.get('ANTHROPIC_API_KEY')) return reply(200, { ok: false, status: 'skipped', detail: 'ANTHROPIC_API_KEY not set' });

  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const headers = { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' };

    const users = await (await fetch(`${url}/rest/v1/desk_users?select=id&is_test=eq.false&limit=1`, { headers })).json();
    if (!users?.length) throw new Error('no owner row in desk_users');
    const userId = users[0].id;

    const rows = await (await fetch(
      `${url}/rest/v1/desk_account_snapshots?select=account_key,label,as_of,nav,day_pnl,total_unrl,cash,positions&user_id=eq.${userId}&order=as_of.desc&limit=40`,
      { headers },
    )).json();
    // deno-lint-ignore no-explicit-any
    const latest = new Map<number, any>();
    for (const r of rows || []) if (!latest.has(r.account_key)) latest.set(r.account_key, r);
    // deno-lint-ignore no-explicit-any
    const snapshots = [...latest.values()].sort((a: any, b: any) => a.account_key - b.account_key);
    if (!snapshots.length) return reply(200, { ok: false, status: 'skipped', detail: 'no snapshots to ground on' });

    // deno-lint-ignore no-explicit-any
    const asOf = snapshots.map((s: any) => s.as_of).sort().at(-1);
    const [market, news] = await Promise.all([liveFeed('desk-market'), liveFeed('desk-news')]);

    const brief = await callAnthropic(buildPrompt(snapshots, market, news, asOf));
    if (typeof brief.state !== 'string' || !Array.isArray(brief.levels) || !Array.isArray(brief.scenarios)) {
      throw new Error('brief JSON failed shape validation');
    }
    const check = validateGrounding(brief, groundingNumbers(snapshots, market));
    if (!check.ok) throw new Error('brief cited ungrounded dollar figures: ' + check.bad.join(', ') + ' — not stored (FR-AI4)');

    const up = await fetch(`${url}/rest/v1/desk_ai_briefs?on_conflict=user_id,as_of`, {
      method: 'POST',
      headers: { ...headers, prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify([{ user_id: userId, as_of: asOf, generated_at: new Date().toISOString(), model: MODEL(), content: brief }]),
    });
    if (!up.ok) throw new Error(`brief upsert ${up.status}: ${(await up.text()).slice(0, 120)}`);
    return reply(200, { ok: true, status: 'ok', asOf, model: MODEL() });
    // deno-lint-ignore no-explicit-any
  } catch (e: any) {
    console.error('desk-brief failed:', String(e?.message || e));
    return reply(200, { ok: false, status: 'failed', detail: String(e?.message || e) });
  }
});
