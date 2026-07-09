# Brief — Multi-Account Trading Dashboard

## Problem (one sentence)
The owner holds several Interactive Brokers accounts and has no single screen
that shows them side by side with charts, market context, and analysis — each
account must be checked separately inside IBKR's own tools.

## Users & current alternative
- **Primary:** the repo owner, monitoring his own IBKR accounts daily.
- **Today instead:** logging into IBKR Client Portal / PortfolioAnalyst per
  account; no consolidated, chart-first, always-on dashboard.

## Definition of done (smallest useful version)
A GitHub Pages dashboard that on one screen shows:
1. **Per-account windows** — one panel per IBKR account: balance/NAV, day and
   total P&L, positions.
2. **Charts** — equity-curve / P&L charts per account and combined.
3. **Market summary** — index/futures snapshot strip.
4. **News feed** — headline stream, ticker-tagged where possible.
5. **AI trading commentary** — a generated daily brief over the portfolio and
   market context, clearly labeled as informational, not financial advice.

Ambition bar: **TradingView / terminal-grade** — dense, dark, chart-heavy,
professional. Production-grade, not a skeleton.

## Risks (riskiest part first)
- **Data path:** IBKR data must reach a static page without exposing
  credentials. Chosen mitigation: scheduled GitHub Actions pull IBKR Flex
  Query reports (token as repo secret) and commit JSON snapshots; the page
  renders committed data only. If Flex tokens/queries prove insufficient for
  desired freshness, escalate to Supabase (per data directive) — decision
  revisited at `plan`.
- **AI commentary:** needs an LLM key — must run server-side (scheduled
  Action), never in the browser; output must carry a not-advice disclaimer.
- **Public repo = public data:** committed account snapshots are visible.
  Options (decide at `clarify`): private repo, redacted/relative values, or a
  client-side gate + Supabase. Must be resolved before real account data lands.

## Constraints / non-negotiables
- Inherited directives (global/design/test/data) are the constitution.
- Static tier: plain HTML/CSS/vanilla JS, no local build, GitHub Pages.
- iPad Safari support; WCAG AA contrast; `textContent` only for dynamic text.
- No secrets client-side or committed; keys live as GitHub Actions secrets.
- No external automation platforms — schedulers are GitHub Actions.

## Out of scope (v1)
- Order placement / trade execution of any kind.
- Real-time streaming quotes (snapshot cadence is Actions-driven).
- Multi-user access, auth, or sharing.
- Brokers other than Interactive Brokers.

## Chosen approach & why
Static GitHub Pages app + scheduled GitHub Actions data pipeline (IBKR Flex
reports, market data, news, AI brief → committed JSON). Zero servers, keys
stay in Actions secrets, fits the repo's standard automation model, and the
UI can be built and approved on realistic demo JSON before real tokens exist.

## Alternatives considered
- **Supabase backend** — better freshness/auth, more moving parts; deferred
  until static tier proves insufficient (explicit graduation path).
- **IBKR Client Portal Gateway** — richer live API but requires a constantly
  running authenticated gateway process; incompatible with a no-server model.
- **Manual CSV import** — zero automation value; rejected as primary path.

## Open items for `clarify`
- Number of IBKR accounts and their labels.
- Privacy handling of committed account data (private repo vs redaction).
- Preferred news / market-data sources (free tiers vs paid keys).
- Snapshot cadence (daily after close vs intraday).
