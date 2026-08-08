# Manual testing recipes

This repo's test suite is automatic (`npm test`). The recipes below drive the CLI
by hand instead, for the things a unit test does not show you: what the whole
pipeline feels like end to end, and whether the directive ladder does what you
think it does over a position's life.

There are three, and they answer different questions:

| Recipe | Question | Data |
| --- | --- | --- |
| [Smoke test](#smoke-test-live-data) | Does the CLI work against the real Lighter API? | Live, network |
| [13-day walkthrough](#13-day-walkthrough) | Does the ladder behave over a full trade lifecycle? | Scripted, offline |
| [Replaying real history](#replaying-real-history) | Does it survive real prices over a real window? | Backfilled, network |

Start with the smoke test if you changed anything touching coverage or the
Lighter client. Use the walkthrough if you changed gates, the directive ladder,
the stop ladder, or sizing — it is deterministic, so a diff in its output is a
real behavior change. Use the replay when you want prices that gap and reverse in
ways a scripted path does not.

All commands assume a fresh shell with a throwaway `JANUS_DB`.

```bash
export JANUS_DB=/tmp/janus-scratch.db
export JANUS_LIGHTER_URL=https://mainnet.zklighter.elliot.ai
```

## Smoke test (live data)

Populates a scratch database with two clusters, three assets, macro/cluster
reads, screen/score rows, and the resulting `INITIATE` directives, using real
market data.

### 1. Initialize and sync the Lighter catalog

```bash
janus init
janus market sync
```

### 2. Create two clusters and add three assets

```bash
janus cluster add crypto_bluechip --name "Crypto Blue-Chip"
janus cluster add crypto_defi      --name "Crypto DeFi"

janus asset add BTC --class crypto --cluster crypto_bluechip
janus asset add ETH --class crypto --cluster crypto_bluechip
janus asset add UNI --class crypto --cluster crypto_defi
```

### 3. Loosen the trend gate, then run coverage

The directive ladder treats MA structure as a hard entry condition. Real Lighter
market data may be below the SMAs on any given day, so this recipe relaxes the
gate to make `INITIATE` more likely with arbitrary snapshots.

Sizing defaults (`account_capital=100000`, `max_heat_pct=15`,
`per_trade_max_risk_pct=5`, `per_asset_max_notional_pct=20`) are already built
into the code; only override them here if you want different values.

```bash
janus param set trend_sma20_threshold_long -2
janus param set trend_sma50_threshold_long -2
janus coverage run
```

Setting both long thresholds to `-2` lets price sit below the 20- and 50-day SMAs
by up to 2% and still pass the trend gate. This keeps the gate meaningful while
letting the recipe produce trade directives reliably with arbitrary snapshots.

If an asset is skipped because of too little history, the recipe still works for
the assets that were covered.

### 4. Record macro and cluster reads

```bash
janus macro record --summary "breadth improving, regime neutral" --metric regime=0.5

janus cluster record crypto_bluechip --metric regime=0.5
janus cluster record crypto_defi      --metric regime=0.5
```

### 5. Screen all three assets

A `score` of 5 with `confidence=1` and the default `screen_threshold=4.0` gives
`screen_score=5`, which flags the asset.

```bash
janus screen record BTC --metric score=5 --metric confidence=1
janus screen record ETH --metric score=5 --metric confidence=1
janus screen record UNI --metric score=5 --metric confidence=1
```

### 6. Record yesterday's scores so persistence passes today

`signal_persist_days` defaults to `2`, so today's signal needs yesterday's score
to have passed the same threshold. Score all three assets for yesterday with the
same bullish factors; the test does not need sizing plans, just persisted score
rows.

`--date` addresses an existing session, so first create yesterday's session by
running coverage for that date, then record the reads and scores. A past date
backfills from the bar history rather than stamping today's prices — see
[Replaying real history](#replaying-real-history) for what that reconstructs and
what it cannot.

```bash
YESTERDAY=$(date -v-1d +%Y-%m-%d 2>/dev/null || date -d yesterday +%Y-%m-%d 2>/dev/null || date +%Y-%m-%d -d "1 day ago" 2>/dev/null)

janus session open --date $YESTERDAY
janus coverage run --date $YESTERDAY
janus macro record --date $YESTERDAY --summary "breadth improving, regime neutral" --metric regime=0.5
janus cluster record --date $YESTERDAY crypto_bluechip --metric regime=0.5
janus cluster record --date $YESTERDAY crypto_defi      --metric regime=0.5

janus screen record --date $YESTERDAY BTC --metric score=5 --metric confidence=1
janus screen record --date $YESTERDAY ETH --metric score=5 --metric confidence=1
janus screen record --date $YESTERDAY UNI --metric score=5 --metric confidence=1

janus score record --date $YESTERDAY BTC \
  --factor catalyst=2 --factor trend=2 --factor secular=1 \
  --factor crowding=50 --factor divergence=0 --factor confidence=1
janus score record --date $YESTERDAY ETH \
  --factor catalyst=2 --factor trend=2 --factor secular=1 \
  --factor crowding=50 --factor divergence=0 --factor confidence=1
janus score record --date $YESTERDAY UNI \
  --factor catalyst=2 --factor trend=2 --factor secular=1 \
  --factor crowding=50 --factor divergence=0 --factor confidence=1
```

### 7. Score BTC and ETH with bullish factors that pass the trend gate

The exact directive depends on the coverage data. With a bullish coverage
snapshot (price above SMA 50/200), the factors below should produce
`INITIATE` directives for both BTC and ETH.

```bash
janus score record BTC \
  --factor catalyst=2 \
  --factor trend=2 \
  --factor secular=1 \
  --factor crowding=50 \
  --factor divergence=0 \
  --factor confidence=1

janus score record ETH \
  --factor catalyst=2 \
  --factor trend=2 \
  --factor secular=1 \
  --factor crowding=50 \
  --factor divergence=0 \
  --factor confidence=1
```

Reprint a stored plan without re-entering factors:

```bash
janus score show BTC
janus score show ETH
```

### 8. Expected result

For both `BTC` and `ETH` you should see:

```json
{
  "ok": true,
  "data": {
    "symbol": "BTC",
    "directive": "INITIATE",
    "plan": {
      "directive": "INITIATE",
      "trend_gate": "pass",
      "entry_plan": { "side": "long", "max_units": 3 }
    }
  }
}
```

If the coverage snapshot is not above the SMAs, the trend gate may report
`fail` and the directive becomes `STAND_ASIDE` instead.

The score plan also includes a sizing plan based on the declared capital, ATR,
and conviction. Look for `plan.sizing_plan` with suggested notional, risk dollars,
stop price, and projected heat after the trade.

### 9. Open the recommended trades

From that day's sizing plan, which is what production does — the operator
supplies only the fill price:

```bash
janus trade open BTC --direction long --price 65000 --size auto --stop auto
janus trade open ETH --direction long --price 3400 --size auto --stop auto
```

`--size auto` takes `sizing_plan.suggested_notional`, and `--stop auto` places
the initial stop at `stop_atr_multiple × ATR` below the entry. Risk is then
`notional × stop distance` — the size actually taken, not the risk budget it was
derived from.

Manual override, when you deliberately want a size the plan did not pick:

```bash
janus trade open BTC --direction long --price 65000 --stop 62000 --risk 500 --notional 5000 --tag core
janus trade open ETH --direction long --price 3400 --stop 3200 --risk 500 --notional 5000 --tag core
```

Verify the open book:

```bash
janus trade list --open
janus trade show 1
```

### 10. Inspect heat and stop-ladder state

```bash
janus trade show 1
```

`trade show` now reports:
- `summary.open_risk` and `summary.total_notional`
- `progress.unrealized_r` for the trade
- `coverage.mark_price` and the nearest moving-average context

A unit whose stop has moved to breakeven contributes zero heat, freeing
capacity for new positions. The heat gate uses this when scoring an `INITIATE`
or `ADD` directive.

### 11. Clean up

```bash
rm -f $JANUS_DB
```

---

## 13-day walkthrough

One asset, one trade, thirteen consecutive sessions. It walks a position from
first signal through entry, two adds, a partial, a trailing stop, a late-trend
tighten, a trim, and a decay exit — hitting every gate and every stop-ladder rung
along the way.

### Why this one is scripted

`coverage run --date <past>` does reconstruct real history (see
[Replaying real history](#replaying-real-history) below), but real history is the
wrong tool here for two reasons. It never lands a ladder milestone on a chosen
day — you cannot ask the market to reach +1R on Thursday — and it changes every
time you run it, so a scenario built on it cannot be a regression check.

So this recipe scripts the price path with `coverage set` and seeds the market
without a network call. That makes it fully offline and deterministic: same
output every run, on any day, with no API key. If the output below stops
matching, something in the gates or the ladder changed.

### The price path

The asset is a synthetic `SIM` at a starting price of 100 so the R arithmetic
stays legible. Every entry is sized by the system (`--size auto --stop auto`),
which is what production does — nothing here is a hand-picked dollar figure.

ATR is pinned at 2.5 throughout, so with `stop_atr_multiple=2` the stop always
sits 5 below entry: a **5% stop**. At the default `account_capital=100000` and
`per_asset_max_notional_pct=20` the per-asset cap binds, so the first unit comes
out at **$20,000 notional, risking $1,000 — 1R = $1,000**. That puts the ladder
milestones on round marks:

| Mark | 105 | 107.5 | 110 |
| --- | --- | --- | --- |
| Unrealized R on the first unit | +1.0R | +1.5R | +2.0R |

R is where the stop is, not how big the unit is, so those marks hold at any
account size — see the `account_capital` variation below. The trailing stop
(`trailing_atr_multiple=2`) likewise always sits 5 below the mark.

### Setup

```bash
export JANUS_DB=/tmp/janus-walkthrough.db
rm -f $JANUS_DB

janus init

# Seed one market directly. `asset add` requires a market whose listed_at is old
# enough for 200 daily bars, but it does not hit the network to check — so a
# single row is all the catalog we need. Defaults cover the rest: market_id 1,
# perp, active, listed 2020-01-01.
janus market set SIM --price-decimals 2 --size-decimals 4

janus cluster add sim --name "Simulated"
janus asset add SIM --class crypto --cluster sim
```

One helper runs the whole pipeline for a single session. `coverage set` writes
the scripted market data and stamps the phase, which is what `coverage run` would
otherwise do from the network.

```bash
# day <date> <mark> <px20> <px50> <px200> <catalyst> <trend> <secular> \
#     <crowding> <divergence>
day() {
  janus session open --date "$1" >/dev/null 2>&1
  janus macro record   --date "$1" --summary "walkthrough" --metric regime=0.5 >/dev/null
  janus cluster record --date "$1" sim --summary "walkthrough" --metric regime=0.5 >/dev/null
  janus coverage set SIM --date "$1" --close "$2" --atr 2.5 \
    --px-vs-sma20 "$3" --px-vs-sma50 "$4" --px-vs-sma200 "$5" --complete >/dev/null
  janus screen record --date "$1" SIM --metric score=5 --metric confidence=1 \
    --rationale "walkthrough" >/dev/null
  echo "=== $1  mark=$2"
  janus score record --date "$1" SIM \
    --factor catalyst="$6" --factor trend="$7" --factor secular="$8" \
    --factor crowding="$9" --factor divergence="${10}" --factor confidence=1
}
```

`coverage set` exists for exactly this: driving a designed price path without a
network round trip. It is not part of the daily pipeline — the cron job uses
`coverage run` — and it is the reason this recipe no longer hand-writes an
`INSERT` against the coverage table, which used to break whenever a column moved.
`market set` is the same idea for the catalog row, so the whole recipe now runs
through the CLI with no `sqlite3` at all.

### The thirteen days

Run these in order. Each `day` line prints the score envelope; the `janus trade`
lines are the operator acting on the directive it produced. Every one of them
takes its size and stop from that day's plan — `--size auto` reads
`sizing_plan.suggested_notional`, `--stop auto` trails from ATR, and the
`--fraction 0.5` on day 5 is the `trim_fraction` the ladder returned. Only
`--price` is the operator's, because only the fill is.

```bash
#   date       mark  px20 px50 px200  cat trend sec  crowd  div
day 2026-03-02 98    1.0  0.5   8.0    2   2     1    50     0
day 2026-03-03 100   1.5  1.0   9.0    2   2     1    50     0
janus trade open SIM --direction long --price 100 --size auto --stop auto \
  --tag core --date 2026-03-03

day 2026-03-04 101   1.5  1.0   9.0    1   2     1    50     0
day 2026-03-05 105   2.0  1.5  10.0    1   2     1    50     0
janus trade set-stop 1 --stop auto

day 2026-03-06 107.5 2.5  2.0  11.0    1   2     1    50     0
janus trade exit 1 --unit 1 --fraction 0.5 --price 107.5 --date 2026-03-06

day 2026-03-07 108   2.5  2.0  12.0    2   2     1    50     0
janus trade add-unit 1 --price 108 --size auto --stop auto \
  --tag add1 --date 2026-03-07

day 2026-03-08 110   3.0  2.5  14.0    2   2     1    50     0
janus trade add-unit 1 --price 110 --size auto --stop auto \
  --tag add2 --date 2026-03-08

day 2026-03-09 112   3.5  3.0  16.0    2   2     1    50     0
janus trade set-stop 1 --stop auto

day 2026-03-10 115   4.0  3.5  22.0    2   2     1    88     0
janus trade set-stop 1 --stop auto

day 2026-03-11 113   3.5  3.0  21.0    1   1     1    70     0
day 2026-03-12 111   2.0  1.5  18.0    0   0     0    50     1
janus trade exit 1 --unit 3 --price 111 --date 2026-03-12

day 2026-03-13 109   1.0  0.5  15.0    0   0     0    50     0
janus trade exit 1 --price 109 --date 2026-03-13

day 2026-03-14 107   0.5  0.2  13.0    0   0     0    50     0
```

### What should happen, and why

| # | Date | Mark | `direction` / `conv` | Directive | Ladder rung | Why |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 03-02 | 98 | 1.32 / 7 | `STAND_ASIDE` | — | Signal is strong enough, but `signal_persist_days=2` means one day is never enough. `persistence_gate=fail` |
| 2 | 03-03 | 100 | 1.32 / 7 | `INITIATE` | — | Second identical day clears persistence. `persistence_rule=persisted` |
| 3 | 03-04 | 101 | 1.07 / 6 | `HOLD` | `entry` | +0.2R. Conviction 6 clears the initiate bar but not `signal_conviction_add=7`, so no second unit |
| 4 | 03-05 | 105 | 1.07 / 6 | `HOLD` | `breakeven` | +1.0R hits `breakeven_trigger_r`. Ladder returns `new_stop=100` on the oldest unit |
| 5 | 03-06 | 107.5 | 1.07 / 6 | `HOLD` | `partial` | +1.5R hits `partial_trigger_r`. Ladder returns `trim_fraction=0.5`; banking it opens the add window |
| 6 | 03-07 | 108 | 1.32 / 7 | `ADD` | `runner` | Catalyst back to 2 lifts conviction to 7, clearing the add bar. Trail to 103 |
| 7 | 03-08 | 110 | 1.32 / 7 | `ADD` | `runner` | Third unit. Trail to 105 |
| 8 | 03-09 | 112 | 1.32 / 7 | `HOLD` | `runner` | Signal is unchanged and every gate still passes, but the position is at `max_units=3`. The ceiling, not the signal, ends the adding |
| 9 | 03-10 | 115 | 0.82 / 5 | `HOLD` | `tighten` | `px_vs_sma200=22` with `--factor crowding=88` trips `late_trend`. The same crowding drives sentiment to −1.5, cooling conviction to 5 — one input, both effects |
| 10 | 03-11 | 113 | 0.58 / 4 | `HOLD` | `runner` | Conviction exactly at `conv_hold=4` — the floor holds, no trim |
| 11 | 03-12 | 111 | 0.045 / 1 | `TRIM` | `runner` | Conviction collapses. `--factor divergence=1` makes it an actionable new signal, so the persistence rule lets `TRIM` stand instead of downgrading it to `HOLD` |
| 12 | 03-13 | 109 | 0.045 / 1 | `EXIT` | `decay_exit` | Second consecutive day under `decay_conviction_floor=4` on the held side. The stop ladder escalates past the directive |
| 13 | 03-14 | 107 | 0.045 / 1 | `STAND_ASIDE` | — | Flat again, and nothing here would get back in |

### Expected final state

```bash
janus trade show 1
```

```json
{
  "trade":   { "status": "closed", "opened_on": "2026-03-03", "closed_on": "2026-03-13",
               "initial_price": 100, "initial_stop": 95, "initial_risk": 1000 },
  "summary": { "open_units": 0, "closed_units": 4, "open_risk": 0,
               "realized_pnl": 2023.74, "r_multiple": 2.02, "net_r_multiple": 2.02 }
}
```

**+2.02R on a trade whose best mark was +3.71R.** That gap is the ladder working
as designed, not a bug: breakeven, the partial, and the trail each trade upside
for a floor, and the decay exit gets out on evidence rather than on the stop.

### Three things this recipe exposes

These are easy to get wrong when reading the code, so the walkthrough is built to
make each one visible:

1. **Gate inputs come from the score's factors, never from the screen row.**
   `crowding`, `capitulation`, and `divergence` are all `score record --factor`
   inputs, and the gates read them from there. Recording them on `screen record`
   does nothing — `SCREEN.md` allows only `score` and `confidence`, and the extra
   keys are inert. Day 9 reaches `late_trend` purely on `--factor crowding=88`.

   This is worth knowing because it was wrong until recently: the gates used to
   read all three off the screen row, where nothing writes them, which pinned
   `crowding` at its 50 default and made `late_trend` — and the `tighten` rung
   behind it — unreachable. `score.test.ts` now pins the source.

2. **A fractional exit splits a unit and renumbers what follows.** After day 5,
   `seq 1` is the surviving half and `seq 2` is the banked half — so the first
   *add* is `seq 3`, which is why day 11 trims `--unit 3`. Check `trade show`
   before targeting a unit by sequence.

3. **Units are not all the same size, and risk is not the budget.** Every entry
   here hits the per-asset notional cap at $20,000, but the risk differs by unit
   — $1,000 on the day-2 entry (stop 5.00% away), $925.93 on the day-6 add (stop
   103 against a 108 entry is 4.63%), $909.09 on day 7. Risk is always
   `notional × stop distance`, derived from the size actually taken; it is *not*
   the `capital × max_risk% × conviction/10` budget the size was computed from.
   Those two only coincide when the cap does not bind. `initial_risk` is the
   denominator of every R in the ladder, so this distinction is load-bearing.

### Variations worth trying

Each of these is a one-line change that should move the output in a specific
direction — useful for confirming a gate is actually wired to its parameter:

```bash
# Day 4 stays on the `entry` rung instead of `breakeven`. Day 5 still fires
# `partial` — the two rungs read separate triggers, so this only moves one.
janus param set breakeven_trigger_r 5

# The ceiling binds a day earlier: day 7 becomes HOLD with every gate still
# passing, which is the cleanest way to see max_units and not the signal stopping
# the adds.
janus param set max_units 2

# One weak day is enough. Day 11's TRIM becomes an EXIT on the decay rung.
janus param set decay_persist_days 1

# Nothing changes. Every directive, every rung, and the final 2.02R are
# identical; only the dollars shrink 100x, to $200 units risking $10. Sizing
# scales with capital and R is measured against the stop, so the whole recipe is
# scale-invariant now that it trades what the system suggests.
janus param set account_capital 1000

# The heat gate, which the defaults never reach: the $1,000 first unit is now
# the entire book's budget. Day 1 gains `heat` to its blocked list
# (`long entry blocked by persistence, heat gate(s)`) and day 8's HOLD changes
# cause — `thesis intact; add blocked by heat gate(s)` instead of the unit cap.
janus param set max_heat_pct 1
```

Reset by deleting the database and re-running from **Setup** — parameters are
stored, so they persist across days within a run.

### One caveat on `trade show`

`trade show --date` marks against the most recent coverage row **at or before**
that date, so it reprices as asked — running it at day 9 returns the +3.71R peak.
What it does *not* do is reconstruct the position as it stood that day: the units
are always the ones open right now. Ask for day 3 after three adds and you get
today's three units marked at day 3's price, which is a coherent "what is this
book worth at that mark" but not a time machine.

So `--date` is trustworthy while a position's shape is unchanged, and misleading
across an add or a trim. To see the ladder's own view of a past day, read the
`stop_plan` on that day's stored score (`janus score show SIM --date ...`) rather
than backdating a `trade show`.

### Clean up

```bash
rm -f $JANUS_DB
```

---

## Replaying real history

The walkthrough above proves the ladder behaves as designed. This one proves it
survives contact with real data — prices that gap, stall, and reverse in ways no
scripted path thinks to include.

`coverage run --date <past>` reconstructs a historical session. A run already
pulls ~400 days of daily bars and uses only the newest, so the history is in hand
either way; a backfill just cuts the window at the date you asked for. Everything
bar-derived — OHLC, all three SMAs, ATR, the MA distances, the crosses — comes
back exactly.

**What a backfilled row cannot have:** the Lighter snapshot is point-in-time with
no history. On a backfilled day the close stands in as `mark_price` and
`index_price` (for a daily-bar swing system the close *is* the day's reference,
and the stop ladder needs a mark to compute R at all), `daily_change_pct` is
recomputed from the prior bar, and `open_interest` is `null`. If a rule you are
testing leans on open interest, backfill will not exercise it.

```bash
export JANUS_DB=/tmp/janus-replay.db
export JANUS_LIGHTER_URL=https://mainnet.zklighter.elliot.ai
rm -f $JANUS_DB

janus init
janus market sync
janus cluster add crypto_bluechip --name "Crypto Blue-Chip"
janus asset add BTC --class crypto --cluster crypto_bluechip

# Ten consecutive sessions, oldest first. Each needs its regime reads before
# coverage will run in phase order.
for D in 2026-07-06 2026-07-07 2026-07-08 2026-07-09 2026-07-10 \
         2026-07-13 2026-07-14 2026-07-15 2026-07-16 2026-07-17; do
  janus session open --date $D >/dev/null
  janus macro record   --date $D --summary "replay" --metric regime=0 >/dev/null
  janus cluster record --date $D crypto_bluechip --summary "replay" --metric regime=0 >/dev/null
  janus coverage run   --date $D >/dev/null
  janus screen record  --date $D BTC --metric score=5 --metric confidence=1 --rationale "replay" >/dev/null
  echo "=== $D"
  janus score record   --date $D BTC \
    --factor catalyst=1 --factor trend=1 --factor secular=1 \
    --factor crowding=50 --factor divergence=0 --factor confidence=0.8
done
```

Pick dates inside the last ~400 days; earlier than that and the bar window does
not reach, which reports `INSUFFICIENT_HISTORY` for the asset rather than
silently using a later bar.

**What to check.** There is no fixed expected output — that is the point. Look
for the things that should hold against any data:

```bash
# Closes must differ across sessions. Identical values mean the backfill
# regressed to stamping one snapshot across every date.
janus coverage list --date 2026-07-06 --asset BTC
janus coverage list --date 2026-07-17 --asset BTC
```

- Every command returns `ok:true`, and no phase reports out of order.
- `close` and `px_vs_sma*` move day to day, and `mark_price` equals `close`.
- `open_interest` is `null` on every row — that is correct here, not a failure.
- Directives stay plausible: no `INITIATE` on a day the trend gate reports
  `fail`, no `ADD` beyond `max_units`.

Backfill and `coverage set` answer different questions, so keep both: real data
catches the cases nobody thought to script, and scripted data catches the
regressions real data reaches only by luck.

### Clean up

```bash
rm -f $JANUS_DB
```
