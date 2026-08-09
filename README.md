# janus

A state manager for a discretionary trading system on [Lighter](https://lighter.xyz)
perpetuals. It records what was decided and why: macro reads, cluster reads, market
coverage, screens, scores, and the trades an operator actually put on.

**janus never places, modifies, or cancels an order.** It has no keys and no write path
to any exchange. The only network calls it makes are read-only fetches of Lighter's
public market catalog and daily candles. Execution stays with the human.

It is driven two ways: an AI agent runs the five-phase daily pipeline, and a human
operator logs trades. Every command prints exactly one JSON object, so the agent side
needs no screen-scraping.

## Install

You need **Node 24 or newer** (`node -v`) and access to this repository. Nothing else —
the build output ships in the repo, so there is no compile step on your machine.

```
npm i -g git+ssh://git@github.com/masha256/janus.git
janus init
janus --help
```

`janus init` creates `~/.janus/janus.db`. That path is fixed, so `janus` reaches the same
database from any directory.

| | |
| --- | --- |
| Update | re-run the `npm i -g` line |
| Pin a version | append `#v0.1.0` (any tag or commit) to the URL |
| Uninstall | `npm uninstall -g janus` |
| Use a different database | set `JANUS_DB` |

If the install fails with `EBADENGINE` or `Unsupported engine`, your Node is too old:
janus uses `node:sqlite`, which does not exist before 24.

## Working on janus

```
git clone git@github.com:masha256/janus.git
cd janus
npm install
npm test          # node:test, no framework, no network
npm run build     # tsc → dist/
npm link          # optional: `janus` on PATH, pointing at this checkout
```

One runtime dependency, [commander](https://github.com/tj/commander.js), which parses the
CLI and generates `--help`. TypeScript is a dev dependency only; `.ts` sources run
directly under Node's type stripping, so `npm test` needs no build.

**`dist/` is committed on purpose.** It is what makes `npm i -g git+ssh://…` a plain file
copy — recipients need no TypeScript and no build step, and npm's install-time build hook
is fragile enough to be worth avoiding. The cost is that a source change is only released
once you rebuild and commit the output:

```
npm run build && git add dist && git commit
```

`.gitattributes` marks `dist/**` as generated, so those diffs stay collapsed in review.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `JANUS_DB` | `~/.janus/janus.db` | SQLite file. Created by `janus init`, along with its directory. The default is absolute on purpose, so `janus` reaches the same database from any working directory. |
| `JANUS_LIGHTER_URL` | `https://mainnet.zklighter.elliot.ai` | Lighter API base. Points the two read-only endpoints at a stub for tests or replay. |

## Output contract

Every command writes one JSON object to stdout and nothing else.

```json
{"ok":true,"data":{...}}
{"ok":false,"error":{"code":"VALIDATION","message":"..."}}
```

Exit code is `0` on success and `1` on error. The `ok` flag and the exit code always
agree, so either one is sufficient to branch on.

### `--human`

Any command takes `--human`, which drops the envelope and renders the same result as
text: scalars as `key: value`, lists of records as aligned tables, metric and result bags
as `k=v` pairs. Errors go to **stderr** as `janus: message (CODE)`, leaving stdout empty,
and the exit code is unchanged.

```
$ janus score list --human
session_date: 2026-08-01
count: 1
scores (1):
  symbol  class   direction  conviction  directive  metrics             results
  ------  ------  --------  ----------  ---------  ------------------  -------------------
  XPL     crypto  2          10          NONE       catalyst=2 trend=2  agreement=1 ...
```

It is a display flag only — JSON stays the default, so nothing an agent parses changes.
`--help` and `--version` are plain text in both modes.

### Help

`janus --help` lists every command, `janus <command> --help` every verb, and
`janus <command> <verb> --help` every flag with its meaning. That is generated from the
command definitions, so it cannot drift from what the parser accepts.

Error codes:

| Code | Meaning |
| --- | --- |
| `NOT_FOUND` | The named cluster, asset, market, or trade does not exist. |
| `ALREADY_EXISTS` | Creating something whose key is taken. |
| `VALIDATION` | Bad flag, bad value, missing argument, unknown verb, or a refused removal. |
| `PHASE_ORDER` | An earlier phase of the session is not complete. Pass `--force` to override. |
| `SESSION_MISSING` | `--date` names a session that was never opened. |
| `NO_COVERAGE` | Screening an asset with no coverage row for the session. |
| `NOT_FLAGGED` | Scoring an asset that is not in the session's scoring queue. |
| `POSITION_CONFLICT` | Opening a second trade on an asset that already holds one. |
| `UPSTREAM` | Lighter returned an error or an unexpected shape. |
| `INSUFFICIENT_HISTORY` | Not enough daily bars to compute coverage for a market. |
| `INTERNAL` | Anything unclassified. Treat as a bug. |

## Negative numbers

An argument parser reads a leading `-` as the start of the next option, so a
space-separated negative would be ambiguous. Every signed value rides a `key=value` pair
instead — `--metric score=-2`, `--factor crowding=-1.5` — and a pair is one token
beginning with a letter, so nothing is ambiguous and both spellings work:

```
janus macro record --metric score=-2 ...     # fine
janus macro record --metric=score=-2 ...     # also fine
```

`param set` and `cluster set-param` take their key and value as **positional arguments**,
and turn on commander's positional passthrough so a bare `-2` is not mistaken for an
option — write `janus param set w_crowding -2` plainly.

## Sessions

A session is one calendar day, keyed `YYYY-MM-DD` and anchored to `America/New_York` so
the day boundary sits at the US close. There is no `session open` command: the first
*phase* command of the day creates the session. Read-only commands never do — they
report an empty result for a day that has not started.

`--date YYYY-MM-DD` addresses an **existing** session, for correcting or re-running a
phase. It never creates one, and never back-dates.

## The five phases

Each stamps a completion timestamp on the session row (`macro_at`, `cluster_at`,
`coverage_at`, `screen_at`, `score_at`) and refuses to run until its **prerequisites** are
stamped (`PHASE_ORDER`, overridable with `--force`). `janus session status` reports where
the pipeline stands, and `next_phase` walks them in the recommended order below.

Recommended order is not the same as dependency order:

```
macro ──▶ cluster ──┐
                    ├──▶ screen ──▶ score
coverage ───────────┘
```

**`coverage` depends on nothing.** It fetches market data and derives indicators from it;
none of that touches the reads, so it can run first, alongside them, or on a day nobody
reads anything. Everything downstream still waits for it, and `screen` still waits for
the reads.

1. **`macro`** — one macro read for the session: summary plus any number of
   `--metric key=value` pairs for what was observed. The `state` column is not exposed
   through the CLI; it stays `NEUTRAL` until a future release. Completes immediately. If
   no clusters exist, it vacuously completes `cluster` too.
2. **`cluster record`** — one read per cluster, again as `--metric` pairs. Completes once
   every cluster has been read. It shares the `cluster` command with the roster verbs, so
   the session's reads list as `cluster reads` — `cluster list` stays the roster.
3. **`coverage`** — the only phase that touches the network, and the only one with no
   prerequisites. Fetches daily candles and a
   snapshot for every eligible asset (active roster entries on live markets, plus
   anything holding an open trade) and derives moving averages, ATR, and cross state. A
   full run (no `--asset`) completes the phase; assets with too little history are
   reported in `skipped` and do not block it. An `--asset`-scoped run never completes the
   phase.
4. **`screen`** — one read per covered asset, as `--metric` pairs. The formula decides
   which of them flag the asset, and snapshots the threshold in force so retuning later
   never rewrites history. Completes once every covered asset is screened.
5. **`score`** — a weighted decision for everything in the queue: assets flagged this
   session, unioned with anything holding an open trade. `janus score queue` returns that
   set with its coverage and screen attached. `score record` derives `direction`,
   `conviction`, and a directive from the `--factor` values, the session's macro and
   cluster reads, and the resolved parameters, snapshotting the position state as it
   stood. Completes once the queue is fully scored.

Which metrics each phase actually requires is the formula's business, not the command's —
see [Metrics and results](#metrics-and-results).

## Metrics and results

Every phase records two flat key→value bags. **Metrics** are what was observed — whatever
`--metric key=value` pairs were passed, stored verbatim. **Results** are what the phase
concluded from them, derived at record time. Each lives in a sibling table of
`(scope…, key, value_num, value_text)`, replaced wholesale on a re-run so a stale key
cannot survive:

```
macro_read          cluster_read          screen           score
macro_read_metric   cluster_read_metric   screen_metric    score_metric     ← observed
macro_read_result   cluster_read_result   screen_result    score_result     ← concluded
```

A value that parses as a number lands in `value_num`; anything else is free text in
`value_text` (`--metric judgement="rolling over"`). Every read returns
`{ ...row, metrics: {…}, results: {…} }`.

The phase row keeps what is neither bag — state, summary, rationale, directive — plus the
handful of conclusions that are always present and worth sorting and filtering on:
`screen.flagged`, and `score.direction` / `score.conviction`. Those are set by the formula
like any other conclusion; they are columns because every row has one.

**The CLI does not know what any metric means.** It parses `--metric` pairs, hands the
whole bag to the phase's formula, and stores what comes back. Which metrics are mandatory,
what range they must fall in, and what is concluded from them are decisions that live
entirely in `src/domain/` — so changing a formula changes its requirements with it, and no
command has to be edited.

What the v1 formulas require and produce today:

| Phase | Formula | Requires | Concludes |
| --- | --- | --- | --- |
| macro | `deriveMacroRead` (`domain/read.ts`) | `regime` (−2…2) | (none v1) |
| cluster | `deriveClusterRead` (`domain/read.ts`) | `regime` (−2…2) | (none v1) |
| screen | `deriveScreen` (`domain/screen.ts`) | `score` (1…10), `confidence` (0…1) | the `flagged` column, and `threshold`, `regime_smile` |
| score | `deriveScore` (`domain/score.ts`) | at least one `--factor`, each −2…2 (`crowding` 1…100; `confidence` 0…1 quality, absent = 0) | the `direction`, `conviction`, and `directive` columns, and `w_<factor>`, `sentiment`, `agreement`, `confidence` |

**Everywhere it appears, `confidence` is a quality on 0…1** — higher means more
trustworthy, and a missing confidence means "no information" (0), never
"inherit another phase's". An older ± margin-of-error scale on 0…2 is
retired; nothing reads it.

Anything else passed as `--metric` is stored untouched alongside the required ones. A
missing or out-of-range requirement is a `VALIDATION` error naming the metric.

Each formula receives everything the session already concluded, top down. The cluster read
gets the whole macro read. `deriveScore` gets more still:

- the macro read, metrics and results both;
- the asset's cluster read, or `null` when it has no cluster;
- its screen, or `null` when it reached the queue on an open trade rather than a flag;
- **every open position in the book**, not just this asset's, so a decision can be weighed
  against what is already on;
- the asset itself, with its `CoverageValues` for the session.

`deriveScore` turns that context into `direction` = normalised weighted mean of
the factor scores, and `conviction` = |direction| magnitude × factor **agreement**
× agent `confidence` — so mixed signals score low conviction even when
net-positive (the "direction ≠ conviction" rule). It snapshots the exact
weights, sentiment, agreement, and confidence it used onto the row.

`direction` and `conviction` are the two standardised numbers the directive is
derived from — see the parameter table below for the thresholds each one gates.

****All four formulas are v1 placeholders**, marked as such in their own files. Every
constant in them is a tunable parameter, so calibrating needs no code change, and
replacing one outright is a one-file edit — nothing outside a formula's module reads it.

## Scoring gates

`deriveScore` runs six independent gates and folds their results into a `size_tier`
(`blocked`, `starter`, or `full`) and a final directive
(`INITIATE`/`ADD`/`HOLD`/`TRIM`/`EXIT`/`STAND_ASIDE`). Each gate reports its own
status in `plan` so the operator can see exactly why an entry was allowed, reduced,
or blocked.

| Gate | Purpose | Result values |
| --- | --- | --- |
| `signalGate` | Direction/conviction thresholds for initiate, add, and exit. | `pass` / `fail` |
| `persistenceGate` | Signal must persist for `signal_persist_days` run-days. | `pass` / `fail` |
| `trendGate` | Price/MA structure for the proposed direction. | `pass` / `starter` / `fail` / `late_trend` |
| `binaryGate` | Blocks entry around a known binary event recorded on the screen. | `pass` / `blocked` |
| `heatGate` | Account-level risk heat (stubbed until sizing is built). | `pass` / `blocked` |
| `flipflopGate` | After an exit, opposite-side re-entry needs a stronger, persisted signal. | `pass` / `blocked` / `n/a` |

`size_tier` becomes `blocked` if any gate blocks it. It becomes `starter` when no
gate blocks but at least one gate returns `starter`.
Otherwise it is `full`. Entries use `size_tier` to decide how aggressively to size;
HOLD/EXIT/TRIM directives still carry the gate status for observability.

**Gate parameter reference** (all resolve through `cluster_param → global_param → built-in default`):

| Parameter | Gate | Default | Description |
| --- | --- | --- | --- |
| `signal_direction_initiate` | signalGate | `0.9` | Minimum `\|direction\|` for a flat asset to pass the signal gate. |
| `signal_conviction_initiate` | signalGate | `5` | Minimum `conviction` for a flat asset to pass the signal gate. |
| `signal_direction_add` | signalGate | `1.0` | Minimum `\|direction\|` for an aligned position to pass the signal gate for adding. |
| `signal_conviction_add` | signalGate | `6` | Minimum `conviction` for an aligned position to pass the signal gate for adding. |
| `signal_direction_exit` | signalGate | `1.0` | Minimum `\|direction\|` against an open position to pass the signal gate for exit. |
| `signal_persist_days` | persistenceGate | `2` | Run-days the signal gate must have passed, including today. |
| `trend_sma20_threshold_long` | trendGate | `0` | Long `px_vs_sma20` must be > threshold to be starter or pass. |
| `trend_sma50_threshold_long` | trendGate | `0` | Long `px_vs_sma50` must be >= threshold to be pass (below is starter). |
| `trend_sma20_threshold_short` | trendGate | `0` | Short `px_vs_sma20` must be < threshold to be starter or pass. |
| `trend_sma50_threshold_short` | trendGate | `0` | Short `px_vs_sma50` must be <= threshold to be pass (above is starter). |
| `late_trend_ma_distance` | trendGate | `20` | Distance beyond the 200-day MA that, with extreme crowding, marks a move as `late_trend`. |
| `late_trend_crowding_extreme` | trendGate | `85` | Crowding level that, with a stretched 200-day MA distance, marks a move as `late_trend`. |
| `binary_cooldown_days` | binaryGate | `14` | Days ahead of a recorded binary event during which entry is blocked; entry reopens once the event has passed. |
| `flipflop_cooldown_days` | flipflopGate | `5` | Days after an exit during which opposite-side re-entry faces extra scrutiny. |
| `flipflop_opposite_direction_min` | flipflopGate | `0.6` | Minimum `\|direction\|` for opposite-side re-entry during the flipflop cooldown. |
| `flipflop_opposite_persist_days` | flipflopGate | `3` | Run-days the opposite-side signal must have persisted to override the flipflop cooldown. |
| `account_capital` | heatGate | `100000` | Total investable account capital used for sizing and heat calculations. |
| `max_heat_pct` | heatGate | `10` | Account-level heat ceiling as a percent of `account_capital`. |
| `per_trade_max_risk_pct` | heatGate | `2.5` | Max risk per trade as a percent of `account_capital` before conviction scaling. |
| `per_asset_max_notional_pct` | heatGate | `20` | Hard per-asset notional cap as a percent of `account_capital`. |

`account_capital`, `max_heat_pct`, and `per_trade_max_risk_pct` are **account-scope**:
heat is measured across the whole book, so a per-cluster ceiling would make the same
book pass or fail depending on which cluster's asset is being scored.
`cluster set-param` refuses them, and any cluster rows written before that guard
existed are ignored at resolve time. Set them with `janus param set` only.

`trendGate` is a three-tier gate driven only by price vs the 20-day and 50-day MAs:

| Side | `px_vs_sma20` | `px_vs_sma50` | Result |
| --- | --- | --- | --- |
| Long | <= threshold | any | `fail` |
| Long | > threshold | < threshold | `starter` |
| Long | > threshold | >= threshold | `pass` (or `late_trend` if stretched vs 200-day + crowded) |
| Short | >= threshold | any | `fail` |
| Short | < threshold | > threshold | `starter` |
| Short | < threshold | <= threshold | `pass` (or `late_trend` if stretched vs 200-day + crowded) |

`starter` reduces the entry to a smaller size tier; downstream sizing may later scale
the notional. `late_trend` still allows a starter entry but warns the position is
stretched and the ladder should tighten/partial early. The 50/200 cross checks that
were previously used are no longer part of the trend gate.

## Directive plans

The scoring phase does not place orders, but it produces a `ScorePlan` that tells
both the agent and the operator what to do about a position. The plan has three
moving parts: the **directive**, the **size tier**, and sub-plans for **entry**,
**stop management**, **trimming**, and **sizing**.

### Directives

| Directive | Meaning |
| --- | --- |
| `STAND_ASIDE` | No position, no entry. Either no edge or a gate blocked it. |
| `INITIATE` | Open the first unit of a new trade. |
| `ADD` | Add another unit to an existing, aligned trade. |
| `HOLD` | Thesis intact; no action today. |
| `TRIM` | Reduce the position, usually the newest unit. |
| `EXIT` | Close the entire position. |

The directive starts from the gates and current position state, then the
**persistence rule** resists flip-flopping. It may downgrade a fresh `EXIT` or
`TRIM` from a prior `HOLD`/`ADD` when there is no actionable new signal. A fresh
`INITIATE` from `STAND_ASIDE` is allowed when the persistence gate passed — the
second (or later) strong day is itself the confirmation. A signal is actionable
when the screen notes `capitulation` or `divergence`, when `\|catalyst\| ≥
actionable_catalyst_min`, or when `\|direction - previous_direction\| ≥
actionable_direction_delta`.

### Regime triggers

The raw `regime` recorded on the screen can trigger extreme-contrarian overrides.
(The triggers deliberately read the raw regime, not `regime_smile` — the smile is
already sign-flipped at extremes and capped at |1.2|, so triggering on it would be
both unreachable and inverted.)

- `regime_trigger_long_max` blocks new longs when regime is euphoric.
- `regime_trigger_short_min` blocks new shorts when regime is panicked.
- `regime_force_exit_threshold` forces a full `EXIT` when the regime extreme moves
  far enough against an open position.

### Unit ceiling

`max_units` caps how many units can be stacked into one trade via `ADD`. When the
ladder would add but the trade is already at the cap, it stays at `HOLD`.

### Conviction floor

`conv_hold` is the minimum conviction required to keep a position aggressive.
Below it, an aligned position downgrades to `HOLD` (or `TRIM` if more than one
unit is on), and adding is not considered.

### Stop/trim sub-plans

When a directive is `INITIATE`, `ADD`, `HOLD`, `TRIM`, or `EXIT`, the plan may
include a `stop_plan` and/or a `trim_plan`:

- `move_to_breakeven` — lock the oldest unit after a new add or +1R milestone.
- `trail` / `tighten` — adjust trailing stops; `tighten` is used under late-trend caution.
- `time_exit` — close the position for a time stop.
- `decay_exit` — close for signal decay.

The position ladder in the `trade` domain handles the actual stop math. See the
**Position sizing** section for the ATR-based ladder parameters.

## Position sizing

Sizing turns a score's `INITIATE` or `ADD` into a concrete, risk-controlled
position. The `sizing_plan` in a score includes the suggested notional, risk
dollars, stop price, and projected heat after the trade.

| Parameter | Scope | Default | Description |
| --- | --- | --- | --- |
| `account_capital` | sizing | `100000` | Total investable account base. |
| `max_heat_pct` | sizing | `10` | Max total open risk across the whole book as a percent of `account_capital`. |
| `per_trade_max_risk_pct` | sizing | `2.5` | Max risk for one trade as a percent of `account_capital`, before conviction scaling. |
| `per_asset_max_notional_pct` | sizing | `20` | Hard per-asset notional cap as a percent of `account_capital`. |
| `starter_size_fraction` | sizing | `0.5` | Multiplier applied to risk and notional when the trend gate returns `starter`. |
| `stop_atr_multiple` | sizing | `2` | Initial stop distance = `entry ± N × ATR`. |
| `trailing_atr_multiple` | sizing | `3` | Trailing stop distance in the runner / late-trend phase. |
| `breakeven_trigger_r` | sizing | `1` | Unrealized R at which the oldest unit's stop moves to breakeven. |
| `partial_trigger_r` | sizing | `1.5` | Unrealized R at which a partial exit is recommended. |
| `partial_exit_fraction` | sizing | `0.5` | Fraction of the newest unit trimmed at the partial target. |
| `max_time_stop_days` | sizing | `42` | Max calendar days a position that never worked can stay open. Only applies while fully at risk: a unit at breakeven or a trade past `breakeven_trigger_r` is exempt. |

Formulas used:

```
Risk $   = Capital × Max Risk % × (Conviction / 10)
Size $   = Risk $ / Stop Distance %
Heat $   = Risk $  (for pre-breakeven units; breakeven or better stops contribute zero)
```

The final suggested notional is the smaller of the risk-derived size and the
`per_asset_max_notional_pct` cap. `heatGate` blocks new entries/adds when
`current_heat + proposed_heat > max_heat_pct` of capital.

When the trend gate returns `starter`, `starter_size_fraction` scales both the
risk dollars and the resulting notional. A `late_trend` result is treated as
`starter` for sizing purposes.

### Trade ladder

1. **Entry** — initial stop set; full 1R at risk.
2. **+1R** — stop moves to breakeven on the oldest unit; heat freed.
3. **+1.5R** — partial exit on the newest unit opens the add window.
4. **Runner** — trailing stop at `trailing_atr_multiple × ATR`; never widened.
5. **Late trend** — same trailing distance, but labeled as a tighten.
6. **Time stop** — full exit if the position sits beyond `max_time_stop_days` still fully at risk (no unit at breakeven, under +1R).
7. **Signal decay** — pre-breakeven decays exit immediately; post-breakeven decays require two consecutive run-days of confirmation.

CLI support:
- `janus trade open <symbol> --size auto --stop auto` uses the score's sizing plan / ATR.
- `janus trade set-stop <trade> --stop auto` trails the stop at the ATR multiple.
- `janus trade set-stop` rejects any stop that would widen risk.

## Parameters

Thresholds and factor weights resolve through three rungs, most specific first:

```
cluster_param  →  global_param  →  built-in defaults
```

`janus cluster set-param` writes the first, `janus param set` the second. `janus param
list` shows the global layer and the resolved result; `janus cluster show` does the same
for a cluster. An asset with no cluster resolves against `global_param` and the defaults.

Defaults (`domain/params.ts` is the authority): `beta_factor 1.0`,
`screen_threshold 4.0`, `w_catalyst 0.15`, `w_sentiment 0.3`, `w_trend 0.3`,
`w_regime 0.15`, `w_secular 0.1`, `fear_premium 1.25`, `divergence_boost 0.5`,
`min_history_bars 200`, plus all gate, sizing, and directive-plan parameters
documented in the **Scoring gates**, **Position sizing**, and **Directive plans**
sections above.

The macro read is session-wide, so it resolves against the global rung only; a cluster
read resolves against its own cluster first, like everything else.

### Parameter reference

All parameters resolve through `cluster_param → global_param → built-in default`.
Set a global with `janus param set <key> <value>` or a cluster override with
`janus cluster set-param <key> <param> <value>`. The sections above describe what
each parameter does; the table below is a compact reference.

| Parameter | Scope | Default | Description |
| --- | --- | --- | --- |
| `beta_factor` | screen | `1.0` | Multiplier applied to the raw screen score before the threshold check. |
| `screen_threshold` | screen | `4.0` | Minimum `screen_score` for an asset to be flagged for the scoring queue. |
| `w_catalyst` | score | `0.15` | Weight of the momentum/catalyst factor in `direction`. |
| `w_sentiment` | score | `0.30` | Weight of the contrarian positioning/crowding factor in `direction`. |
| `w_trend` | score | `0.30` | Weight of the trend/flow factor in `direction`. |
| `w_regime` | score | `0.15` | Weight of the session's `regime_smile` in `direction`. |
| `w_secular` | score | `0.10` | Weight of the longer-horizon thesis factor in `direction`. |
| `fear_premium` | score | `1.25` | Scales the bullish side of the contrarian sentiment fade; >1 makes panic bounces fade harder than greed tops. |
| `divergence_boost` | score | `0.5` | Widens a contrarian fade when a price/crowding divergence is present. |
| `min_history_bars` | asset | `200` | Minimum listed bars for an asset to be added to the roster; below this a 200-day MA is impossible. |
| `max_units` | directive | `3` | Ceiling on how many units can be stacked into one trade via `ADD`. |
| `conv_hold` | directive | `4` | Conviction floor for staying put; below it the ladder downgrades to `TRIM` or `HOLD`. |
| `regime_trigger_long_max` | directive | `1.5` | Block new longs when the raw `regime` reaches this euphoric extreme. |
| `regime_trigger_short_min` | directive | `-1.5` | Block new shorts when the raw `regime` reaches this panicked extreme. |
| `regime_force_exit_threshold` | directive | `1.8` | Force a full `EXIT` when the raw `regime` exceeds this against an open position. |
| `actionable_catalyst_min` | directive | `1.5` | Minimum `\|catalyst\|` that counts as an actionable new signal for the persistence rule. |
| `actionable_direction_delta` | directive | `1.5` | Minimum change in `\|direction\|` from the prior score that counts as actionable. |

Boolean parameters use `1` for true and `0` for false.

## Commands

This list is a map; `--help` on any command is the authority, since it is generated from
the parser itself. Every command also takes `--human`.

`--notes`, `--summary`, `--rationale`, and `--thesis` accept `-` to read the value from
stdin; `--metric` values are always inline. `--asset` takes a comma-separated list
wherever it appears, and an unknown symbol fails the whole call rather than silently
returning a subset.

```
janus init                                          create/migrate the database

janus market sync                                   refresh the Lighter catalog
janus market list [--search TEXT] [--status STATUS]

janus cluster add <key> --name NAME [--notes -]
janus cluster list                                  the roster, not the session's reads
janus cluster show <key>
janus cluster set-param <key> <param> <value>
janus cluster rm <key>

janus param set <key> <value>                       write a global parameter
janus param rm <key>                                remove override, resume default
janus param list                                    global params over defaults

janus asset add <symbol> --class CLASS [--cluster KEY] [--notes -]
janus asset list [--active] [--inactive] [--cluster KEY] [--class CLASS]
janus asset show <symbol>
janus asset set <symbol> [--cluster KEY] [--class CLASS] [--notes -]
janus asset activate <symbol>
janus asset deactivate <symbol>
janus asset rm <symbol>                             refused once the asset has trades

janus session status [--date D]
janus session list [--limit N]
janus session open --date D                            backfill/testing only

janus macro record --summary - --metric k=v [--metric k=v ...]
janus macro reads [--date D]

janus cluster record <cluster> --metric k=v [--metric k=v ...]
janus cluster reads [--date D]                      the session's cluster reads

janus coverage run [--asset SYM[,SYM...]] [--force]
janus coverage list [--date D] [--asset SYM[,SYM...]]

janus screen record <symbol> --metric k=v [--metric k=v ...] [--rationale -]
janus screen list [--flagged] [--date D]

janus score queue [--date D]
janus score record <symbol> --factor key=value ... [--rationale -]
janus score show <symbol> [--date D]
janus score list [--date D]

janus trade open <symbol> --direction long|short --price P --stop S --risk R
                 --notional N [--thesis -] [--tag core|runner] [--date D]
janus trade add-unit <trade_id> --price P --stop S --risk R --notional N
                     [--tag core|runner] [--date D]
janus trade set-stop <trade_id> --stop S [--unit SEQ]
janus trade exit <trade_id> --price P [--unit SEQ] [--funding N] [--date D]
janus trade list [--open] [--closed] [--asset SYM[,SYM...]]
janus trade show <trade_id>
```

### Position management examples

These are manual operator workflows. `janus` recommends via the score plan; execution
stays with the human.

Open the first unit of a long swing, tag it `core` so the ladder knows which unit to
protect first:

```
janus trade open BTC --direction long --price 65000 --stop 62000 --risk 500 --notional 5000 --tag core
```

Use the score plan's suggested size and ATR-derived stop with `--size auto` and
`--stop auto` (price is still required because the plan is based on a prior mark):

```
janus trade open BTC --direction long --price 65000 --size auto --stop auto --tag core
```

Add a runner unit once the score plan calls `ADD` and the trend gate passes:

```
janus trade add-unit 1 --price 68000 --stop 66000 --risk 400 --notional 4000 --tag runner
```

Or let the plan size and stop the runner:

```
janus trade add-unit 1 --price 68000 --size auto --stop auto --tag runner
```

Move the stop on the oldest unit to breakeven after the plan suggests it, leaving the
runner's stop wider:

```
janus trade set-stop 1 --stop 65000 --unit 1
```

Trail the runner automatically at the configured ATR multiple:

```
janus trade set-stop 1 --stop auto
```

Trim one unit when the score plan calls `TRIM`; exit the newest unit to keep the core:

```
janus trade exit 1 --price 67500 --unit 2
```

Exit the whole position and record the funding paid over the hold so `Net R` includes it:

```
janus trade exit 1 --price 71000 --funding -120
```

Check the open position's plan for today without re-entering factors:

```
janus score show BTC
```

`--class` is one of `crypto`, `equity`, `etf`, `commodity`, `fx`, `index`.
`--direction` is required — there is no default, because a short logged as a long
inverts every directive derived from it.

On `trade`, `--date` is the real entry or exit date of a unit, not a session address.
Everywhere else it addresses a session.
