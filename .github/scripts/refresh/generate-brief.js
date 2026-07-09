'use strict';
/* ── generate-brief.js — AI daily brief → desk_ai_briefs (private domain) ────
   Grounding context = latest private snapshots + committed market.json +
   news.json. Anthropic Messages API via raw HTTP (shell/no-SDK context, per
   the claude-api skill); structured JSON enforced by a forced tool call whose
   input_schema IS the brief shape. Every dollar figure the model cites is
   validated against the grounding numbers before storing — any failure ⇒ no
   write, panel shows stale per FR-AI4. Runs ONLY inside the workflow; the
   API key never reaches the client. */
import path from 'node:path';
import { DATA_DIR, retryFetch, readJsonIfExists, writeStatus, notice, errorLine } from './lib/util.js';
import { supaConfigured, ownerUserId, latestSnapshots, supaUpsert } from './supa.js';

/* claude-api skill default — never downgrade for cost; override via BRIEF_MODEL. */
const MODEL = process.env.BRIEF_MODEL || 'claude-opus-4-8';

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

/* Every $-figure in the brief must trace to the grounding set (FR-AI grounding
   bar): allow rounding to whole dollars/K/M within 0.5%. Pure — fixture-tested. */
export function groundingNumbers(snapshots, market) {
  const nums = [];
  for (const s of snapshots) {
    nums.push(s.nav, s.day_pnl, s.total_unrl, s.cash);
    for (const p of (Array.isArray(s.positions) ? s.positions : [])) nums.push(p.mkt, p.unrl);
  }
  nums.push(
    snapshots.reduce((t, s) => t + Number(s.nav), 0),
    snapshots.reduce((t, s) => t + Number(s.day_pnl), 0),
    snapshots.reduce((t, s) => t + Number(s.cash), 0),
  );
  for (const t of market?.tiles || []) nums.push(Number(String(t.last).replace(/[,%]/g, '')));
  return nums.map(Number).filter(Number.isFinite).map(Math.abs);
}

export function validateGrounding(brief, allowed) {
  const text = [brief.state, ...brief.levels, ...brief.scenarios].join(' ');
  const cited = [...text.matchAll(/\$([\d,]+(?:\.\d+)?)\s*([KkMm])?/g)]
    .map(m => Number(m[1].replace(/,/g, '')) * (/[Kk]/.test(m[2] || '') ? 1e3 : /[Mm]/.test(m[2] || '') ? 1e6 : 1));
  const bad = cited.filter(v => !allowed.some(a => a > 0 && Math.abs(v - a) / a <= 0.005 || Math.abs(v - a) <= 1));
  return { ok: bad.length === 0, bad };
}

export function buildPrompt(snapshots, market, news, asOf) {
  const grounding = {
    as_of: asOf,
    accounts: snapshots.map(s => ({
      account: 'Account ' + s.account_key,
      nav: Number(s.nav), day_pnl: Number(s.day_pnl), total_unrealized: Number(s.total_unrl), cash: Number(s.cash),
      positions: (Array.isArray(s.positions) ? s.positions : []).map(p => ({ sym: p.sym, mkt: p.mkt, unrl: p.unrl, dayPct: p.dayPct })),
    })),
    market: (market?.tiles || []).map(t => ({ name: t.name, last: t.last, day_change_pct: t.chg })),
    headlines: (news?.items || []).slice(0, 8).map(n => n.h),
  };
  return 'You are the analyst for a private two-account trading desk. Write today\'s brief from ONLY the grounding data below — never invent a number, never give advice, keep the register factual and terse.\n\n<grounding>\n'
    + JSON.stringify(grounding, null, 1) + '\n</grounding>\n\nRecord the brief with the record_brief tool.';
}

async function callAnthropic(prompt) {
  const res = await retryFetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      tools: [BRIEF_TOOL],
      tool_choice: { type: 'tool', name: 'record_brief' },
      messages: [{ role: 'user', content: prompt }],
    }),
  }, { tries: 3, baseMs: 5000 });
  const msg = await res.json();
  if (msg.stop_reason === 'refusal') throw new Error('model declined the request (stop_reason=refusal)');
  const call = (msg.content || []).find(b => b.type === 'tool_use' && b.name === 'record_brief');
  if (!call) throw new Error('no record_brief tool call in response (stop_reason=' + msg.stop_reason + ')');
  return call.input;
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    notice('AI brief skipped', 'ANTHROPIC_API_KEY not set — brief panel will show its last stored brief (add the secret to go live).');
    await writeStatus('brief', { status: 'skipped', detail: 'ANTHROPIC_API_KEY not set' });
    return;
  }
  if (!supaConfigured()) {
    notice('AI brief skipped', 'DB_URL / DB_SERVICE_KEY not set — nowhere to store the brief.');
    await writeStatus('brief', { status: 'skipped', detail: 'DB secrets not set' });
    return;
  }
  const userId = await ownerUserId();
  const snapshots = await latestSnapshots(userId);
  if (!snapshots.length) {
    notice('AI brief skipped', 'no account snapshots yet — the brief grounds on IBKR data (run after the first IBKR upsert).');
    await writeStatus('brief', { status: 'skipped', detail: 'no snapshots to ground on' });
    return;
  }
  const asOf = snapshots.map(s => s.as_of).sort().at(-1);
  const market = await readJsonIfExists(path.join(DATA_DIR, 'market.json'));
  const news = await readJsonIfExists(path.join(DATA_DIR, 'news.json'));

  const brief = await callAnthropic(buildPrompt(snapshots, market, news, asOf));
  if (typeof brief.state !== 'string' || !Array.isArray(brief.levels) || !Array.isArray(brief.scenarios)) {
    throw new Error('brief JSON failed shape validation');
  }
  const check = validateGrounding(brief, groundingNumbers(snapshots, market));
  if (!check.ok) throw new Error('brief cited ungrounded dollar figures: ' + check.bad.join(', ') + ' — not stored (FR-AI4)');

  await supaUpsert('desk_ai_briefs', [{
    user_id: userId,
    as_of: asOf,
    generated_at: new Date().toISOString(),
    model: MODEL,
    content: brief,
  }], 'user_id,as_of');
  await writeStatus('brief', { status: 'ok', asOf });
  console.log(`AI brief stored for ${asOf} (${MODEL})`);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch(async err => {
    errorLine('AI brief failed', String(err.message || err));
    await writeStatus('brief', { status: 'failed', detail: String(err.message || err) });
    process.exit(1);
  });
}
