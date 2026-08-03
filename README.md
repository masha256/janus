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
  symbol  class   strength  conviction  directive  metrics             results
  ------  ------  --------  ----------  ---------  ------------------  -------------------
  XPL     crypto  2         10          NONE       catalyst=2 trend=2  agreement=1 ...
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
   set with its coverage and screen attached. `score record` derives `strength`,
   `conviction`, and a directive from the `--factor` values, the session's macro and
   cluster reads, and the resolved parameters, snapshotting the position state as it
   stood. The directive is a stub returning `NONE` until the ladder is written. Completes
   once the queue is fully scored.

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
`screen.flagged`, and `score.strength` / `score.conviction`. Those are set by the formula
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
| score | `deriveScore` (`domain/score.ts`) | at least one `--factor`, each −2…2 (`crowding` 1…100; `confidence` 0…1 quality, absent = 0) | the `strength`, `conviction`, and `directive` columns, and `w_<factor>`, `sentiment`, `agreement`, `confidence` |

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

`deriveScore` turns that context into `strength` = normalised weighted mean of
the factor scores, and `conviction` = strength magnitude × factor **agreement**
× agent `confidence` — so mixed signals score low conviction even when
net-positive (the "direction ≠ conviction" rule). It snapshots the exact
weights, sentiment, agreement, and confidence it used onto the row.

`strength` and `conviction` are the two standardised numbers the directive is
derived from — see the parameter table below for the thresholds each one gates.

**All four formulas are v1 placeholders**, marked as such in their own files. Every
constant in them is a tunable parameter, so calibrating needs no code change, and
replacing one outright is a one-file edit — nothing outside a formula's module reads it.

## Parameters

Thresholds and factor weights resolve through three rungs, most specific first:

```
cluster_param  →  global_param  →  built-in defaults
```

`janus cluster set-param` writes the first, `janus param set` the second. `janus param
list` shows the global layer and the resolved result; `janus cluster show` does the same
for a cluster. An asset with no cluster resolves against `global_param` and the defaults.

Defaults (`domain/params.ts` is the authority): `beta_factor 1.0`,
`screen_threshold 1.0`, `w_catalyst 0.25`, `w_sentiment 0.25`, `w_trend 0.3`,
`w_regime 0.15`, `w_secular 0.05`, `fear_premium 1.25`, `divergence_boost 0.5`,
`min_history_bars 200`, `max_units 3`.

Directive ladder thresholds are active: `strength_initiate 1.0`, `conv_initiate 6`,
`strength_add 1.0`, `conv_add 7`, `conv_hold 4`, `strength_exit 1.0`. Trend/MA structure is a
hard entry/scaling gate via `trend_gate_long 1.0`, `trend_gate_short -1.0`,
`require_golden_for_long 1`, `require_death_for_short 1`. Regime is context plus
an extreme-contrarian trigger: `regime_trigger_long_max 1.5`,
`regime_trigger_short_min -1.5`, `regime_force_exit_threshold 1.8`. The persistence
rule resists flip-flopping unless an actionable signal appears:
`actionable_catalyst_min 1.5`, `actionable_strength_delta 2.5`.

The macro read is session-wide, so it resolves against the global rung only; a cluster
read resolves against its own cluster first, like everything else.

### The directive ladder

`deriveScore` now turns `strength`, `conviction`, the open position, the trend/MA gate,
and the regime trigger into `INITIATE`/`ADD`/`HOLD`/`TRIM`/`EXIT`/`STAND_ASIDE`. Most runs
return `HOLD` — meaning thesis intact — unless an actionable new signal appears or the
score flips hard enough to force an exit. The ladder also returns an actionable sub-plan
(`plan`) with trend-gate status, persistence rule, and stop/trim hints; the operator
still executes every change manually via the `trade` commands.

| Parameter | Guards |
| --- | --- |
| `strength_initiate`, `conv_initiate` | Flat + trend gate pass → `INITIATE` |
| `strength_add`, `conv_add` | Holding + working + trend gate pass → `ADD` |
| `conv_hold` | The conviction floor; below it, `TRIM` or `HOLD` |
| `strength_exit` | How hard the score must argue against an open position to become `EXIT` |
| `max_units` | The ceiling on stacked adds |



### Parameter reference

All parameters resolve through `cluster_param → global_param → built-in default`.
Set a global with `janus param set <key> <value>` or a cluster override with
`janus cluster set-param <key> <param> <value>`.

| Parameter | Phase | Default | Description |
| --- | --- | --- | --- |
| `beta_factor` | screen | `1.0` | Multiplier applied to the raw screen score before the threshold check. |
| `screen_threshold` | screen | `1.0` | Minimum `screen_score` for an asset to be flagged for the scoring queue. |
| `w_catalyst` | score | `0.25` | Weight of the momentum/catalyst factor in `strength`. |
| `w_sentiment` | score | `0.25` | Weight of the contrarian positioning/crowding factor in `strength`. |
| `w_trend` | score | `0.30` | Weight of the trend/flow factor in `strength`. |
| `w_regime` | score | `0.15` | Weight of the session's `regime_smile` in `strength`. |
| `w_secular` | score | `0.05` | Weight of the longer-horizon thesis factor in `strength`. |
| `fear_premium` | score | `1.25` | Scales the bullish side of the contrarian sentiment fade; >1 makes panic bounces fade harder than greed tops. |
| `divergence_boost` | score | `0.5` | Widens a contrarian fade when a price/crowding divergence is present. |
| `min_history_bars` | asset | `200` | Minimum listed bars for an asset to be added to the roster; below this a 200-day MA is impossible. |
| `max_units` | directive | `3` | Ceiling on how many units can be stacked into one trade via `ADD`. |
| `strength_initiate` | directive | `1.0` | Minimum `\|strength\|` for a flat asset to receive `INITIATE`. |
| `conv_initiate` | directive | `6` | Minimum `conviction` for a flat asset to receive `INITIATE`. |
| `strength_add` | directive | `1.0` | Minimum `\|strength\|` for a working hold to receive `ADD`. |
| `conv_add` | directive | `7` | Minimum `conviction` for a working hold to receive `ADD`. |
| `conv_hold` | directive | `4` | Conviction floor for staying put; below it the ladder downgrades to `TRIM` or `HOLD`. |
| `strength_exit` | directive | `1.0` | Minimum `\|strength\|` against an open position to trigger `EXIT` instead of `TRIM`. |
| `trend_gate_long` | directive | `1.0` | Minimum `px_vs_sma50` percent for long `INITIATE`/`ADD` to pass the trend gate. |
| `trend_gate_short` | directive | `-1.0` | Maximum `px_vs_sma50` percent for short `INITIATE`/`ADD` to pass the trend gate. |
| `require_golden_for_long` | directive | `1` | When `1`, long entries are blocked if `cross_50_200` is `death`. |
| `require_death_for_short` | directive | `1` | When `1`, short entries are blocked if `cross_50_200` is `golden`. |
| `regime_trigger_long_max` | directive | `1.5` | Block new longs and force long exits when `regime_smile` reaches this positive extreme. |
| `regime_trigger_short_min` | directive | `-1.5` | Block new shorts and force short exits when `regime_smile` reaches this negative extreme. |
| `regime_force_exit_threshold` | directive | `1.8` | Force a full `EXIT` when `regime_smile` exceeds this against an open position. |
| `flip_flop_lookback_days` | directive | `5` | How many days back the persistence rule checks for a prior score. |
| `actionable_catalyst_min` | directive | `1.5` | Minimum `\|catalyst\|` that counts as an actionable new signal for the persistence rule. |
| `actionable_strength_delta` | directive | `2.5` | Minimum change in `\|strength\|` from the prior score that counts as actionable. |

Boolean parameters (`require_golden_for_long`, `require_death_for_short`) use
`1` for true and `0` for false.

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

Add a runner unit once the score plan calls `ADD` and the trend gate passes:

```
janus trade add-unit 1 --price 68000 --stop 66000 --risk 400 --notional 4000 --tag runner
```

Move the stop on the oldest unit to breakeven after the plan suggests it, leaving the
runner's stop wider:

```
janus trade set-stop 1 --stop 65000 --unit 1
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
