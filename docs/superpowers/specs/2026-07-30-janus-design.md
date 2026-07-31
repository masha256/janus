# Janus — Design

Date: 2026-07-30
Status: approved for planning

## Purpose

Janus is a TypeScript CLI that stores and derives state for a discretionary trading
system operated on Lighter (zkLighter perpetuals). It is invoked by an AI agent during
each phase of a daily workflow, and by the human operator to log trades.

Janus never executes trades. It stores data, fetches deterministic market data, computes
deterministic indicators, and derives a directive from agent-supplied judgement.

## Division of labour

| Concern | Owner |
|---|---|
| Price, OHLCV, open interest | Janus, via Lighter REST API |
| Moving averages, crosses, ATR | Janus, computed from bars |
| Market sentiment, cluster judgement, screen score, D, Conv | Agent, supplied as CLI args |
| Directive (INITIATE/ADD/HOLD/TRIM/EXIT/STAND_ASIDE) | Janus, derived |
| Flag decision in screening | Janus, by threshold against agent score |
| Position size, stop placement | Operator for now; see Deferred |

The dividing line: anything reproducible from data is Janus's job; anything requiring
reading news, socials, filings or on-chain context is the agent's, and Janus records it.

## Runtime

**Node 24 LTS.** Required for `node:sqlite`. Also provides native TypeScript
type-stripping, so `src/cli.ts` runs directly in development with no build step, and
`node --run` for scripts.

**Zero runtime dependencies.** `node:sqlite`, `node:util.parseArgs`, native `fetch`,
`node:test`. Janus is invoked many times per agent session, so cold start matters and
an install that cannot break matters more.

Build for distribution with `tsc` (TypeScript 7.x, already present) to `dist/`.

## Data source: Lighter

Base URL: `https://mainnet.zklighter.elliot.ai`

| Endpoint | Use |
|---|---|
| `GET /api/v1/orderBooks` | Market catalog: symbol, `market_id`, status, decimals, `created_at` |
| `GET /api/v1/orderBookDetails?market_id=N` | Snapshot: `mark_price`, `index_price`, `last_trade_price`, daily high/low/change, `open_interest`, margin fractions |
| `GET /api/v1/candles?market_id=N&resolution=1d&start_timestamp=MS&end_timestamp=MS` | Daily bars: `{t,o,h,l,c,v,V,i}` — `i` is open interest |

Verified 2026-07-30: 228 markets, 210 active, all `market_type: perp` apart from a
handful of spot pairs. `/api/v1/candles` requires `start_timestamp` and
`end_timestamp` in **milliseconds**; `count_back` alone returns HTTP 400.

Markets span crypto, US and international equities, ETFs, commodities, FX, indices and
pre-IPO names. Lighter does not classify them, so Janus assigns the class itself.

Markets are listed on varying dates. An asset listed 90 days ago cannot have a valid
SMA200. Janus records `bars_available` per coverage row and stores `NULL` for any
indicator with insufficient history rather than computing a wrong one.

## Asset roster

The roster is a **curated subset** of Lighter markets, not the full universe.

- `janus market sync` refreshes a local cache of the Lighter catalog.
- `janus market list` browses that catalog — this is discovery, not the roster.
- `janus asset add SYMBOL` promotes a market into the roster.

An asset carries its own `active` flag, independent of Lighter's market `status`.
**Every asset-level phase (coverage, screening, scoring) operates only on assets where
`asset.active = 1 AND market.status = 'active'`.** Deactivating an asset removes it from
the pipeline while preserving its history. `janus market sync` is the only command
outside the session pipeline that uses the network.

## Clusters

An asset belongs to at most one cluster — modelled as a nullable FK on `asset`, not a
join table.

A cluster owns `cluster_param` rows: named numeric thresholds. Parameter resolution is
**cluster-first, global-fallback** — `cluster_param` → `global_param` → hardcoded
default. This is the entire mechanism by which cluster parameters affect screening and
scoring. There is no formula DSL and no expression evaluator; named thresholds are
sufficient and stay debuggable.

## Sessions and phase order

A `session` is keyed by `trade_date` (`YYYY-MM-DD`), anchored to the previous US market
close. Each phase stamps its completion timestamp on the session row.

```
regime        → 1 row per session
cluster read  → 1 row per cluster
coverage      → roster assets where active = 1     (only pipeline phase using the network)
screening     → assets with coverage this session
scoring       → assets flagged by screening this session
```

Each phase narrows the set produced by the previous one. Running a phase when an earlier
one is incomplete fails with `{code: "PHASE_ORDER"}` naming the missing phase, and is
overridable with `--force`.

Re-running a phase overwrites its slice for that session. An agent that fumbles a call
simply calls again.

## Agent contract

Every command writes exactly one JSON object to stdout:

```json
{"ok": true, "data": {...}}
{"ok": false, "error": {"code": "PHASE_ORDER", "message": "coverage not complete for 2026-07-30"}}
```

Exit code 0 on success, 1 on error. Nothing else is written to stdout; diagnostics go to
stderr.

Inputs are flags. Free-text judgement fields (`--summary`, `--judgement`, `--rationale`,
`--thesis`, `--notes`) additionally accept `-` to read the value from stdin, so prose
does not have to survive shell quoting.

Error codes: `NOT_FOUND`, `ALREADY_EXISTS`, `VALIDATION`, `PHASE_ORDER`,
`SESSION_MISSING`, `NO_COVERAGE`, `NOT_FLAGGED`, `POSITION_CONFLICT`, `UPSTREAM`
(Lighter API failure), `INSUFFICIENT_HISTORY`.

## Module layout

```
src/
  cli.ts              entry point, argv routing
  cli/                one file per noun: market, cluster, asset, session,
                      regime, cluster-read, coverage, screen, score, trade
  output.ts           JSON envelope, exit codes
  lighter/
    client.ts         the only module that touches the network
    types.ts
  indicators/
    ma.ts             sma, ema
    atr.ts
    cross.ts          cross detection and age in bars
  domain/
    params.ts         cluster-first / global-fallback resolution
    directive.ts      (d, conv, positionState, params) => Directive   [pure]
    sizing.ts         position sizing                                 [deferred]
    trade-math.ts     avg entry, aggregate risk, R-multiple           [pure]
    session.ts        phase order state machine
  db/
    connect.ts
    migrate.ts        ordered array of DDL statements
    repo/             one repository per table group
```

`indicators/` and `domain/` are pure functions over plain data — no DB handle, no
network. This is what makes the directive and indicator logic testable in isolation, and
what makes the deferred work below cheap to land later.

Database location: `$JANUS_DB`, defaulting to `./janus.db`.

## Schema

```sql
CREATE TABLE cluster (
  id          INTEGER PRIMARY KEY,
  key         TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  notes       TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE cluster_param (
  cluster_id  INTEGER NOT NULL REFERENCES cluster(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  value       REAL NOT NULL,
  PRIMARY KEY (cluster_id, key)
);

CREATE TABLE global_param (key TEXT PRIMARY KEY, value REAL NOT NULL);

CREATE TABLE market (                    -- cached Lighter catalog, not the roster
  market_id       INTEGER PRIMARY KEY,
  symbol          TEXT NOT NULL UNIQUE,
  market_type     TEXT NOT NULL,
  status          TEXT NOT NULL,
  price_decimals  INTEGER NOT NULL,
  size_decimals   INTEGER NOT NULL,
  listed_at       TEXT NOT NULL,
  synced_at       TEXT NOT NULL
);

CREATE TABLE asset (
  id          INTEGER PRIMARY KEY,
  market_id   INTEGER NOT NULL UNIQUE REFERENCES market(market_id),
  symbol      TEXT NOT NULL UNIQUE,
  class       TEXT NOT NULL
              CHECK (class IN ('crypto','equity','etf','commodity','fx','index')),
  cluster_id  INTEGER REFERENCES cluster(id) ON DELETE SET NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  notes       TEXT,
  added_at    TEXT NOT NULL
);

CREATE TABLE session (
  trade_date       TEXT PRIMARY KEY,
  opened_at        TEXT NOT NULL,
  regime_at        TEXT,
  cluster_read_at  TEXT,
  coverage_at      TEXT,
  screen_at        TEXT,
  score_at         TEXT
);

CREATE TABLE regime_read (
  trade_date   TEXT PRIMARY KEY REFERENCES session(trade_date) ON DELETE CASCADE,
  state        TEXT NOT NULL CHECK (state IN ('RISK_ON','NEUTRAL','RISK_OFF')),
  score        REAL NOT NULL CHECK (score BETWEEN -2.0 AND 2.0),
  summary      TEXT NOT NULL,
  recorded_at  TEXT NOT NULL
);

CREATE TABLE regime_metric (
  trade_date  TEXT NOT NULL REFERENCES session(trade_date) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  value_num   REAL,
  value_text  TEXT,
  PRIMARY KEY (trade_date, key)
);

CREATE TABLE cluster_read (
  trade_date   TEXT NOT NULL REFERENCES session(trade_date) ON DELETE CASCADE,
  cluster_id   INTEGER NOT NULL REFERENCES cluster(id) ON DELETE CASCADE,
  bias         REAL NOT NULL CHECK (bias BETWEEN -2.0 AND 2.0),
  judgement    TEXT NOT NULL,
  recorded_at  TEXT NOT NULL,
  PRIMARY KEY (trade_date, cluster_id)
);

CREATE TABLE coverage (
  trade_date       TEXT NOT NULL REFERENCES session(trade_date) ON DELETE CASCADE,
  asset_id         INTEGER NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  open             REAL, high REAL, low REAL, close REAL NOT NULL, volume REAL,
  mark_price       REAL,
  index_price      REAL,
  open_interest    REAL,
  daily_change_pct REAL,
  sma20 REAL, sma50 REAL, sma200 REAL,
  ema12 REAL, ema26 REAL,
  atr14 REAL,
  px_vs_sma20 REAL, px_vs_sma50 REAL, px_vs_sma200 REAL,   -- signed pct distance
  cross_50_200     TEXT CHECK (cross_50_200 IN ('golden','death')),
  cross_50_200_age INTEGER,                                 -- bars since cross
  cross_px_50      TEXT CHECK (cross_px_50 IN ('above','below')),
  cross_px_50_age  INTEGER,
  bars_available   INTEGER NOT NULL,
  fetched_at       TEXT NOT NULL,
  PRIMARY KEY (trade_date, asset_id)
);

CREATE TABLE screen (
  trade_date   TEXT NOT NULL REFERENCES session(trade_date) ON DELETE CASCADE,
  asset_id     INTEGER NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  score        REAL NOT NULL,
  threshold    REAL NOT NULL,        -- resolved value at time of decision
  flagged      INTEGER NOT NULL,
  rationale    TEXT,
  recorded_at  TEXT NOT NULL,
  PRIMARY KEY (trade_date, asset_id)
);

CREATE TABLE score (
  trade_date      TEXT NOT NULL REFERENCES session(trade_date) ON DELETE CASCADE,
  asset_id        INTEGER NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  d               REAL NOT NULL CHECK (d BETWEEN -2.0 AND 2.0),
  conv            REAL NOT NULL CHECK (conv BETWEEN 1 AND 10),
  directive       TEXT NOT NULL,
  position_state  TEXT NOT NULL,     -- 'flat' | 'long:N' | 'short:N' where N = open units
  params_json     TEXT NOT NULL,     -- resolved thresholds, snapshotted
  rationale       TEXT,
  recorded_at     TEXT NOT NULL,
  PRIMARY KEY (trade_date, asset_id)
);

CREATE TABLE trade (
  id                INTEGER PRIMARY KEY,
  asset_id          INTEGER NOT NULL REFERENCES asset(id),
  direction         TEXT NOT NULL CHECK (direction IN ('long','short')),
  status            TEXT NOT NULL CHECK (status IN ('open','closed')),
  opened_on         TEXT NOT NULL,
  initial_price     REAL NOT NULL,
  initial_stop      REAL NOT NULL,
  initial_risk      REAL NOT NULL,
  thesis            TEXT,
  origin_trade_date TEXT,            -- score row that motivated the entry
  closed_on         TEXT,
  created_at        TEXT NOT NULL
);

CREATE UNIQUE INDEX trade_one_open_per_asset
  ON trade(asset_id) WHERE status = 'open';

CREATE TABLE trade_unit (
  id           INTEGER PRIMARY KEY,
  trade_id     INTEGER NOT NULL REFERENCES trade(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  entry_on     TEXT NOT NULL,
  entry_price  REAL NOT NULL,
  notional     REAL NOT NULL,
  risk         REAL NOT NULL,
  stop         REAL NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('open','closed')),
  exit_on      TEXT,
  exit_price   REAL,
  notes        TEXT,
  UNIQUE (trade_id, seq)
);
```

The partial unique index enforces at most one open trade per asset, which is what makes
position-aware directives well defined.

`notional`, `risk` and `initial_risk` are quote-currency (USD) amounts. `stop`,
`entry_price` and `initial_price` are price levels in the market's own units.

Nothing is denormalized. Average entry, total notional, aggregate open risk
(Σ size × distance-to-stop) and R-multiple are computed on read, so correcting a unit
never leaves a stale total behind.

## Directive derivation — v1

Inputs: `d` ∈ [-2.0, +2.0] (sign is the direction), `conv` ∈ [1, 10], the asset's current
position state, and cluster-resolved thresholds.

| Position state | Condition | Directive |
|---|---|---|
| flat | `abs(d) >= d_initiate` and `conv >= conv_initiate` | `INITIATE` |
| flat | otherwise | `STAND_ASIDE` |
| open, `d` agrees with direction | `conv >= conv_add` and `abs(d) >= d_add` and `units < max_units` | `ADD` |
| open, `d` agrees | `conv >= conv_hold` | `HOLD` |
| open, `d` agrees | otherwise | `TRIM` |
| open, `d` opposes direction | `abs(d) >= d_exit` | `EXIT` |
| open, `d` opposes | otherwise | `TRIM` |

Defaults, all overridable per cluster:

| Param | Default |
|---|---|
| `d_initiate` | 1.0 |
| `conv_initiate` | 6 |
| `d_add` | 1.0 |
| `conv_add` | 7 |
| `conv_hold` | 4 |
| `d_exit` | 1.0 |
| `max_units` | 4 |
| `screen_flag_threshold` | 1.0 |

This is a deliberate placeholder. It lives entirely in `domain/directive.ts` as one pure
function with a table-driven test suite, so replacing it later is a single-file change
with no ripple. The resolved parameter set is snapshotted into `score.params_json` at
decision time, so a directive recorded before a retune still explains itself.

## CLI surface

```
janus init

janus market sync
janus market list [--search TEXT] [--status active]

janus cluster add <key> --name NAME [--notes -]
janus cluster list
janus cluster show <key>
janus cluster set-param <key> <param> <value>
janus cluster rm <key>

janus asset add <symbol> --class CLASS [--cluster KEY] [--notes -]
janus asset list [--active] [--inactive] [--cluster KEY] [--class CLASS]
janus asset show <symbol>
janus asset set <symbol> [--cluster KEY] [--class CLASS] [--notes -]
janus asset activate <symbol>
janus asset deactivate <symbol>
janus asset rm <symbol>

janus session open [--date YYYY-MM-DD]
janus session status [--date YYYY-MM-DD]

janus regime record --state STATE --score N --summary - [--metric key=value ...]
janus cluster-read record <cluster> --bias N --judgement -
janus coverage run [--asset SYMBOL]
janus coverage list [--date D]
janus screen record <symbol> --score N [--rationale -]
janus screen list [--flagged] [--date D]
janus score record <symbol> --d N --conv N [--rationale -]
janus score list [--date D]

janus trade open <symbol> --direction DIR --price P --stop S --risk R --notional N
                          [--date D] [--thesis -]
janus trade add-unit <trade_id> --price P --stop S --risk R --notional N [--date D]
janus trade set-stop <trade_id> --stop S [--unit SEQ]
janus trade exit <trade_id> --price P [--unit SEQ] [--date D]
janus trade list [--open] [--closed] [--asset SYMBOL]
janus trade show <trade_id>
```

All phase-recording commands default to the current open session and accept `--date` to
target a specific one.

## Testing

`node:test`, no framework.

- **Pure unit tests** for `indicators/` and `domain/` — fixture bar series in, expected
  values out. The directive table is tested case by case, one test per row plus boundary
  cases at each threshold.
- **Repository and phase-order tests** against an in-memory SQLite database
  (`:memory:`), fully isolated per test.
- **Lighter client tests** against recorded JSON fixtures captured from the live API.
  No network in the test suite.
- **CLI smoke tests** that invoke the built entry point and assert on the parsed JSON
  envelope and exit code — this is the agent's actual contract, so it is tested as the
  agent experiences it.

## Error handling

Lighter API failures surface as `UPSTREAM` with the HTTP status and endpoint, and never
leave a partial coverage slice — the coverage phase writes all rows in a single
transaction, or none.

Validation happens at the CLI boundary: ranges on `d` and `conv`, enum membership,
symbol existence in the roster, `active` status. Errors name the offending flag.

Insufficient bar history is not an error. It produces `NULL` indicators plus a
`bars_available` count, and the coverage row is still written.

## Deferred

Explicitly out of scope for the first implementation, and designed around rather than
built:

- **Advanced D/Conv generation.** The formula the agent uses to produce `d` and `conv`
  is being worked out separately. Janus accepts them as inputs.
- **Advanced directive mapping.** The v1 table above is a placeholder confined to
  `domain/directive.ts`.
- **Risk and position sizing.** Deciding notional, stop placement, and add/trim
  timing is a future strategy module. For v1, the operator supplies `--notional`,
  `--stop` and `--risk` when logging trades and units. `domain/sizing.ts` is the
  intended home; it is not built speculatively now.

## Open items

- `.gitignore` needs `node_modules`, `dist`, `janus.db`.
- Node 24 must be installed before implementation begins (currently 20.18).
