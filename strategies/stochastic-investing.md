# Stochastic Investing

> Desk strategy file #1. Distilled from the owner's Phil's Gang course
> materials (Definitions lesson, 2026-07) — method and rules restated in our
> own words, not course content. One file per strategy; this is the angle the
> watchlist-charts panel is built to serve.

## Core idea

Time entries and exits with a **slow stochastic oscillator read on two
timeframes at once**: the **daily** stochastic gives the short-term move, the
**weekly** stochastic gives the long-term trend. Trade in the direction the
weekly allows; use the daily for timing. Price levels come from a ladder of
support/resistance lines; risk is managed with stops and hard hygiene rules
(volume floor, earnings avoidance).

## The indicator

- **Slow stochastic**, two lines: `%K` (the reading) and `%D` (a short moving
  average of `%K` that acts as the signal line). Bounded 0–100 regardless of
  how far price actually travels.
- **Source parameters: %K = 10, %D = 3** ("slow smooth K-10 D-3"), applied
  identically to daily bars and weekly bars.
- **Owner's spoken convention: "13 weeks"** for the weekly lookback.
- ⚠️ **OPEN QUESTION (owner ruling needed):** the course charts run 10-3; the
  owner specified 13. The workbench currently renders **13-3-3** on both
  timeframes (`STOCH` constant in `scripts/data.js`). Flip to 10-3 by editing
  that one constant once ruled.
- Readings: high band = overbought, low band = oversold (the workbench draws
  guides at 80/20). The daily oscillates fast; the weekly turns slowly — a
  weekly turn is trend information, not noise.

## Price levels

- Resistance ladder **R1…R4** above price, support ladder **S1…S4** below
  (their platform's "MV1" lines). Convention: **R1 is the strongest
  resistance, R4 the weakest; S1 the strongest support, S4 the weakest.**
- Our workbench draws classic floor-trader **monthly pivots (R3…S3)** instead
  — same job (a ladder of reference levels), different formula. Mapping note:
  do not assume our R1 equals their R1.
- **Breakout entry pattern:** a buy-stop placed just above a resistance line
  (R1/R2/R3) so that only a momentum break through the level triggers the
  entry. The stop-order mechanics matter: stop → becomes market or limit
  order once the level trades.

## Desk rules (the hygiene layer)

1. **Volume floor:** only trade names with daily volume ≥ **500,000** shares.
   Thin books make every other rule unreliable.
2. **Earnings:** take profits before a position's earnings date; hold at most
   a **Scout** through the print.
3. **Scout:** a single share kept in a name purely to stay attentive to it —
   engagement, not exposure.
4. **Stops:** every position carries one. Stop-market fills reliably
   (guaranteed fill, not price); stop-limit guarantees price, not fill —
   prefer stop-market for protection.
5. **Shorting without shorting:** express bearish views long-only via inverse
   ETFs (e.g., SDS/SH against SPY).
6. **Liquidity check:** bid/ask spread is the liquidity gauge — tighter is
   better; wide spreads compound the volume-floor risk.
7. **Capitulation** (panic selling on heavy volume after extended declines)
   is a regime marker: expect it near correction lows; it often precedes the
   washout that resets the weekly stochastic.

## Candle vocabulary

Reversal-watch patterns the method names: **doji** (wick/tail, tiny body),
**spindle** (long wick *and* tail, small body), **hammer** (long tail) and
**inverted hammer** — read at support/resistance and stochastic extremes, not
in isolation.

## How the workbench serves this strategy

| Method element | Panel feature (as of PR #32) |
|---|---|
| Daily + weekly stochastic, side by side | Two strips: `STOCH 13-3-3 · DAILY` and `· WEEKLY (13)` with 80/20 guides |
| Level ladder | Monthly pivots R3…S3, dashed + labeled |
| OHLC per bar | Candles + crosshair readout (O/H/L/C, day %, volume) |
| Volume floor check | Volume sub-pane per bar |
| Timeframes | 3M/6M/1Y/All zoom |

**Not yet built (candidates for the strategy's phase 2):** overbought/oversold
shading when daily AND weekly agree; their-style S1–S4/R1–R4 level engine;
earnings-date chip (pipeline fetch); volume-floor badge per symbol; doji/
hammer auto-marking.

## Open items

- [ ] Owner ruling: stochastic lookback **10 vs 13** (source deck vs spoken spec)
- [ ] Confirm which timeframe pairs matter beyond daily/weekly (their pro
  tool shows an intraday pane — needs the quote-proxy backend, separate approval)
- [ ] Define the S/R formula the owner actually wants (classic pivots vs
  their ladder)
