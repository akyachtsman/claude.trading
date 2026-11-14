# Layers Heat Map: the rules in one file

Status: layout and design rulings approved for the build on 2026-11-13. The scoring is still a DRAFT (section 8). Built on made-up data (step 1, section 13); hidden on the live site until its daily feed is approved. Last change: 2026-11-13 9:30 AM PT (section 12).
The master copy is this file, `specs/layers-heat-map/LAYERS_HEAT_MAP.md` in claude.trading. The rules were written in project INVEST; the panel is built and kept by project code.TRADE.

## 0. How this file is used

- This file is the ONE file for the Layers Heat Map panel: what it answers, the data it needs, every scoring rule, the layout, the owner's rulings, the open questions and the change log. Nothing about the panel lives anywhere else (owner, 2026-11-13: "I want this panel to be contained in one single MD file").
- This copy, in claude.trading's repository, is the only master (owner, 2026-11-13: "push everything over to code.trade"). The dated copies in the shared Drive folder are history, not the source.
- Who looks after what: INVEST owns the scoring rules and tries each change in its simulation. code.TRADE owns this file, the panel's code, its daily data feed, its tests and keeping it running.
- How a rule change gets in: INVEST sends it to code.TRADE's mailbox with the changed lines. code.TRADE writes it into this file and logs it in section 12. code.TRADE does not change a scoring rule on its own; anything that does not fit goes back to INVEST's mailbox.
- Look and button changes the owner asks code.TRADE for are written into this file too (section 6, or section 7 for a ruling), and logged in section 12.
- Each change is logged in section 12, newest first, with its date and who asked for it.
- The simulation is the owner's private artifact; INVEST holds the link. It is not kept here because this repository is public.
- Nothing in this file is a secret. It holds no account numbers, balances, holdings or keys, and must never do so.
- INVEST builds nothing in the trading app or its database. Building is code.TRADE's.

## 1. What the panel answers

"Is today the right time to buy this stock, or not?" Greener means better for a BUY today, redder means better for a SELL today. It is a ranking aid for the watch list. A score is never an order.

It is its own panel. It is not the existing Heatmap panel (the finviz-style map coloured by the day's price change), and it does not show performance.

Words (fixed): BUY and SELL, never LONG and SHORT. Verdicts: Strong BUY, Leans BUY, No edge today, Leans SELL, Strong SELL.

## 2. Stocks covered

- Every S&P 500 member (500 in the simulation).
- Every single stock on the dashboard's own watchlists (table `desk_watchlists`) that is not in the S&P 500: 57 in the simulation. Each is scored against the S&P 500 sector it belongs to. In the simulation that sector was matched by hand. The app takes it from Yahoo's company profile, mapped from Yahoo's sector names to the eleven GICS sectors by a fixed table (agreed 2026-11-13). A stock whose sector does not map is left out and named under "Not in yet". The same profile says when a symbol is a fund, an index or not priced in dollars.
- Left out, and said so on the panel: funds and indexes (67 on the watchlists; the letters are built for single stocks), stocks not priced in dollars, and stocks with under 120 sessions of history.
- Later, by the owner's word ("not now, but later"): every Nasdaq and Dow stock.

## 3. Data needed

All of it is public market data. No AI is used to score, so the panel has no AI cost. Refresh once a day after the close. In the app that means the first time the page is opened after 16:15 ET; on a day nobody opens it, the next visit catches up. "Today" always means the last completed session, and the as-of date says which (agreed 2026-11-13).

| Input | Series in the simulation | Used by |
|---|---|---|
| Daily bars per stock: open, high, low, close, adjusted close, volume; about 400 sessions | Yahoo daily bars | G, H, I, J, K, flags, rules |
| S&P 500 fund and index | SPY (adjusted), ^GSPC | K, F, label |
| 11 sector funds | XLK, XLF, XLV, XLY, XLP, XLE, XLI, XLB, XLU, XLRE, XLC | E, F, K |
| Brent oil | BZ=F | A, E |
| Dollar index | DX-Y.NYB | A, E |
| World stocks outside the US | ACWX | B |
| 10-year yield | ^TNX | C, E |
| Junk bonds against Treasuries | HYG / IEF (adjusted) | E |
| Fear gauge | ^VIX | D, flag P |
| Core inflation, monthly | FRED CPILFESL | C |
| Jobs, monthly | FRED UNRATE, PAYEMS | C |
| CNN Fear & Greed, daily | community history file (github.com/whit3rabbit/fear-greed-data, fear-greed.csv); matched CNN's own reading on 2026-11-12 | D |
| S&P 500 membership, sector, sub-industry | S&P 500 constituents list | sectors, breadth |
| Earnings dates | NOT connected yet (two dates typed by hand) | flag L |
| Economic release dates | from an earlier calendar, not confirmed | flag N |

"21 sessions ago" means the close 21 trading sessions before the latest one. Use completed sessions only.

Stochastics must come from the dashboard's own stochastic code, never a second copy of the maths, so the numbers on this panel match the charts. Long-term is the 13-week stochastic (92 sessions, smoothed 15). Timing is the daily stochastic (14-3-3). Where the simulation's maths and the dashboard's differ, the dashboard's wins, and the difference is reported back to INVEST. Known differences (reported 2026-11-13, no objection): a stock with no movement at all over the range reads 50 on the dashboard (the simulation gives no number and no points); the dashboard uses each stock's own bars, not SPY's calendar; and the dashboard's bars are rounded to 2 decimals. The dashed "partial" line the charts draw for a short history is never used to score.

Adjusted or plain close (agreed 2026-11-13): strength (K), breadth (D and F) and the funds' moves use the adjusted close; the moving averages (G), streaks (I) and stochastics (J) use the plain close.

## 4. Scoring

Every stock gets TWO scores from 0 to 100: one for a BUY and one for a SELL. They are scored separately because the tests showed they are not mirror images.

- Outer letters A to F: 40 points. The same for every stock (A to D) or for every stock in a sector (E, F).
- Stock letters G to K: 60 points. The stock itself.

| Letter | Name | Max |
|---|---|---|
| A | Global trend | 5 |
| B | Global sentiment | 5 |
| C | National trend | 8 |
| D | National sentiment | 7 |
| E | Sector trend (driver) | 5 |
| F | Sector sentiment | 10 |
| G | Moving averages | 20 |
| H | Volume | 10 |
| I | Days in a row | 10 |
| J | Stochastic | 10 |
| K | Strength | 10 |

### A. Global trend (5)
- Brent oil against 21 sessions ago: lower gives BUY 3, higher gives SELL 3.
- Dollar index against 21 sessions ago: lower gives BUY 2, higher gives SELL 2.

### B. Global sentiment (5)
- World stocks outside the US above their 200-day average: BUY 5.
- World stocks outside the US above their 50-day average: SELL 5 (a stretched world).

### C. National trend (8)
- 10-year yield against 21 sessions ago. BUY: 4 if lower, 2 if up by 0.25 or less, 0 if up more. SELL: 6 if up more than 0.25, 2 if up by less, 0 if not up.
- Core inflation: the last three months' pace against the three months before. Cooling gives BUY 2. No SELL points.
- Jobs: unemployment rate against three months earlier. Higher gives BUY 2, flat gives 1 to each side, lower gives SELL 2. This is scored the way the test points ("bad news is good news"). OPEN QUESTION 1.

### D. National sentiment (7), scored against the crowd
- VIX. BUY: 3 at 22 or more, 2 under 17, 0 between. SELL: 2 under 17, 1 from 17 to 25, 0 above 25.
- S&P 500 stocks above their 50-day average. BUY: 2 under 40%, 1 from 40% to 70%, 0 above. SELL: 3 over 60%, 2 from 40% to 60%, 0 under 40%.
- CNN Fear & Greed. BUY: 2 under 25, 1 from 25 to under 45. SELL: 2 at 45 or more.

### E. Sector trend (5)
One driver per sector, measured over 21 sessions. Going the sector's way gives BUY 5; against it gives SELL 5.

| Sector | Driver that helps it |
|---|---|
| Energy | oil rising |
| Real Estate | the 10-year yield falling |
| Utilities | the 10-year yield falling |
| Consumer Discretionary | oil falling |
| Materials | the dollar falling |
| Information Technology | junk bonds beating Treasuries |
| The other five sectors | no single driver stood out: a flat 2 to each side |

### F. Sector sentiment (10)
- Share of the sector's S&P 500 stocks above their 50-day average. BUY: 6 under 40%, 4 from 40% to 60%, 2 above 60%. SELL: 6 over 60%, 3 from 40% to 60%, 0 under 40%.
- Sector fund against the S&P 500 over the last 5 sessions: ahead gives BUY 4.
- Sector fund above its own 50-day average: SELL 4.

Sector breadth counts S&P 500 members only, even when watchlist stocks outside the index are scored.

### G. Moving averages (20)
For each of the 200-day, 50-day and 25-day averages of the close:
- Crossed above within the last 5 sessions: BUY 10 / 6 / 4.
- Above, no recent cross: BUY 5 / 3 / 2.
- Crossed below within the last 5 sessions: SELL 10 / 6 / 4.
- Below, no recent cross: SELL 5 / 3 / 2.

### H. Volume (10)
- Today's volume against its 50-day average (the 50 sessions before today): 4 points at 2 times or more, 3 at 1.5, 2 at 1.2, 1 at 1.0, else 0. To BUY on an up day, to SELL on a down day.
- Volume on up days against down days over 20 sessions: 3 points at a ratio of 1.2 or more, 1 above 1.0. To BUY when buying is heavier, to SELL when selling is heavier. On an exact tie (1.0) neither side gets a point; the simulation's scorer gave BUY 1 there, which was wrong (INVEST, 2026-11-13).
- Volume building: average of the last 5 sessions against the 50 sessions before them: 3 points at 1.5 times, 2 at 1.2, 1 at 1.0. To BUY if the price rose over those 5 sessions, to SELL if it fell.

### I. Days in a row (10)
Closes in a row counting today: 3 or 4 gives 10, 5 gives 7, 2 gives 6, 1 gives 3, 6 or more gives 3. An up streak scores for BUY, a down streak for SELL.

### J. Stochastic (10)
13-week stochastic, 7 points:
- Under 30 and rising: BUY 7. Under 30 and falling: BUY 3. Under 30 and down 10 points or more in 5 sessions: BUY 0.
- Between 30 and 80: rising gives BUY 4 and SELL 1; falling gives BUY 1 and SELL 4.
- Over 80: falling gives SELL 7, rising gives SELL 3.

Daily stochastic (14-3-3), 3 points:
- Over 80 ("peaking"): SELL 3 if below its signal line, else SELL 2.
- Under 20 ("bottoming"): BUY 3 if above its signal line, else BUY 2.
- Between: 1 point to BUY if above its signal line, 1 to SELL if below.

### K. Strength (10)
Change in the stock (adjusted close) minus the change in the benchmark: against its sector fund over 63 sessions (3 points) and 5 sessions (2), and against the S&P 500 over 63 sessions (3) and 5 sessions (2). Ahead scores for BUY, behind for SELL.

### Lean, verdict and the timing hold-back
- Lean = BUY score minus SELL score. Lean sets the colour and the verdict.
- Strong BUY at +25 or more. Leans BUY from +10. No edge today between. Leans SELL from -10. Strong SELL at -25 or less. These cut-offs are a first guess and are not tested.
- Timing hold-back (the owner's rule): while the daily stochastic is over 80, a Strong BUY is shown as Leans BUY. While it is under 20, a Strong SELL is shown as Leans SELL. The lean number itself is not changed. A ring marks a held-back stock. OPEN QUESTION 2.
- Sorting by verdict lists Strong BUY first, then by lean within each verdict.

### Flags (no points; shown beside the ticker and in the write-up)
- L Earnings: the stock reports soon. Not connected yet.
- M Thin trading: under $10 million traded a day on average over 20 sessions.
- N Economic release: a major release within two sessions.
- O Sector leader: a leader reports within five sessions (today: Nvidia for chip stocks).
- P Panic: VIX at 30 or more.
- Daily peaking / Daily bottoming: the daily stochastic is over 80 / under 20, with its value.

### Rule signals (a dot beside the ticker; the week's signals, since Monday)
The panel marks a stock where rule 1 (BUY), rule 2 (SELL) or rule 3 fired this week, with the date. Whether a score should also need a rule to have fired is OPEN QUESTION 3. The definitions below are the owner's (2026-11-13); where the simulation's code differs, these win. Every stochastic here is the long-term 92-15-15 %K line, from the dashboard's own code.

Rule 3 (the plain cross of the long-term %K, with no %D test; owner, 2026-11-13, via INVEST at 9:10 AM PT, matching his daily phone alert):
- BUY: %K under 30 on the session before, and at or over 30 now.
- SELL: %K over 80 on the session before, and at or under 80 now.
- A touch does not count: %K sitting exactly on the line the session before is not a cross.

Rules 1 and 2. Days 1 to 3 are the run, day 3 is the session tested, and day 0 is the session before day 1.
- Rule 1 BUY needs all of:
  - on each of days 1 to 3, the close is at least 1.5% above the prior close and above that day's open;
  - the lowest low of the 60 sessions ending on day 3 was set no more than 10 sessions before day 1, or during the run;
  - day 0's close is no more than 8% above that low;
  - %K rises on each of days 1 to 3 and is at or under 30 on day 3;
  - it fires on day 3 only (day 0 is not itself a strong up day).
- Rule 2 SELL is the mirror:
  - on each of days 1 to 3, the close is at least 1.5% below the prior close and below that day's open;
  - the highest high of the 60 sessions ending on day 3 was set no more than 10 sessions before day 1, or during the run;
  - day 0's close is no more than 8% below that high;
  - %K falls on each of days 1 to 3 and is at or over 70 on day 3;
  - it fires on day 3 only (day 0 is not itself a strong down day).

## 5. Colours and type

- The dashboard's own heat scale, seven stops: #F63538, #BF4045, #8B444E, #414554 (zero), #35764E, #2F9E4F, #30CC5A. Canvas #262931. Labels white with a dark halo, as on the existing Heatmap.
- Lean view: colour = shown lean / 42, limited to -1 to +1, spread over the seven stops. BUY points view: (BUY - 15) / 60. SELL points view: (SELL - 15) / 60 on the red side.
- A ledger box A to D is coloured by (BUY - SELL) / its maximum. A sector box by (BUY - SELL) / 15.
- IBM Plex Sans for words, IBM Plex Mono for numbers.

## 6. Layout (owner's decisions, all 2026-11-12)

One self-contained dark panel with a thin outline. Nothing reaches past the edge of the chart, and the chart itself never touches the panel's edge: a 10-pixel dark margin sits to its right and below it.

Both views (tiles and table), on a wide screen, are two halves side by side; switching views never changes the panel's size (owner, 2026-11-13):
- LEFT half, top to bottom: title with the draft mark and the "as of" line; a Hover on/off switch and three note buttons at the top right (How to read it, Cautions, Not in yet) that open on hover, on keyboard focus and on tap; the ledger; the colour scale and one line of footnote at the bottom.
- RIGHT half: the filter row as the chart's heading, then the tiles or the table. They scroll inside the half; the table's header stays in view. The left half sets the height.
- The panel starts on the Stochastic charts' left edge and, on a screen 1120 pixels or wider (where the Markets, News, Ask and Economy panels sit in one row), ends on the right edge of the Ask the desk panel (owner, 2026-11-13: "shrink its width so that it lines up with the ask desk"; it was 1356 pixels at most). Narrower, it is as wide as the charts. The right half is never narrower than the table needs (604 pixels, so the table never scrolls sideways): where the panel is too narrow for two equal halves of that width, the left half (the ledger) gives up the room (owner, 2026-11-13: "shorten the left side of the panel to give the right side enough space"), and a left half under 340 pixels carries the sector boxes three to a row; otherwise the halves are equal. The table columns keep their proportions (29%, 16.5%, three at 7.5%, five at 6.4%). On a panel under 880 pixels wide the halves stack and the tiles or the table sit in a box of the same fixed height, scrolling inside it. On a phone the panel is full width and the ledger wraps into rows of two boxes, with no sideways swipe (owner, 2026-11-13).

The ledger (the layers that stocks share):
- "Global and national": four equal boxes, A and B on the first row, C and D on the second. Each shows its name, its points ("B 5 · S 1 of 8") and its readings in short form.
- "Sectors": twelve equal boxes, four to a row: the eleven sectors, each with "B x · S y of 15" and the share of its stocks above their 50-day average, and a Labels box (S&P 500 level, Fed, AAII survey: shown for context, no points).
- Hover over a box shows its readings and the evidence behind it. Tap A to D or Labels to open the full card under the ledger. Tap a sector to filter the chart to it.

Filter row: search by ticker or name; sector; watchlist (all stocks, S&P 500 only, any watchlist, or one named list); colour by Lean, BUY points or SELL points; Tiles or Table; "Signals this week only" with the count; "N of M stocks".

Table: one row per stock. Columns: Stock (ticker, signal dot, flags beside the ticker, company name under it), Verdict, Lean, BUY, SELL, then G, H, I, J, K. No flags column and no outer-letter columns (they live in the ledger). Column widths: 190, 112, 52, 52, 52, 44, 44, 44, 44, 44. The table keeps this tight size and never stretches to fill space. Every header sorts.

Tiles view (the opening view; "the rows are for testing"): the stocks are tiles grouped by sector, in the right half like the table, each tile shows the ticker and the number for the chosen colour view, with a ring for a held-back verdict and a dot for a signal.

The Hover switch (on by default, remembered on the device) turns every hover-over display on or off: the readings on tiles, cells and ledger boxes, and the notes. With it off, the notes still open on a click and a stock still opens its write-up.

Hover over a tile or a cell shows the readings behind it. Click a stock for its full write-up: verdict and lean, BUY and SELL bars, a plain-words reading, the flags L to P, a chart of price with the 25, 50 and 200-day averages, the 13-week stochastic and the daily stochastic, then every letter with its readings and points.

## 7. What the trading app's own rules require

Checked on 2026-11-12 against claude.trading's CLAUDE.md, the house design standard it imports (design.md), DESIGN-GAPS.md and the "Daylight desk ledger" design record. Nothing was changed. The simulation was built to be judged, not to those rules, so the app version must be rebuilt to them.

Already in line:
- Plain HTML, CSS and JavaScript, no build step.
- IBM Plex Sans and Mono, and the dashboard's own seven-stop heat scale with white haloed labels.
- Sector and watchlist pickers are native dropdowns. The search box is a real search field with a spoken label.
- Sortable headers are real buttons and the header cell says which way it is sorted. The table scrolls inside its own box with the header in view, and the page never scrolls sideways.
- No `overscroll-behavior`, no `touch-action: none`, no native confirm or alert boxes.
- A verdict is always words and a number, never colour alone. Reduced-motion is honoured. Zooming is never blocked.
- No AI cost: the scores are arithmetic.

Not in line, to fix when it is built:

| # | Rule in the trading app | The simulation today |
|---|---|---|
| 1 | Green and red are for profit and loss only, never decoration | Green and red mean BUY and SELL. Needs the owner's ruling recorded in the app. |
| 2 | Every panel carries a data-state lamp and an as-of stamp | An as-of line only, no lamp. |
| 3 | Live mode shows real data or nothing; made-up data only under ?demo=1 | One snapshot baked into a file. Typed by hand: the Fed and AAII labels, two earnings dates, the economic dates, Nvidia's date, and the sector of the 57 watchlist stocks. |
| 4 | All page text is written with textContent, never innerHTML | Built with innerHTML throughout. |
| 5 | Every colour and size comes from tokens.css | About 75 colours and many sizes are written straight into the styles. The dark panel needs its own token scope, as the charts panel has. |
| 6 | Use the house components; a screen never adds its own button, pill, card or dialog | Its own segmented buttons, pills, chips, cards, tooltip and side drawer. |
| 7 | All dialogs open through openModal() and closeModal(); a long detail view is its own page with one Back | The stock write-up is its own slide-in drawer. |
| 8 | A table row opens through a button on its name, never a clickable row | The whole row is the button. |
| 9 | Targets at least 44 by 44 pixels; inputs at least 48 high with 16-pixel text | Filters 36 high with 14-pixel text; note buttons 28 high; table rows 34 to 43 high. The owner asked for this tight size, so it needs his ruling or a line in DESIGN-GAPS.md. |
| 10 | Never cut a label with "…": wrap it | Company names in the table, and sector names in a narrow ledger, are cut with "…". |
| 11 | Sort arrows are ▲ and ▼; one shared comparator sorts every table | Arrows are ↑ and ↓ with its own sorting. |
| 12 | Filters have a visible label and a "Clear filters" link; the search box shows a magnifying glass and "Search stocks…" | No visible labels, no clear link, placeholder "Ticker or name". |
| 13 | Price changes show 2 decimals | 1 decimal. |
| 14 | Heights tied to the screen use dvh after a vh fallback | One 80vh without dvh. |
| 15 | Hover is always paired with focus or tap | Cell readings show on mouse hover only. Keyboard and touch reach the same readings through the write-up. |
| 16 | Empty state wording: "No stocks match your search." with Clear search | "No stock matches these filters." |
| 17 | Loading shows "Loading…" where the content will appear | Not needed for a baked snapshot; needed in the app. |
| 18 | Each new panel gets its own test scenarios, demo data and a contrast check of its token pairs | None. |

Owner's rulings for the build (answered 2026-11-13 7:28 AM PT: "Let's proceed with your suggestions", and he placed the panel himself). code.TRADE records each one in the app's CLAUDE.md as an owner ruling, or as a line in DESIGN-GAPS.md, the way that file already does.
- A. Colour: this panel may use green and red for BUY and SELL. This panel only.
- B. Size: the tight sizes stay on a computer (they are under the 44 and 48 pixel floors). A phone gets the full sizes.
- C. Names and labels: company names may be cut with "…", and the filters carry no visible labels, as in the simulation. An exception to the house rule, for this panel.
- D. Scrolling: the dashboard's ban on `overscroll-behavior: contain` stays. This panel's table is built without it.
- E. The write-up opens as a dialog, like the dashboard's symbol window, through the app's shared dialog opener.
- F. Name and place: "Layers Heat Map". It sits RIGHT ABOVE the Stochastic charts panel (the owner's words: "right above the stochastic panel in the trading window").
- G. Scope: funds, indexes and non-S&P Nasdaq and Dow stocks are left out for now, and the panel says so.
- H. Data: a new daily feed is accepted in principle. code.TRADE shows the owner its plan and gets his approval before any deploy or database change. The Fear & Greed history may come from the community file, marked stale if it stops updating.

With these rulings, rows 1, 9, 10 and 12 of the table above (the visible-label part of 12) are settled as exceptions. Every other row is still to be fixed in the build.

How the build meets ruling D (agreed 2026-11-13): the house table and dialog styles carry `overscroll-behavior`, which the dashboard bans, so this panel uses the dashboard's own table and its shared dialog opener. Nothing visible changes; it is noted in DESIGN-GAPS.md.

Hand-typed inputs (agreed 2026-11-13): the app shows real data or nothing, so the Fed and AAII labels, the earnings dates (flag L), the economic release dates (flag N) and a leader's report date (flag O) stay out until each has a real source, and the panel lists them under "Not in yet". Until then the Labels box shows the S&P 500 level only.

## 8. Open questions (INVEST, for the owner)

1. Jobs: scored the test's way (weak jobs help a BUY) or the usual way?
2. The hard 80 and 20 lines in the timing hold-back, or a gradual rule (a penalty that grows above 65, mirrored under 35)?
3. Should "the right time" also need rule 1, 2 or 3 to have fired? Today several energy stocks show Strong BUY in the week a rule 3 SELL fired.
4. Keep the Labels box or drop it?

Questions 5 to 7 (rule 3 crossings, written rules 1 and 2, the phone ledger) were answered by the owner on 2026-11-13 and are written into sections 4 and 6.

## 9. Not in yet

- Earnings dates (the calendar is not connected; Yahoo publishes them, one more request per stock).
- Confirmed economic release dates, a leader's report date (flag O), and the Fed and AAII labels.
- Real data: the daily feed is written (step 2, section 13) but not deployed. Until the owner approves its deploy and it is switched on (step 3), the panel runs on made-up data under `?demo=1` only and stays hidden on the live site.
- Funds and indexes; every Nasdaq and Dow stock.

## 10. What the tests showed (6 years of daily bars, today's S&P 500 members, so winners are over-counted)

- 13-week stochastic under 30: +2.1% over the next 20 sessions against +1.2% on all days, rising or falling. Only +1.4% when it had dropped 10 points or more in 5 sessions.
- Daily stochastic over 80: +0.2% over the next 5 sessions against +0.3% on average (a small drag, not a reversal). Under 20: +0.45%.
- Price up over 5 sessions on 1.5 times normal volume: +1.6% over 20 sessions against +1.0% on quiet volume. Heavy volume on falling prices was also followed by gains (+1.8%), so the SELL side of letter H is not supported.
- Fear & Greed under 25: +2.9% over 20 sessions, positive in every year. 25 to 45: +1.6%. 45 to 75: +0.3% to +1.0%. Average day: +1.3%. No reading was followed by a fall.
- Unemployment higher than three months earlier: +1.9% over 20 sessions against +1.1% when lower (about 70 monthly reports, a thin test).
- The scores were tested only on days a rule fired. For a stock with no signal the score is an untested ranking. The best SELL settings were about a coin flip.

What rests on the owner's judgement, not on a test: the timing hold-back, the verdict cut-offs, and the points given to each letter.

## 11. Cautions shown on the panel

- The scoring is a draft and has not been approved.
- Red marks the least bad setting for a SELL.
- A score is a ranking aid. A signal is a watch alert, never an order.

## 12. Changes

- 2026-11-14, code.TRADE, the owner's "Build it now" on step 2: the daily feed `desk-layers` is written and tested, not deployed (section 13). It gathers what section 3 lists from Yahoo, FRED, the S&P 500 constituents file and the community Fear & Greed file, and serves it; the scoring stays in the browser. The page asks it only once the switch `DESK_LAYERS_LIVE` is on (step 3). A Fear & Greed history more than a week older than the session is called STALE on the panel and letter D still uses its last reading (ruling H). No scoring rule changed.
- 2026-11-13 3:00 PM PT, code.TRADE, the owner's ask ("shorten the left side of the panel to give the right side enough space"): the right half is at least 604 pixels, so the table never scrolls sideways; the left half gives up the room, carrying the sector boxes three to a row under 340 pixels; the halves stack on a panel under 880 pixels (the panel's own width decides, no longer the window's 860). Section 6 rewritten to match. No scoring rule changed.
- 2026-11-13 1:40 PM PT, code.TRADE, the owner's asks ("the size cannot change when we go from table to tiles"; then "shrink its width so that it lines up with the ask desk"): both views now share the table's layout of two equal halves and the tiles scroll inside the right half as the table does, so switching views never changes the panel's size; under 860 pixels both sit in a box of one fixed height. From 1120 pixels up the panel ends on the Ask the desk panel's right edge (no 1356-pixel cap). Section 6 rewritten to match. No scoring rule changed.
- 2026-11-13 10:50 AM PT, code.TRADE, a reading of G (Codex review of PR #370), for INVEST to confirm: G scores ABOVE and BELOW, so a close exactly ON its average earns nothing on either side, and a cross needs a day strictly on the other side (a touch is not a cross, as in rule 3). The first build counted a close on the average as below, which gave SELL points to a flat price. No number changed.
- 2026-11-13 9:30 AM PT, code.TRADE: step 1 built (the owner's "Start step 1 now"): the panel, its scorer and its write-up on made-up data under `?demo=1`, hidden on the live site; section 13 added to say where each part lives. No scoring rule changed. The demo's "today" is the last completed session (after 16:15 ET), as section 3 says.
- 2026-11-13 9:15 AM PT, code.TRADE, INVEST's correction at 9:10 AM PT (replaces the 8:51 answer on rule 3): rule 3 is the plain cross of the long-term %K, with no %D test. BUY: under 30 the session before, at or over 30 now; SELL: over 80 the session before, at or under 80 now; a touch does not count. Reason: "%K above %D" came from the morning scan, which is now off, and the owner does not recognise it as his rule; the plain cross matches his daily phone alert. The panel's rule 3 dot now differs from the morning scan's definition on purpose.
- 2026-11-13 8:51 AM PT, code.TRADE, the owner's answers relayed by INVEST: rule 3 is the dashboard's crossing on the long-term lines (with %K above or below %D; replaced at 9:15 AM PT); rules 1 and 2 are written out (section 4, Rule signals), and these numbers win over the simulation's code; on a phone the ledger wraps into rows of two boxes, no sideways swipe (section 6). Open questions 5 to 7 closed.
- 2026-11-13 8:40 AM PT, code.TRADE: this file moved into claude.trading as the only master (owner: "push everything over to code.trade", "I want this panel to be contained in one single MD file"); section 0 rewritten to say so; the private simulation link taken out (the repository is public). INVEST's answers to code.TRADE's build plan written in: letter H gives no point on an exact 1.0 tie; the watchlist stocks' sector comes from Yahoo's profile mapped to GICS (section 2); the adjusted/plain close split and the dashboard's stochastic differences (section 3); hand-typed inputs stay out of live and ruling D is met with the dashboard's own table and dialog (section 7); "after the close" means the first visit after 16:15 ET (section 3). Open questions 5 to 7 added for the owner.
- 2026-11-13 7:35 AM PT: the owner's rulings A to H written into section 7; the panel sits right above the Stochastic charts panel; the build is code.TRADE's.
- 2026-11-13 7:25 AM PT, Version 20: a thin outline around the panel and a 10-pixel margin to the right of and below the chart, so the panel's right edge shows.
- 2026-11-13 12:03 AM PT, Version 19: a Hover on/off switch beside the note buttons.
- 2026-11-12 11:50 PM PT, Version 18: the two halves sit side by side from a window 860 pixels wide (was 1100), because the owner's window is narrower.
- 2026-11-12 11:38 PM PT, Version 17: first issue of this file. Table view is two equal halves; the filter row heads the chart; the ledger is four equal boxes and twelve equal boxes; the whole panel is the chart's width.

## 13. In the app (code.TRADE)

Where each part of this file lives in claude.trading. Changing a number here means changing it there, in the same pull request, with its test.

| Part | Where | What it holds |
|---|---|---|
| Every point value, cut-off, verdict line, hold-back line and colour divisor | `scripts/layers.js`, `LAYERS_RULES` (stamped `v20`) | ONE frozen table; a new issue of the rules is an edit to it and its tests, nothing else |
| The scoring (A to K, the lean, the verdict, the hold-back, the flags, rules 1 to 3) | `scripts/layers.js`, `layersScore` | runs in the visitor's browser, on the dashboard's own `stochSeries` (92-15-15 and 14-3-3), never the charts' dashed partial line |
| The made-up data | `scripts/layers.js`, `buildDemoLayersInput` | generic large caps and invented tickers, never a holding; every signal kind, a held-back verdict and all five verdicts appear |
| The panel and the write-up | `index.html` (`#layersPanel`, `#layersDetailBackdrop`), `scripts/app.js` (`startLayers`, `renderLayers`, `openLayersDetail`), `styles/layout.css` (`.ly-*`) | the write-up opens through the dashboard's `openModal` (ruling E); the table and dialog are the dashboard's own (ruling D) |
| Tests | `tools/unit/layers.test.mjs` (a worked example for every letter, the rules, the verdicts, the colour pairs); the browser scenario S82 in `.github/scripts/ui-tests/tests/app.spec.js` | run by CI on every pull request |
| The daily feed | `supabase/functions/desk-layers/index.ts` | gathers section 3's inputs once a day after 16:15 ET and serves them; scores nothing |
| Reading the feed | `scripts/data.js` (`deskLayers`), `scripts/layers.js` (`layersDecode`), `scripts/app.js` (`lyLivePoll`), `scripts/config.js` (`DESK_LAYERS_LIVE`) | the page asks only while the switch is on; hidden until a real payload is scored |
| Feed tests | `tools/unit/desk-layers.test.mjs`; the browser scenario S83 | the calendar, the roster, the parsers, the encoding round trip (scored the same both ways), a whole day's sweep |

Steps: step 1 (the panel on made-up data, hidden live) is built. Step 2, the daily feed `desk-layers`, is written and tested (2026-11-14) and NOT deployed: it needs the owner's approval (ruling H). Step 3 deploys it (`verify_jwt` ON, like the other anon-callable feeds), checks the first day's sweep, then sets `DESK_LAYERS_LIVE` to true in `scripts/config.js`; until then the live page never calls the feed.

How the feed works:
- **When.** "Today" is the last session whose close has settled (16:15 ET). Every request to the feed moves that day's gathering on by one short step (about 3.5 seconds, six requests at a time), so the work is shared by the page's own visits; the page asks once a minute while the feed is behind. A day takes about 10 to 20 requests.
- **What it fetches.** Per symbol, Yahoo's daily bars for two years, of which the newest 300 sessions are kept: every S&P 500 member (the constituents file gives the name, GICS sector and sub-industry), the watchlists' single stocks outside the S&P 500 (only tickers are read from the watchlists, at most 300; the sector comes from Yahoo's company profile, read once and kept), the nine market series and the eleven sector funds. Once a day, FRED's core CPI, unemployment and payrolls (13 months) and the Fear & Greed file (60 readings).
- **Where it keeps it.** In `desk_feed_cache`: one row per symbol (`layers:y:<SYM>`), one for FRED and Fear & Greed (`layers:macro`), and the finished payload (`layers:body`, gzipped). No new table, no migration.
- **What it serves.** The newest finished payload as gzip bytes (about 1.9 MB), which the page inflates; the previous session's while today's is still being gathered, with the progress in the reply's headers. Before the very first payload exists, a short "not ready" reply, and the panel stays hidden. When the gathering itself cannot move (a roster, watchlist or store read failed), the last payload is still served but marked as coming from a failing feed, and the panel lamps it STALE (`feed failing`), never EOD; a failed watchlist read never counts as an empty watchlist, and a symbol counts as gathered only once its row is stored.
- **Checked against the real hosts, before any deploy (2026-11-14).** A whole day run through the function's own code with real Yahoo, FRED, the constituents file and Fear & Greed (only the store and the watchlists stubbed): 504 stocks and the 11 sector funds and 9 market series in, three names left out with their reason, FRED's three series at 13 months, a 1.8 MB reply and a 2.4 MB stored row; the page decoded it and scored 502. The run found that Yahoo refused a copied Chrome user-agent (429) and FRED reset it, so the function sends the desk's own name, as quote-proxy, desk-charts and desk-econ do. Not checkable here: the store accepting a row that size, and the time each step takes on Supabase.
- **Left out, and said so on the panel.** A fund, an index, anything else that is not a single stock, a stock not priced in dollars, one whose Yahoo sector does not map to the eleven, and one with no price data. A sweep that ends with fewer than 400 stocks never replaces the last good payload.
