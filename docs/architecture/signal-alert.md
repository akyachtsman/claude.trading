# The 10 AM trading-signal push

Scope: `tools/signal-alert.mjs` and the weekday scheduled task that runs it. Moved here from project INVEST on
2026-11-17 (arash to INVEST, 1:45 PM PT: "So we're moving this task to code.trade"); he chose to build it on the
dashboard's own rules (card, 2:12 PM PT: "Dashboard's own rules").

## What it does

| Step | What | Where |
|---|---|---|
| Who it scans | The S&P 500 (the same constituents CSV `desk-layers` reads) plus every ticker on the dashboard's watchlists | The watchlist tickers are read by the run itself with ONE read-only `select` through the Supabase connector and passed in a scratch file; they never enter this repository |
| What it tests | Rules 1 to 3, every weekday from this week's Monday through today: a past day on its final close, today on its forming bar (live while the market is open) | `layersSignals` / `layersRuleAt` in `scripts/layers.js` and `stochSeries(…, WSTOCH)` in `scripts/data.js` — the functions the Strategies Chart's dots and the Trading signals panel run. Never a second copy of a rule |
| Prices | Yahoo's v8 daily chart, one year, raw open/high/low/close, four requests at a time, backed off on 429 | `fetchBars`, `parseChart` |
| What it says | ONE push: title `📈📉 Trading this week: N LONG, M SHORT`, a numbered list newest first, each stock once a side at the first day it fired | `buildPush` |
| What it writes | JSON on stdout; with `--out=DIR` also `title`, `msg` (empty title = send nothing) and `signals.txt` (the record's lines) | `main` |

Owner rulings it keeps (from INVEST's alert, arash 2026-11-12): one push a day, never one per signal ("There should have
been one push notification. all combined."); the week's running list starts every Monday ("keep the list on for the entire
week starting every mon"); a stock fired on several days is listed once, at "the first time"; a quiet day with a complete
scan sends nothing; more than 5% of tickers unfetched, or the watchlist unreadable, adds the incomplete-scan sentence, and
with no signal that sentence is the push (`⚠️ Trading scan incomplete`); a scan that fails outright (exit 2) is
`⚠️ Trading scan failed`. The message stays under 1,000 characters (Pushover takes 1,024): the oldest stock of whichever
side has more left is dropped first and the message ends `+ N more in code.TRADE` (the push button opens the run's own
thread, which keeps every line).

Known difference from INVEST's scanner: the scanner needs 110 bars before it tests a stock, the dashboard's rules start
as soon as the 13-week %K has two readings (about 106 bars). Only a stock listed for about five months can differ.

## Sending, and the scheduled task

**Dropped by the owner on 2026-11-17** ("No need to push anything. I'm just going to look into the trade dashboard"):
no task runs this tool and nothing sends its message. It stays in the repository, tested, in case the push comes back.
Nothing in this repository holds a key or sends anything. Had it gone ahead, who sends, and from which cloud environment,
was the owner's call with chat.GIT (its GLOBAL 3.1 lists the senders of `push.sh`, and the Pushover keys live only on
`chat.workspaces.env`); that question was withdrawn the same day.

## Cutover

None: with the push dropped, there is no hand-over. Whether INVEST's own task (`Weekdays – Trading-signal alert
(9:57 AM PT)`) keeps running is the owner's call with INVEST, not this repository's.

## Checks

`tools/unit/signal-alert.test.mjs` (CI's `server-checks`): the week's signals equal `layersSignals` on the demo bars at
every as-of day, never a later session; the push's wording, order, numbering, the 1,000-character trim, the quiet day and
the incomplete-scan sentence; the parsers and the live window.
