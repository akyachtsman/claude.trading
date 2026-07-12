# Stochastic Investing

> Desk strategy file #1. Distilled from the owner's Phil's Gang course
> materials (Definitions lesson, 2026-07) — method and rules restated in our
> own words, not course content. One file per strategy; this is the angle the
> watchlist-charts panel is built to serve.

## The three tiers

The strategy runs at three horizons simultaneously — the three workspace
panes in the source platform are not just layouts, they are the tiers
(owner, 2026-07-12):

| Tier | Pane | Horizon | Pane setup (from the reference screenshot) |
|---|---|---|---|
| **Pro 1** | left | **Short-term trading** | Daily candles, moving average, R/S ladder (R3/R1/S1/S3), volume + stochastic |
| **Pro 2** | middle | **Long-term trading** | Daily candles over a longer window, volume + stochastic strips |
| **Pro 3** | right | **Day trading** | Intraday bars with Bollinger-style bands, volume |

Workbench coverage: our panel serves the Pro 1/Pro 2 tiers today (EOD daily
+ weekly data); the Pro 3 day-trading tier requires intraday data — the
quote-proxy backend, which is its own approval-gated phase.

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

## The stochastic cycle (Stochastic Lesson)

Anatomy of one full cycle, %K vs %D between the bands:

1. **Entry trigger = the bottom crossover.** %K crossing UP through %D while
   both sit at/below the oversold band. Being oversold is a condition; the
   cross is the signal.
2. **The Sweet Spot** is the mid-range between the bands — where the
   strongest, freshest part of the move happens after a bottom cross. The
   base pattern: enter on the cross, ride the sweet spot.
3. **Exit warning = the top roll.** Lines enter the overbought band, then %K
   rolls back down through %D and drops out of the band — that exit from the
   band is the take-profits zone, mirrored from the entry.
4. **The pinned/embedded exception.** In a strong trend the stochastic can
   ride flat ALONG the overbought band while price keeps stair-stepping
   higher. Pinned-overbought = trend strength, not an automatic sell. The
   sell signal remains the roll-and-drop-out, never the level alone.
5. **The failure case.** A fast spike into overbought that immediately
   collapses back through the sweet spot to oversold marks a failed move —
   the pattern not to chase (and the short-side read of the same anatomy).
6. **Dual-timeframe confirmation.** Read the identical anatomy on daily and
   weekly at once: the daily produces these cycle signals frequently; the
   weekly says which half of the cycle the TREND is in. Take daily entries
   in the direction the weekly permits.

*Study note: distilled from the drawn animation (visual channel); narration
was unavailable — spoken-only nuances may be missing pending owner review.*

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
