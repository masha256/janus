# janus

A state manager for a discretionary trading system on [Lighter](https://lighter.xyz)
perpetuals. It records what was decided and why: regime reads, cluster reads, market
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

## Negative numbers: use `--flag=-1.5`

`node:util.parseArgs` reads a leading `-` as the start of the next option, so a
space-separated negative is rejected as ambiguous:

```
janus regime record --score -2 ...     # ERROR — parseArgs cannot parse this
janus regime record --score=-2 ...     # correct
```

**Always use the `=` form for a negative value.** It applies to every signed flag:
`--score`, `--bias`, `--confidence`, `--factor key=-1.5`, and `param set` /
`cluster set-param` values. Positive values work either way. The failure is loud —
`VALIDATION`, with a message naming the fix — but the whole bearish half of the scale is
unreachable without it.

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

1. **`regime`** — one macro read for the session: state, score, confidence, summary, and
   any number of `--metric key=value` pairs. Completes immediately. If no clusters exist,
   it vacuously completes `cluster_read` too.
2. **`cluster-read`** — one bias and judgement per cluster. Completes once every cluster
   has been read.
3. **`coverage`** — the only phase that touches the network. Fetches daily candles and a
   snapshot for every eligible asset (active roster entries on live markets, plus
   anything holding an open trade) and derives moving averages, ATR, and cross state. A
   full run (no `--asset`) completes the phase; assets with too little history are
   reported in `skipped` and do not block it. An `--asset`-scoped run never completes the
   phase.
4. **`screen`** — a score and confidence per covered asset. An asset flags when its score
   reaches `screen_flag_threshold`; the threshold in force is snapshotted onto the row, so
   retuning later never rewrites history. Completes once every covered asset is screened.
5. **`score`** — a weighted decision for everything in the queue: assets flagged this
   session, unioned with anything holding an open trade. `janus score queue` returns that
   set with its coverage and screen attached. `score record` derives `d`, `conv`, and a
   directive from the `--factor` values and the resolved parameters, and snapshots both
   the parameters and the position state. Completes once the queue is fully scored.

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
`w_secular 1.0`, `w_crowding -1.0`.

## Commands

`--notes`, `--summary`, `--judgement`, `--rationale`, and `--thesis` accept `-` to read
the value from stdin. `--asset` takes a comma-separated list wherever it appears, and an
unknown symbol fails the whole call rather than silently returning a subset.

```
janus init                                          create/migrate the database

janus market sync                                   refresh the Lighter catalog
janus market list [--search TEXT] [--status STATUS]

janus cluster add <key> --name NAME [--notes -]
janus cluster list
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

janus regime record --state STATE --score N --confidence N --summary - [--metric k=v ...]
janus regime show [--date D]

janus cluster-read record <cluster> --bias N --judgement -
janus cluster-read list [--date D]

janus coverage run [--asset SYM[,SYM...]] [--force]
janus coverage list [--date D] [--asset SYM[,SYM...]]

janus screen record <symbol> --score N --confidence N [--rationale -]
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
