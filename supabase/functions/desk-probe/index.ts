// desk-probe — THROWAWAY diagnostic, owner-approved 2026-10-01 ("yes, deploy the test function").
//
// WHY: desk-econ's Treasury tail timed out from Supabase's servers (both monthly fetches hit the 5s
// limit, 2026-10-01 00:10Z) and the build sandbox cannot reach home.treasury.gov, CNBC or Stooq at
// all, so nobody can tell whether Treasury is BLOCKING Supabase, merely SLOW, or whether a live
// 2Y/10Y source exists. This function answers that from the one place that matters: it fetches a
// FIXED list of public URLs with a generous 20s limit and reports status, time, size and a short
// sample of each. Nothing else.
//
// SAFETY: fixed targets only (no request data ever reaches a URL, so it is not an open proxy), GET/POST
// only, the site's Origin required, one run per 20s per isolate, no service key, no database, no secrets,
// and it SELF-DISABLES at EXPIRES_AT (answers 410 and fetches nothing). The Supabase tools in use cannot
// delete a function, so expiry is what makes leaving it deployed harmless; delete it from the dashboard
// when convenient.
//
// Dedicated project only (kwugzhyfjevzwgplhtsd). verify_jwt ON.

const SITE_ORIGIN = 'https://akyachtsman.github.io';
const EXPIRES_AT = Date.parse('2026-10-01T04:00:00Z');
const COOLDOWN_MS = 20_000;
const TIMEOUT_MS = 20_000;
const SAMPLE_CHARS = 700;
const UA = { 'user-agent': 'Mozilla/5.0 (desk probe; +https://akyachtsman.github.io/claude.trading/)' };

type Target = { id: string; url: string };
const TARGETS: Target[] = [
  // the exact URL desk-econ uses for the Treasury tail (month form)
  { id: 'treasury_csv_month', url: 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/all/202609?type=daily_treasury_yield_curve&field_tdr_date_value_month=202609&page&_format=csv' },
  // the same file by YEAR, and the XML feed of the same data: is it the URL form or the host?
  { id: 'treasury_csv_year', url: 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/2026/all?type=daily_treasury_yield_curve&field_tdr_date_value=2026&page&_format=csv' },
  { id: 'treasury_xml_month', url: 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value_month=202609' },
  // live intraday yields for 2Y / 10Y / 20Y (unofficial endpoint)
  { id: 'cnbc_quote', url: 'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=US2Y%7CUS10Y%7CUS20Y&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json' },
  // live 10Y (CBOE yield index) — Yahoo is already reached from this project by quote-proxy / desk-market
  { id: 'yahoo_tnx', url: 'https://query1.finance.yahoo.com/v8/finance/chart/%5ETNX?range=1d&interval=5m' },
  // Stooq yield symbols (Stooq is already reached from this project by desk-news)
  { id: 'stooq_2y', url: 'https://stooq.com/q/l/?s=2yusy.b&f=sd2t2c&h&e=csv' },
  { id: 'stooq_10y', url: 'https://stooq.com/q/l/?s=10yusy.b&f=sd2t2c&h&e=csv' },
];

async function probe(t: Target) {
  const t0 = Date.now();
  try {
    const r = await fetch(t.url, { headers: UA, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'follow' });
    const text = await r.text();
    return {
      id: t.id, ok: r.ok, status: r.status, ms: Date.now() - t0,
      contentType: r.headers.get('content-type'), bytes: text.length,
      finalUrl: r.url && r.url !== t.url ? r.url : undefined,
      sample: text.slice(0, SAMPLE_CHARS),
    };
  } catch (e) {
    const err = e as Error;
    return { id: t.id, ok: false, status: 0, ms: Date.now() - t0, error: `${err.name}: ${err.message}` };
  }
}

let lastRun = 0;
Deno.serve(async (req: Request) => {
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o, null, 1), {
    status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
  if (Date.now() > EXPIRES_AT) return json({ ok: false, expired: true }, 410);
  if (req.headers.get('origin') !== SITE_ORIGIN) return json({ ok: false, error: 'origin not allowed' }, 403);
  if (req.method !== 'POST' && req.method !== 'GET') return json({ ok: false, error: 'method' }, 405);
  const now = Date.now();
  if (now - lastRun < COOLDOWN_MS) return json({ ok: false, error: 'cooldown' }, 429);
  lastRun = now;
  const results = await Promise.all(TARGETS.map(probe));
  return json({ ok: true, at: new Date().toISOString(), timeoutMs: TIMEOUT_MS, results });
});
