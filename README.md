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

## Requirements

- Node **>= 24** — `node:sqlite` is the only database layer and it is not available
  earlier. `.npmrc` pins the runtime (`use-node-version=24.18.1`, `engine-strict=true`),
  so **run everything through pnpm** (`pnpm build`, `pnpm test`,
  `pnpm exec node src/cli.ts …`). A bare `node` on your PATH may be older and will fail
  to load `node:sqlite`.
- pnpm.
- No runtime dependencies. TypeScript is a dev dependency only; `.ts` sources run
  directly under Node's type stripping.

```
pnpm install
pnpm build    # tsc → dist/
pnpm test     # node:test, no framework, no network
```

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `JANUS_DB` | `./janus.db` | SQLite file. Created by `janus init`. |
| `JANUS_LIGHTER_URL` | `https://mainnet.zklighter.elliot.ai` | Lighter API base. Points the two read-only endpoints at a stub for tests or replay. |

## Output contract

Every command writes one JSON object to stdout and nothing else.

```json
{"ok":true,"data":{...}}
{"ok":false,"error":{"code":"VALIDATION","message":"..."}}
```

Exit code is `0` on success and `1` on error. The `ok` flag and the exit code always
agree, so either one is sufficient to branch on.

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

`node:util.parseArgs` reads a leading `-` as the start of the next option, so a
space-separated negative would be rejected as ambiguous. Every signed value now rides a
`key=value` pair instead — `--metric score=-2`, `--factor crowding=-1.5` — and a pair is
one token beginning with a letter, so nothing is ambiguous and both spellings work:

```
janus macro record --metric score=-2 ...     # fine
janus macro record --metric=score=-2 ...     # also fine
```

`param set` and `cluster set-param` take their key and value as **positional arguments**,
so they are unaffected too — write `janus param set w_crowding -2` plainly.

## Sessions

A session is one calendar day, keyed `YYYY-MM-DD` and anchored to `America/New_York` so
the day boundary sits at the US close. There is no `session open` command: the first
*phase* command of the day creates the session. Read-only commands never do — they
report an empty result for a day that has not started.

`--date YYYY-MM-DD` addresses an **existing** session, for correcting or re-running a
phase. It never creates one, and never back-dates.

## The five phases

Run in order. Each stamps a completion timestamp on the session row, and each refuses to
run until its predecessors are stamped (`PHASE_ORDER`, overridable with `--force`).
`janus session status` reports where the pipeline stands.

1. **`macro`** — one macro read for the session: state and summary on the row, plus any
   number of `--metric key=value` pairs for what was observed. Completes immediately. If
   no clusters exist, it vacuously completes `cluster_read` too.
2. **`cluster record`** — one read per cluster, again as `--metric` pairs. Completes once
   every cluster has been read. It shares the `cluster` command with the roster verbs, so
   the session's reads list as `cluster reads` — `cluster list` stays the roster.
3. **`coverage`** — the only phase that touches the network. Fetches daily candles and a
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
| macro | `deriveMacroRead` (`domain/read.ts`) | `score` (−2…2), `confidence` (0…2) | `tilt`, `risk_budget` |
| cluster | `deriveClusterRead` (`domain/read.ts`) | `bias` (−2…2), `judgement` (text) | `tilt`, `aligned` |
| screen | `deriveScreen` (`domain/screen.ts`) | `score` (−2…2), `confidence` (0…2) | the `flagged` column, and `threshold` |
| score | `deriveScore` (`domain/score.ts`) | at least one `--factor`, each −2…2 | the `strength`, `conviction`, and `directive` columns, and `w_<factor>`, `macro_aligned`, `cluster_aligned` |

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

The v1 formulas report on that context rather than acting on it — `macro_aligned` and
`cluster_aligned` say whether the top-down reads back the decision up — but a replacement
has the full picture in hand.

`strength` and `conviction` are the two standardised numbers the directive is derived
from — see the parameter table below for the thresholds each one gates.

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

Defaults: `d_initiate 1.0`, `conv_initiate 6`, `d_add 1.0`, `conv_add 7`, `conv_hold 4`,
`d_exit 1.0`, `max_units 4`, `screen_flag_threshold 1.0`, `w_catalyst 1.0`, `w_trend 1.0`,
`w_secular 1.0`, `w_crowding -1.0`, `risk_budget_base 0.5`, `risk_budget_tilt 0.25`,
`cluster_bias_weight 1.0`, `cluster_macro_weight 0.5`.

The macro read is session-wide, so it resolves against the global rung only; a cluster
read resolves against its own cluster first, like everything else.

### The directive ladder — not yet written

`deriveScore` returns a `directive` alongside `strength` and `conviction`, but it is a
**stub: every score concludes `NONE`.** The ladder that turns a score and an open position
into INITIATE/ADD/HOLD/TRIM/EXIT is still to be designed, and it belongs in
`deriveScore` — which already receives the whole context it will need.

These parameters are reserved for it and are read by nothing today:

| Parameter | Intended to guard |
| --- | --- |
| `d_initiate`, `conv_initiate` | Flat → `INITIATE`; otherwise `STAND_ASIDE` |
| `d_add`, `conv_add` | Holding something that is working → `ADD` another unit |
| `conv_hold` | The conviction floor for staying put; below it, `TRIM` |
| `d_exit` | How hard the score must argue *against* an open position to make it a full `EXIT` rather than a `TRIM` |
| `max_units` | The ceiling on stacked adds |

The `d_*` names predate `strength`; they mean the same number.

## Commands

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

janus macro record --state STATE --summary - --metric k=v [--metric k=v ...]
janus macro reads [--date D]

janus cluster record <cluster> --metric k=v [--metric k=v ...]
janus cluster reads [--date D]                      the session's cluster reads

janus coverage run [--asset SYM[,SYM...]] [--force]
janus coverage list [--date D] [--asset SYM[,SYM...]]

janus screen record <symbol> --metric k=v [--metric k=v ...] [--rationale -]
janus screen list [--flagged] [--date D]

janus score queue [--date D]
janus score record <symbol> --factor key=value ... [--rationale -]
janus score list [--date D]

janus trade open <symbol> --direction long|short --price P --stop S --risk R
                 --notional N [--thesis -] [--date D]
janus trade add-unit <trade_id> --price P --stop S --risk R --notional N [--date D]
janus trade set-stop <trade_id> --stop S [--unit SEQ]
janus trade exit <trade_id> --price P [--unit SEQ] [--date D]
janus trade list [--open] [--closed] [--asset SYM[,SYM...]]
janus trade show <trade_id>
```

`--class` is one of `crypto`, `equity`, `etf`, `commodity`, `fx`, `index`.
`--state` is one of `RISK_ON`, `NEUTRAL`, `RISK_OFF`.
`--direction` is required — there is no default, because a short logged as a long
inverts every directive derived from it.

On `trade`, `--date` is the real entry or exit date of a unit, not a session address.
Everywhere else it addresses a session.
