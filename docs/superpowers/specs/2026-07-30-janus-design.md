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
| Market sentiment, cluster judgement, screen score, scoring factors | Agent, supplied as CLI args |
| D and Conv | Janus, derived from agent factors and cluster weights |
| Directive (INITIATE/ADD/HOLD/TRIM/EXIT/STAND_ASIDE) | Janus, derived from D and Conv |
| Flag decision in screening | Janus, by threshold against agent score |
| Position size, stop placement | Operator for now; see Deferred |

The dividing line: anything reproducible from data is Janus's job; anything requiring
reading news, socials, filings or on-chain context is the agent's, and Janus records it.

## Runtime

**Node 24 LTS.** Required for `node:sqlite`. Also provides native TypeScript
type-stripping, so `src/cli.ts` runs directly in development with no build step, and
`node --run` for scripts.

Verified 2026-07-31 on v24.18.1: `node:sqlite` opens, bundles SQLite 3.53.1, and enforces
partial unique indexes; native type-stripping runs `.ts` directly. The alternative was
rejected on evidence — better-sqlite3 v13 requires Node ≥22 and segfaults on 20.x, and
v12 ships no Node-20 prebuild, so it falls back to a node-gyp source build.

Pin the version with `.nvmrc` (`24.18.1`) and `"engines": {"node": ">=24"}` in
`package.json`, so an older runtime fails with a clear message instead of a segfault.

**Zero runtime dependencies.** `node:sqlite`, `node:util.parseArgs`, native `fetch`,
`node:test`. Janus is invoked many times per agent session, so cold start matters and
an install that cannot break matters more.

Build for distribution with `tsc` (TypeScript 7.x, already present) to `dist/`.

## Data source: Lighter

Base URL: `https://mainnet.zklighter.elliot.ai`, overridable via `$JANUS_LIGHTER_URL` — the
same pattern as `$JANUS_DB` below — so tests can point the client at a local stub server
instead of the live API.

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

A `session` is keyed by `session_date` (`YYYY-MM-DD`) — the **real calendar date the
session is run on**. Each phase stamps its completion timestamp on the session row.

Date anchoring is the agent's concern, not janus's. The agent performs its regime read
against the previous US market close, but that anchor is an analytical frame, not a
stored value: a read the agent performs today using yesterday's close is recorded under
today's date. Janus never back-dates a session to match the anchor.

**"Today" resolves in `America/New_York`, not system local time.** This puts the day
boundary where the close anchor already is, so a session worked past local midnight from
another timezone stays one session instead of splitting across two rows. Implemented as
`Intl.DateTimeFormat("en-CA", {timeZone: "America/New_York"})`, which emits `YYYY-MM-DD`
directly — no dependency, no hand-rolled offset arithmetic, DST handled.

**There is no `session open` command.** The first phase command of the day creates the
session implicitly, in the same transaction that writes its own data. A separate open
step would be pure bookkeeping — its only outputs are the date, which comes from the
clock, and `opened_at`, which duplicates the first phase's `recorded_at` — and
forgetting it would fail an otherwise valid call for no diagnostic benefit.

`janus session status` reports where the pipeline stands: which phases are complete,
what runs next, and how many assets are eligible for it. That is the question an agent
resuming mid-pipeline actually needs answered.

`--date` addresses an already-existing session, for correcting or re-running a phase. It
never creates one, and never records a session as though it happened on another day.

```
regime        → 1 row per session
cluster read  → 1 row per cluster
coverage      → eligible assets                    (only pipeline phase using the network)
screening     → assets with coverage this session
scoring       → assets flagged this session, UNION assets with an open trade
```

**Coverage eligibility** is `asset.active = 1 AND market.status = 'active'`, union any
asset carrying an open trade. A position you still hold must not go dark because the
asset was deactivated or delisted while you were in it.

**Scoring is not run on every asset.** The scoring set is the union of assets the screen
flagged this session and assets with an open trade — an open position needs a directive
every day regardless of whether it screened, since `HOLD`, `TRIM` and `EXIT` are only
reachable from a position. `janus score queue` returns exactly that set, with each
asset's reason (`flagged`, `open_trade`, or both) and its coverage row, so the scoring
agent can load its working set in one call.

Recording a score for an asset outside the queue fails with `NOT_FLAGGED`.

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

`SESSION_MISSING` is raised only when an explicit `--date` names a session that does not
exist. Without `--date`, the session is created on demand and the code cannot occur.

**Confidence is a ± margin of error, on a 0.0..2.0 magnitude scale** — it is never
negative. `regime record --score 1.5 --confidence 0.5` asserts a reading of 1.5 that the
agent would defend anywhere in 1.0..2.0. A confidence of 0 is a point estimate; 2.0 on a
-2..+2 score is an admission that the reading carries no information. The same applies
to `screen record`.

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
    score.ts          (factors, weights) => {d, conv}                 [pure]
    directive.ts      (d, conv, positionState, params) => Directive   [pure]
    sizing.ts         position sizing                                 [deferred]
    trade-math.ts     avg entry, aggregate risk, R-multiple           [pure]
    session.ts        phase order state machine, NY-anchored date resolution
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
  session_date     TEXT PRIMARY KEY,
  opened_at        TEXT NOT NULL,
  regime_at        TEXT,
  cluster_read_at  TEXT,
  coverage_at      TEXT,
  screen_at        TEXT,
  score_at         TEXT
);

CREATE TABLE regime_read (
  session_date  TEXT PRIMARY KEY REFERENCES session(session_date) ON DELETE CASCADE,
  state         TEXT NOT NULL CHECK (state IN ('RISK_ON','NEUTRAL','RISK_OFF')),
  score         REAL NOT NULL CHECK (score BETWEEN -2.0 AND 2.0),
  confidence    REAL NOT NULL CHECK (confidence BETWEEN 0.0 AND 2.0),
  summary       TEXT NOT NULL,
  recorded_at   TEXT NOT NULL
);

CREATE TABLE regime_metric (
  session_date  TEXT NOT NULL REFERENCES session(session_date) ON DELETE CASCADE,
  key           TEXT NOT NULL,
  value_num     REAL,
  value_text    TEXT,
  PRIMARY KEY (session_date, key)
);

CREATE TABLE cluster_read (
  session_date  TEXT NOT NULL REFERENCES session(session_date) ON DELETE CASCADE,
  cluster_id    INTEGER NOT NULL REFERENCES cluster(id) ON DELETE CASCADE,
  bias          REAL NOT NULL CHECK (bias BETWEEN -2.0 AND 2.0),
  judgement     TEXT NOT NULL,
  recorded_at   TEXT NOT NULL,
  PRIMARY KEY (session_date, cluster_id)
);

CREATE TABLE coverage (
  session_date     TEXT NOT NULL REFERENCES session(session_date) ON DELETE CASCADE,
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
  PRIMARY KEY (session_date, asset_id)
);

CREATE TABLE screen (
  session_date  TEXT NOT NULL REFERENCES session(session_date) ON DELETE CASCADE,
  asset_id      INTEGER NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  score         REAL NOT NULL CHECK (score BETWEEN -2.0 AND 2.0),
  confidence    REAL NOT NULL CHECK (confidence BETWEEN 0.0 AND 2.0),
  threshold     REAL NOT NULL,        -- resolved value at time of decision
  flagged       INTEGER NOT NULL,
  rationale     TEXT,
  recorded_at   TEXT NOT NULL,
  PRIMARY KEY (session_date, asset_id)
);

CREATE TABLE score (
  session_date    TEXT NOT NULL REFERENCES session(session_date) ON DELETE CASCADE,
  asset_id        INTEGER NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  d               REAL NOT NULL CHECK (d BETWEEN -2.0 AND 2.0),   -- derived
  conv            REAL NOT NULL CHECK (conv BETWEEN 1 AND 10),    -- derived
  directive       TEXT NOT NULL,                                  -- derived
  queue_reason    TEXT NOT NULL,     -- derived: 'flagged' | 'open_trade' | 'both'
  position_state  TEXT NOT NULL,     -- derived: 'flat' | 'long:N' | 'short:N', N = open units
  params_json     TEXT NOT NULL,     -- derived: resolved weights and thresholds, snapshotted
  rationale       TEXT,
  recorded_at     TEXT NOT NULL,
  PRIMARY KEY (session_date, asset_id)
);

CREATE TABLE score_factor (
  session_date  TEXT NOT NULL,
  asset_id      INTEGER NOT NULL,
  key           TEXT NOT NULL,       -- 'catalyst' | 'trend' | 'secular' | 'crowding' | …
  value         REAL NOT NULL CHECK (value BETWEEN -2.0 AND 2.0),
  weight        REAL NOT NULL,       -- resolved weight applied, snapshotted
  PRIMARY KEY (session_date, asset_id, key),
  FOREIGN KEY (session_date, asset_id) REFERENCES score(session_date, asset_id)
    ON DELETE CASCADE
);

CREATE TABLE trade (
  id                  INTEGER PRIMARY KEY,
  asset_id            INTEGER NOT NULL REFERENCES asset(id),
  direction           TEXT NOT NULL CHECK (direction IN ('long','short')),
  status              TEXT NOT NULL CHECK (status IN ('open','closed')),
  opened_on           TEXT NOT NULL,
  initial_price       REAL NOT NULL,
  initial_stop        REAL NOT NULL,
  initial_risk        REAL NOT NULL,
  thesis              TEXT,
  origin_session_date TEXT,            -- score row that motivated the entry
  closed_on           TEXT,
  created_at          TEXT NOT NULL
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

## Score derivation — v1

`score record` takes agent-supplied **factors**, each on the same -2.0..+2.0 scale, and
derives `d` and `conv` from them. The initial factor set is `catalyst`, `trend`,
`secular`, `crowding`, and it is expected to change.

The factors and an optional rationale are the **only** inputs. Everything else on the
score row is derived at record time from data janus already holds — the agent never
supplies `d`, `conv`, `directive`, `queue_reason` or `position_state`.

Factors are open-ended: any `--factor key=value` is accepted and stored. Only keys with
a resolved weight contribute to `d`; a factor with no weight is recorded but ignored in
the math, so a new factor can be collected and evaluated for a while before it is given
a weight and allowed to move scores.

Weights are cluster params named `w_<factor>`, resolved cluster-first with global
fallback like every other parameter. Defaults: `w_catalyst` 1.0, `w_trend` 1.0,
`w_secular` 1.0, `w_crowding` **-1.0** — crowding is an inverted factor, and a negative
weight expresses that without special-casing.

```
d    = clamp( Σ(wₖ · fₖ) / Σ|wₖ| , -2, +2 )
agree = | Σ(sign(wₖ · fₖ) · |wₖ|) | / Σ|wₖ|            ∈ [0, 1]
conv = clamp( round( 1 + 9 · (0.5 · |d|/2 + 0.5 · agree) ), 1, 10 )
```

`d` is a weighted mean, so it stays in range without the clamp doing real work. `conv`
rewards two different things equally: the strength of the signal (`|d|`) and the
agreement between factors (`agree` is 1.0 when every weighted factor points the same
way, 0.0 when they cancel). Four mildly bullish factors therefore outrank one strongly
bullish factor contradicted by three others, which is the intended behaviour.

Both the factor values and the weights actually applied are snapshotted into
`score_factor`, so any historical score can be re-derived and explained after a retune.

Worked examples under the default weights, which double as the test fixture:

| catalyst | trend | secular | crowding | d | agree | conv |
|---|---|---|---|---|---|---|
| +2 | +2 | +2 | -2 (uncrowded) | +2.00 | 1.00 | 10 |
| +2 | +2 | +2 | +2 (crowded) | +1.00 | 0.50 | 6 |
| +0.5 | +0.5 | +0.5 | -0.5 | +0.50 | 1.00 | 7 |
| +2 | -1 | -1 | +1 | -0.25 | 0.50 | 4 |
| 0 | +2 | 0 | 0 | +0.50 | 0.25 | 3 |
| 0 | 0 | 0 | 0 | 0.00 | 0.00 | 1 |
| -2 | -2 | -2 | +2 | -2.00 | 1.00 | 10 |

Note rows 2 and 3: four mildly-aligned factors (conv 7) outrank three strong factors
undercut by heavy crowding (conv 6), and a lone trend signal with nothing corroborating
it lands at conv 3. Neutral factors count as non-corroborating rather than as
disagreement, so a thin thesis scores thin.

This formula is a placeholder, confined to `domain/score.ts` as one pure function.

## Directive derivation — v1

Inputs: the derived `d` ∈ [-2.0, +2.0] (sign is the direction) and `conv` ∈ [1, 10], the
asset's current position state, and cluster-resolved thresholds.

| Position state | Condition | Directive |
|---|---|---|
| flat | `abs(d) >= strength_initiate` and `conv >= conv_initiate` | `INITIATE` |
| flat | otherwise | `STAND_ASIDE` |
| open, `d` agrees with direction | `conv >= conv_add` and `abs(d) >= strength_add` and `units < max_units` | `ADD` |
| open, `d` agrees | `conv >= conv_hold` | `HOLD` |
| open, `d` agrees | otherwise | `TRIM` |
| open, `d` opposes direction | `abs(d) >= strength_exit` | `EXIT` |
| open, `d` opposes | otherwise | `TRIM` |

Defaults, all overridable per cluster:

| Param | Default |
|---|---|
| `strength_initiate` | 1.0 |
| `conv_initiate` | 6 |
| `strength_add` | 1.0 |
| `conv_add` | 7 |
| `conv_hold` | 4 |
| `strength_exit` | 1.0 |
| `max_units` | 4 |
| `screen_flag_threshold` | 1.0 |
| `w_catalyst` | 1.0 |
| `w_trend` | 1.0 |
| `w_secular` | 1.0 |
| `w_crowding` | -1.0 |

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

janus session status [--date YYYY-MM-DD]
janus session list [--limit N]

janus regime record --state STATE --score N --confidence N --summary -
                    [--metric key=value ...]
janus cluster-read record <cluster> --bias N --judgement -
janus coverage run [--asset SYM[,SYM...]] [--force]
janus coverage list [--date D] [--asset SYM[,SYM...]]
janus screen record <symbol> --score N --confidence N [--rationale -]
janus screen list [--flagged] [--date D]
janus score queue [--date D]
janus score record <symbol> --factor key=value ... [--rationale -]
janus score list [--date D]

janus trade open <symbol> --direction DIR --price P --stop S --risk R --notional N
                          [--date D] [--thesis -]
janus trade add-unit <trade_id> --price P --stop S --risk R --notional N [--date D]
janus trade set-stop <trade_id> --stop S [--unit SEQ]
janus trade exit <trade_id> --price P [--unit SEQ] [--date D]
janus trade list [--open] [--closed] [--asset SYM[,SYM...]]
janus trade show <trade_id>
```

Phase commands default to the current session; their `--date` addresses an existing
session, per Sessions and phase order above. The `--date` on `trade open`, `add-unit`
and `exit` is unrelated — it is the real entry or exit date of that unit, and defaults
to today.

**`--asset` accepts a comma-separated list** wherever it appears: `--asset BTC,ETH,SOL`.
Omitting it means *all eligible assets*, which is the normal daily path — `janus
coverage run` with no flags fetches every roster asset where
`asset.active = 1 AND market.status = 'active'`. The flag exists for retrying a subset
after a partial upstream failure, or for pulling a single asset while debugging.

A symbol in the list that is unknown, deactivated, or delisted on Lighter fails the
whole call with `VALIDATION` naming the offending symbols, rather than silently covering
the remainder. Ambiguity about which assets were actually processed is worse for an
agent than an outright error.

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

Only a full `coverage run` (no `--asset`) that covers every eligible asset stamps
`session.coverage_at`. A subset run writes its rows but leaves the phase incomplete, so
a partial retry cannot accidentally unblock screening on assets that were never
covered.

Validation happens at the CLI boundary: ranges on `d` and `conv`, enum membership,
symbol existence in the roster, `active` status. Errors name the offending flag.

Insufficient bar history is not an error. It produces `NULL` indicators plus a
`bars_available` count, and the coverage row is still written.

## Deferred

Explicitly out of scope for the first implementation, and designed around rather than
built:

- **Advanced D/Conv derivation.** The weighted-mean formula above is a placeholder. The
  factor set itself is also expected to evolve past `catalyst`/`trend`/`secular`/
  `crowding` — which the schema absorbs without migration, since factors are rows and
  weights are cluster params.
- **Advanced directive mapping.** The v1 table above is a placeholder confined to
  `domain/directive.ts`.
- **Risk and position sizing.** Deciding notional, stop placement, and add/trim
  timing is a future strategy module. For v1, the operator supplies `--notional`,
  `--stop` and `--risk` when logging trades and units. `domain/sizing.ts` is the
  intended home; it is not built speculatively now.

## Open items

- `.gitignore` needs `node_modules`, `dist`, `janus.db`. (Done 2026-07-31.)
- Node 24.18.1 installed via nvm 2026-07-31, but nvm's `default` alias still points at
  20.18.0. Either `nvm alias default 24` or rely on the project `.nvmrc`.
