// ── desk-ask — PIN-gated Claude Q&A over the dashboard's visible content ────
// Deployed as a Supabase Edge Function (Deno). The browser sends {pin,
// question, context}; the PIN is validated against desk_users with the SAME
// hex(sha256(salt || pin)) scheme as the desk_login RPC, then the question +
// dashboard snapshot go to the Anthropic Messages API. ANTHROPIC_API_KEY
// lives ONLY in the function's secrets — never client-side (FR-D1).
// Missing key ⇒ a plain "not configured" answer, never a crash.

const CORS = {
  'Access-Control-Allow-Origin': '*', // PIN is the gate; the page is public anyway
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } });

const SYSTEM = [
  'You are the desk assistant embedded in a private two-account trading dashboard.',
  'Answer the owner\'s question using ONLY the dashboard snapshot provided —',
  'accounts, positions, market tiles, headlines, and the daily brief. If the',
  'snapshot cannot answer the question, say so plainly instead of guessing.',
  'Never invent numbers; quote them exactly as they appear in the snapshot.',
  'Keep answers to a few short sentences. You are informational only — never',
  'give buy/sell/hold advice; if asked for advice, describe the relevant facts',
  'and risks from the snapshot instead.',
].join(' ');

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply(405, { ok: false, error: 'POST only' });

  let payload: { pin?: unknown; question?: unknown; context?: unknown };
  try { payload = await req.json(); } catch { return reply(400, { ok: false, error: 'invalid JSON body' }); }
  const pin = String(payload.pin ?? '');
  const question = String(payload.question ?? '').slice(0, 2000).trim();
  if (!pin || !question) return reply(400, { ok: false, error: 'pin and question are required' });

  // PIN check — same salted-hash scheme as the desk_login RPC.
  const supaUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const usersRes = await fetch(`${supaUrl}/rest/v1/desk_users?select=salt,pin_hash`, {
    headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}` },
  });
  if (!usersRes.ok) return reply(502, { ok: false, error: 'auth backend unavailable' });
  const users: { salt: string; pin_hash: string }[] = await usersRes.json();
  const enc = new TextEncoder();
  let authed = false;
  for (const u of users) {
    const digest = await crypto.subtle.digest('SHA-256', enc.encode(u.salt + pin));
    const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
    if (hex === u.pin_hash) authed = true; // check every row — no early exit
  }
  if (!authed) return reply(401, { ok: false, error: 'PIN not recognized.' });

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) {
    return reply(503, { ok: false, error: 'Ask service not configured yet — the owner needs to add the ANTHROPIC_API_KEY function secret.' });
  }

  const model = Deno.env.get('ASK_MODEL') || 'claude-opus-4-8';
  const contextJson = JSON.stringify(payload.context ?? {}).slice(0, 30000);
  const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system: SYSTEM,
      messages: [{ role: 'user', content: `Dashboard snapshot (JSON):\n${contextJson}\n\nQuestion: ${question}` }],
    }),
  });
  if (!apiRes.ok) return reply(502, { ok: false, error: `model call failed (HTTP ${apiRes.status})` });
  const msg = await apiRes.json();
  if (msg.stop_reason === 'refusal') return reply(200, { ok: false, error: 'The model declined this question.' });
  const answer = (msg.content ?? [])
    .filter((b: { type: string }) => b.type === 'text')
    .map((b: { text: string }) => b.text).join('\n').trim();
  if (!answer) return reply(502, { ok: false, error: 'empty model response' });
  return reply(200, { ok: true, answer, model: msg.model });
});
