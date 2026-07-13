# Stochastic Investing

> Desk strategy file #1. Distilled from the owner's Phil's Gang course
> materials (Beginner's-license tier, 2026-07) — method and rules restated in
> our own words, not course content. One file per strategy; this is the angle
> the watchlist-charts panel is built to serve.
> Lessons covered — Beginner's license (complete): Definitions · Stochastic
> Lesson · Relative Strength · Bulls and Bears · Earnings · Order Entry ·
> Stops · Taking Profits. Pattern series (in progress): Dark Cloud · Head
> and Shoulders · Power Stocks · W Formations · Doji · PRO 2 Snapback ·
> PRO 2 Quick Lesson · Broken Stair Step · Brothers Grimm. Advanced: Short
> Pro 1/Pro 2 · SMA Lines · Daily Stochastic Pro 1 · Pro 2 and Pro 3 lesson ·
> Pro 3 Basics · 50% Rule · Advanced Pro 2 · Dog Stocks · Shorting w/ Mostafa ·
> Swing Trade vs Position Trade. (Course study complete, 24 lessons.)

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

## Beginner's-license lessons (subcategories)

The course tier this strategy file covers (owner: one more lesson to come).
Each lesson distilled from its video, own words:

### Relative strength
Judge every name AGAINST the benchmark, not in isolation: overlay the stock
with SPY. Relative **strength** = the name rising while SPY falls or stalls;
relative **weakness** = the name falling while SPY rises. Prefer longs in
names showing relative strength; treat relative weakness as disqualifying
(or as the short-side candidate list). The platform read: stock line (green)
vs SPY line (red) on the same pane, both with their stochastics.

### Bulls and bears
Regime first: trace the index trend (higher-highs trendline = bull; the
roll-over through the trendline = bear) and read the WEEKLY stochastic as
the regime confirmation. The regime decides which side of the stochastic
cycle is tradeable — bottom-crosses in a bull, top-rolls/inverse vehicles in
a bear.

### Earnings workflow
Operational companion to the earnings hygiene rule: check the weekly
earnings calendar routinely (their Daily Info page aggregates calendar +
whisper-number tools), know the report date for every holding, review the
chart + stochastics as the date approaches, and de-risk BEFORE the print
(take profits; at most a Scout through earnings).

### Order entry mechanics
Broker-agnostic ticket walkthrough (demoed on two platforms, paper account):
choose market vs limit, set share count and day duration, submit, then
VERIFY — the order in the orders screen and the fill in positions. Market
orders guarantee the fill, limit orders the price (consistent with the
stop-order definitions above). Practice the round trip on paper before real
size.

### Stops
Protection is placed IN THE BROKER, not in your head — the lesson is a
ticket walkthrough of every protective order type on a live position (their
example runs on SH, the inverse ETF, so it covers both directions):
- **Stop-market** ("absolute" stop): trigger price → market order. The
  default for protection — guarantees the exit, not the price.
- **Stop-limit**: trigger + limit pair (e.g., stop $15.31 / limit $14.01) —
  guarantees price, risks no fill in a gap; the pair is set with the limit
  BELOW the stop to leave fill room.
- **Percentage trailing stop**: the stop ratchets up with price by a set
  percent — locks in gains mechanically along the sweet-spot ride.
- **Duration matters**: protective stops run **GTC** (good-till-canceled),
  not Day — protection that expires at the close isn't protection.
- Inverse positions get the mirror treatment (buy-to-cover stops above).
Placement logic follows the levels section: stops live just beyond the
S/R line that invalidates the trade.

### Taking profits
The exit is the stochastic top-roll (see the cycle anatomy): when %K rolls
through %D inside the overbought band and drops out, sell into it — shown
across all three tiers on live charts. Track the gain as taught: current
price minus entry, divided by the current price (their example: in at
$1,000, at $1,500 → 500/1500 ≈ 33%). *Note: conventional return divides by
ENTRY (500/1000 = 50%); the course's divide-by-current convention reads
lower — flagging the discrepancy rather than silently normalizing it.*

## Pattern series (second batch — more to come)

Chart- and candle-pattern recognition lessons; each read WITH the stochastic
and level context, never in isolation.

### Dark Cloud
Bearish reversal candle after strength: a heavy red bar that opens above the
prior green candle's close, then drives deep down into its body. Spotted on
the intraday tier in the example (AAPL) — a sell-into-strength warning when
it prints at resistance or with the stochastic rolling in the overbought
band.

### Head and Shoulders Pattern
The three-peak top — middle peak (head) above two lower shoulders; the low
between the peaks defines the neckline. The pattern completes when price
breaks the neckline, confirming the downtrend (demoed on a name that topped
and bled for months after). The weekly stochastic rolling over as the right
shoulder forms is the tell that the top is real.

### Power Stocks
Trade a curated universe, not the whole market: a fixed roster of liquid
large-cap names, reviewed one by one on the daily tier (MAs + volume +
stochastic). Familiarity compounds — the same names cycled repeatedly
through the stochastic anatomy beat novelty-chasing. This is the course's
version of our watchlist discipline (and pairs with the 500K volume floor).

### Identify W Formations
The W (double bottom): first decline, bounce, retest that HOLDS at or above
the first low, then the breakout through the middle peak — that breakout is
the buy structure. The stochastic typically prints its bottom-cross on the
W's second leg. The red mirror-image M (double top) is the bearish version:
second peak fails at/below the first, breakdown through the middle low.

### Doji
Candle anatomy of indecision: open ≈ close (the cross shape). The lesson's
progression — full body → shrinking body → doji — is momentum dying in one
picture. Variants by geometry: the spindle (long wick AND tail, tiny body)
and Thor's Hammer (long tail, body boxed at the top — bullish at a low; the
inverted version bearish at a high). A doji AT a stochastic extreme or a
level is the reversal candidate; mid-range dojis are noise.

### PRO 2 Snapback Pattern
A long-term-tier (Pro 2) buy setup: in a name whose WEEKLY stochastic is in
an established climb, a sharp multi-day drop against that rising weekly is
the setup — price "snaps back" to the trend rather than breaking it. The
demo (ANF): circled consolidation, a violent dip marked off, then the snap
back up, all while the weekly stochastic's ascent stays intact. The dip
against a healthy weekly is the entry, not the exit.

### PRO 2 Quick Lesson
The two stochastics as nested waves, drawn on one chart (weekly in orange,
daily in blue): the daily cycles several times INSIDE each weekly wave. The
weekly is the governing tide — its bottom-hook caught the entire multi-month
run in the demo — and the daily's repeated cycles within it are the entry
opportunities. The boxed moments where a daily bottom-cross happens WHILE
the weekly is rising are the highest-quality entries (the same
dual-timeframe rule as the cycle anatomy, seen from the Pro 2 chair).

### Broken Stair Step
An uptrend is a staircase: each pullback low is a step that holds above the
prior one. Box the steps; the trend is intact while each new step is
higher. The FIRST step that breaks — a pullback undercutting the prior
boxed low — declares the staircase broken and ends the long thesis (AAPL
demo on the daily tier). This is the structural exit that complements the
stochastic top-roll: whichever fires first gets respected.

### Brothers Grimm
A paired bearish warning on the daily tier: two adjacent boxed candle
clusters at a failed bounce into the moving-average/resistance zone — the
"brothers" — after which the downtrend resumes (AAPL demo during a
sell-off). ⚠️ Visual-only study: the precise defining rules for the pair
are spoken, not drawn — owner should confirm/refine this one's definition.

## Advanced lessons

### Short Pro 2
The short side of the long-term tier (older course name: "Shorting MV2"):
the WEEKLY stochastic topping and rolling out of the overbought band is the
short trigger — the exact mirror of the snapback/bottom-hook buy. Expressed
long-only via inverse ETFs per the desk rules. The weekly roll is the
regime-scale signal; it outranks anything the daily is doing.

### Short Pro 1
The daily-tier short ("Shorting MV1"): the DAILY stochastic's top-roll out
of the overbought band, taken only when the weekly regime is already
bearish — the mirror of "daily entries in the direction the weekly
permits." Boxed demos pair the daily roll with the price breakdown.

### SMA Lines
The moving-average stack as layered dynamic support/resistance: several
SMAs of increasing lookback on the daily chart. Price above the stack =
healthy; price slicing through the short SMAs and falling toward the long
ones maps the decline's depth. The MA zone is also where failed bounces
stall (see Brothers Grimm) — making the stack the natural placement guide
for stops and short entries.

### Daily Stochastic Pro 1
A full year of SPY's daily stochastic annotated signal-by-signal: every
bottom-cross circled as a buy, every top-roll circled as a sell, plus a
third marked class for filtered/failed signals. The lesson's point is
repetition — the SAME two signals fire all year long; the skill is taking
them mechanically in the weekly's direction and skipping the filtered
class. (This is precisely the marker overlay planned for the workbench.)

### Phil's Pro 2 and Pro 3 lesson
The applied review routine, run across many names in sequence: for each
candidate read the WEEKLY stochastic's position first (the per-name %K/%D
readout), then drop to the daily and intraday tiers for timing and
execution. Same rhythm, name after name — the tiers are one funnel:
weekly state → daily signal → intraday entry.

### Pro 3 Basics
The day-trading pane's setup and read (older name: MV3): the intraday chart
carries its own session boundaries, bar series, and stochastic strip — the
same cycle anatomy compressed into the trading day, always read with the
daily panes beside it for context. Demoed on JPM: session window
highlighted, intraday signals taken inside it.

### 50% Rule
Measure a completed move (top to bottom), mark the halfway level: the
counter-move tends to gravitate to and stall near that 50% retracement.
Use it as the natural target for bounces, the decision level for whether a
recovery is corrective (stalls at half) or real (takes the level back),
and a sanity check before chasing. Demoed by drawing the move's endpoints
and the midline on a beaten-down name.

### Advanced Pro 2
The weekly-tier position trade end-to-end (demoed on a long base): the
weekly stochastic bottoms and hooks (circled), the recovery leg rides a
drawn channel, and the position is held through the channel with periodic
weekly %K/%D checks until the breakout leg. The Pro 2 chair's job is
patience — one weekly cycle can span months and one entry.

### Dog Stocks
The anti-watchlist: a dog is a name capped under a DECLINING trendline and
the whole SMA stack, with overhead resistance zones and bounces that die
early. Recognition rule: lower highs into the falling line + price below
the stack = do not bottom-fish, regardless of how oversold the stochastic
looks; dogs belong on the skip list (or the short-candidate list). Demoed
on a chronically weak name.

### How to Short with Mostafa
A complete short-side checklist (guest-taught, ~25 min, demoed on FRC/BP
with SDS for the inverse expression):
1. **Regime and structure first** — M-formations (the double-top mirror of
   the W) mark the short structure.
2. **Stochastic under 80** — the entry waits for the roll OUT of the
   overbought band, never shorting while still pinned above it (the
   embedded exception in reverse).
3. **Adding on downside engulfing** — scale INTO the working short as
   bearish engulfing bars print along the decline (marked bar by bar in
   the demo), rather than sizing all at once.
4. **Order mechanics for shorts** — sell-short via market (fill now, price
   floats), limit (no worse than X), or stop (triggers on breakdown below
   X); worked examples anchor each type one dollar around the current
   price.

### Swing Trade vs Position Trade
The capstone distinction, and it maps exactly onto the tiers: a **swing
trade** lives on the DAILY stochastic — one cycle from bottom-cross to
top-roll, days to a few weeks, several opportunities per quarter in the
same name. A **position trade** lives on the WEEKLY stochastic — one cycle
can run months, entered at the weekly bottom-hook and held through the
daily's intermediate wobbles until the weekly itself tops. Same anatomy,
different clock: the choice of which stochastic governs the exit IS the
choice of trade type. Demoed on TSLA and NFLX with trendlines drawn on the
stochastic strips: the daily whipsaws that shake out swing traders are
invisible at the weekly scale, and conversely a weekly top-roll outranks
any daily buy signal. Decide which trade you are in BEFORE entry — the
stops lesson's placement and the profit-taking lesson's triggers all key
off the governing timeframe.

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
