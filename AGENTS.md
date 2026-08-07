# Agent guide for janus

This file is for the AI agent that runs the janus daily pipeline. It assumes you
have read `README.md` once; the goal here is to tell you **what to do each day**
and how to use the CLI to do it.

janus is a state manager, not an executor. You never place orders. You record
what was observed, what was decided, and what the human operator eventually did
about it. Every command prints one JSON envelope to stdout, so parse that.

## One envelope per command

```json
{"ok":true,"data":{...}}
{"ok":false,"error":{"code":"VALIDATION","message":"..."}}
```

Use the envelope to decide the next action. If `ok` is `false`, stop and report;
do not silently continue. Exit code matches `ok`.

## Your daily job

Run the five phases in order, then surface any `INITIATE`, `ADD`, `TRIM`, or
`EXIT` plans to the operator.

```
1. macro          (session-wide read)
2. cluster record  (one read per cluster)
3. coverage run    (fetch market data for the roster + open trades)
4. screen record   (one read per covered asset)
5. score record    (one decision per queued asset)
```

The phases run in that order, but they are grouped into **two jobs**, split at the
coverage boundary:

| Job | Phases | Prompt |
| --- | --- | --- |
| Regime | 1–2 | `prompts/REGIME.md` |
| Screen & score | 3–5 | `prompts/SCREEN.md`, `prompts/SCORE.md` |

Coverage belongs to the second job and runs as its first step, so screening always
works from prices fetched moments earlier rather than from whatever the clock gap
between two jobs happened to be. The session anchor and news cutoff is **10:00 AM
Eastern**; both jobs run after it.

After scoring, call `janus score list` to see the full queue, then call
`janus trade list --open` to see current positions. Compare the two and produce a
short operator brief: new entries, adds, trims, exits, and anything that needs a
stop adjusted.

## Creating the session

The first phase command of the day creates the session. You do not need a
separate "open session" step. Use `--date YYYY-MM-DD` only when you are
re-running or correcting a previous day; it will not create a new session.

If you need to re-run a phase, use `--force` or address the earlier session with
`--date`. Do not invent past dates.

`janus session open --date YYYY-MM-DD` exists only for backfill/testing; do not
use it during the daily pipeline unless the operator explicitly asks for a
past-date session.

## Phase 1 — macro record

Record the top-down read for the day. Required metric: `regime` in −2..2.
Everything else is optional observation.

```
janus macro record --summary "risk-off after PPI" --metric regime=-1 --metric vix_spot=18.5 --metric yields_10y=4.25
```

## Phase 2 — cluster record

Run one read per cluster. Required metric: `regime` in −2..2. If no clusters
exist, this phase completes automatically when `macro` completes.

```
janus cluster record crypto --metric regime=1 --metric funding_8h_avg=0.0012
janus cluster record memes --metric regime=-2 --metric funding_8h_avg=-0.008
```

## Phase 3 — coverage run

This is the only network call. Fetch coverage for the full roster plus any asset
with an open trade.

```
janus coverage run
```

If you only need to backfill one asset, use `--asset SYM`. A scoped run does not
complete the phase, so normally you want the full run.

Assets with too little history are reported in `skipped` and do not block the
phase.

## Phase 4 — screen record

One read per covered asset. Required metrics: `score` (1..10) and `confidence`
(0..1). Optional metrics may include `binary_event`, `capitulation`, `divergence`,
`catalyst`, `crowding`, and anything else the scoring formula needs.

```
janus screen record BTC --metric score=8 --metric confidence=0.7 --metric catalyst=2 --metric crowding=75
```

Screening snapshots the threshold in force, so later parameter retunes cannot
rewrite history.

## Phase 5 — score record

The queue is: every asset flagged today, plus every asset with an open trade.
First, inspect it:

```
janus score queue
```

Then record a score for each queued asset. Required input: at least one
`--factor key=value` pair, each in −2..2. `crowding` uses 1..100. `confidence` is
a quality score on 0..1 and is optional — missing means zero.

```
janus score record BTC --factor catalyst=2 --factor trend=1.5 --factor sentiment=-0.5 --factor regime=-1 --rationale "higher-highs, funding still neutral"
```

The command derives `direction`, `conviction`, `directive`, and a full `ScorePlan`
from the factors, reads, coverage, and resolved parameters. Store the plan; you
will need it for the operator brief.

## After scoring — produce the operator brief

1. List scores:

```
janus score list
```

2. List open trades:

```
janus trade list --open
```

3. For each `INITIATE` or `ADD`, read the score plan to get the suggested size,
   stop, and risk:

```
janus score show BTC
```

4. For each open trade, check whether a stop/trim/exit sub-plan was emitted:
   compare the score's `directive`, `stop_plan`, and `trim_plan` against the
   trade's current units using `janus trade show <trade_id>`.

5. Emit a concise brief in the same channel you were asked to run. Include:
   - Symbol, current directive, size tier, and conviction.
   - For `INITIATE`/`ADD`: suggested notional, entry stop, and projected heat.
   - For `TRIM`/`EXIT`: which unit(s) and why (partial target, time stop, decay,
     regime override).
   - For `HOLD`: any stop-plan change the operator should make manually.

Do not make up prices. The score plan gives you sizing and stop levels relative
to the last coverage mark. If you need a live entry price, ask the operator or use
the coverage snapshot price as a reference, clearly labeled.

## Operator execution vs. agent execution

The operator is the only one who may `trade open`, `trade add-unit`, `trade
set-stop`, or `trade exit`. Your role is to prepare the recommendation and the
state, not to call those commands.

If the operator confirms an `INITIATE` or `ADD`, the recommended CLI form is:

```
janus trade open BTC --direction long --price 65000 --size auto --stop auto --tag core
janus trade add-unit 1 --price 68000 --size auto --stop auto --tag runner
```

`--size auto` and `--stop auto` read the score plan's sizing plan and ATR-derived
stop. If the operator prefers manual levels, those flags are omitted.

If the operator asks you to call the trade command yourself in a test or dry-run
context, only do so inside the test database (`JANUS_DB`); never against the
production database unless explicitly authorized.

## Parameters you may tune

All parameters resolve `cluster_param → global_param → built-in default`. As the
agent, you do not normally set parameters unless asked. If you do, prefer global
params for session-wide calibrations and cluster params for per-cluster calibrations.

```
janus param set w_sentiment 0.30
janus cluster set-param crypto screen_threshold 0.9
```

The canonical defaults live in `src/domain/params.ts`. README sections
**Scoring gates**, **Position sizing**, and **Directive plans** describe what each
parameter does.

## Error handling

Stop on any non-`ok` envelope and report the `code` and `message`. Common codes:

| Code | What to do |
| --- | --- |
| `PHASE_ORDER` | The previous phase is not stamped. Run it, or use `--force` if the operator says to skip. |
| `NO_COVERAGE` | Asset was scored/screened with no coverage row for the session. Run `coverage run` first. |
| `NOT_FLAGGED` | Asset is not in the scoring queue. Check `janus score queue`. |
| `VALIDATION` | Bad flag, missing metric, or wrong range. Read the message, fix the call. |
| `UPSTREAM` | Lighter API problem. Retry once, then report. |
| `INTERNAL` | Treat as a bug. Report and stop. |

## What not to do

- Do not place, modify, or cancel any exchange order.
- Do not invent prices for trade records.
- Do not back-date sessions, reads, or trades.
- Do not mutate `dist/`; the operator runs `npm run build` when releasing.
- Do not assume the operator executed a recommendation until you see the trade
  row in `janus trade list --open`.
