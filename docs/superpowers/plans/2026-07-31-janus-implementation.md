# Janus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a zero-dependency TypeScript CLI that stores and derives state for a Lighter-based trading system, driven by an AI agent through a five-phase daily pipeline.

**Architecture:** A single SQLite file holds everything. Pure functions in `indicators/` and `domain/` do all math with no DB handle and no network; `lighter/` is the only module that touches the network; `db/repo/` wraps SQL; `cli/` parses flags and prints one JSON envelope per invocation. Phases are gated by a session row keyed on the New York calendar date.

**Tech Stack:** Node 24 LTS, TypeScript 7 (`tsc` for `dist/`, native type-stripping in dev), `node:sqlite`, `node:util.parseArgs`, native `fetch`, `node:test`. No runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-07-30-janus-design.md` — read it before starting. It is the source of truth for schema, error codes, and derivation formulas.

## Global Constraints

- **Node `>=24`.** `.nvmrc` pins `24.18.1`; `package.json` declares `"engines": {"node": ">=24"}`.
- **Always invoke Node through pnpm** — `pnpm exec node …`, `pnpm test`, `pnpm build`. The machine's bare `node` is v20.18.0 and will fail on `node:sqlite` and on `.ts` execution. `.npmrc` sets `use-node-version=24.18.1`, so anything pnpm runs gets v24 regardless of the caller's shell. A bare `node` command in a verification step is a bug in that step.
- **pnpm is the package manager.** Commit `pnpm-lock.yaml`; never create `package-lock.json`.
- **Zero runtime dependencies.** `dependencies` in `package.json` stays empty. `@types/node` and `typescript` are `devDependencies` only. Never add a package to solve what stdlib covers.
- **`"type": "module"`** in `package.json`. All imports are ESM.
- **Relative imports use the `.ts` extension** (`import { sma } from "./ma.ts"`). `rewriteRelativeImportExtensions` converts them to `.js` on build. Verified working.
- **`erasableSyntaxOnly: true`.** No `enum`, no parameter properties, no namespaces — Node's type-stripper rejects them.
- **Every command prints exactly one JSON object to stdout** and nothing else. Diagnostics go to stderr. Exit 0 on success, 1 on error.
- **All money values (`notional`, `risk`, `initial_risk`) are USD.** All price values (`stop`, `entry_price`, `initial_price`) are in the market's own units.
- **Scales:** `d` and all factors and scores are `-2.0..+2.0`. `conv` is `1..10`. `confidence` is `0.0..2.0` (a ± margin, never negative).
- **Dates are `YYYY-MM-DD` strings resolved in `America/New_York`.** Timestamps are ISO-8601 UTC strings.
- **Run tests with `pnpm test`** from the project root. The script is
  `node --test 'src/**/*.test.ts'` — the glob is required, not cosmetic: a bare `node --test`
  also discovers the compiled `dist/**/*.test.js`, so every test runs twice and a stale `dist/`
  can mask a regression. `pnpm exec node --test <file>` is still correct for a single file.

## File Structure

| File | Responsibility |
|---|---|
| `src/cli.ts` | Entry point; routes `argv[0]` to a noun module |
| `src/output.ts` | `JanusError`, error codes, JSON envelope, exit codes |
| `src/cli/args.ts` | `parseArgs` wrappers, stdin `-` reading, numeric/enum validation |
| `src/types.ts` | Shared `Bar` type |
| `src/indicators/ma.ts` | `sma`, `ema`, and their series forms |
| `src/indicators/atr.ts` | `atr` (Wilder) |
| `src/indicators/cross.ts` | MA cross state and age; price-vs-MA side and age |
| `src/domain/params.ts` | `DEFAULT_PARAMS`; cluster → global → default resolution |
| `src/domain/score.ts` | `(factors, params) => {d, conv, applied}` |
| `src/domain/directive.ts` | `(d, conv, position, params) => Directive` |
| `src/domain/session.ts` | NY date resolution, phase order state machine |
| `src/domain/trade-math.ts` | Average entry, open risk, realized PnL, R-multiple |
| `src/lighter/client.ts` | `fetch` wrapper plus pure response parsers |
| `src/db/connect.ts` | Open the database, apply pragmas |
| `src/db/migrate.ts` | Ordered DDL array, `user_version` tracking |
| `src/db/repo/*.ts` | One module per table group |
| `src/cli/*.ts` | One module per noun |
| `test/fixtures/*.json` | Recorded Lighter API responses |

---

### Task 1: Project scaffolding, JSON envelope, CLI router

**Files:**
- Create: `.nvmrc`, `src/output.ts`, `src/output.test.ts`, `src/cli.ts`, `src/cli/args.ts`
- Modify: `package.json`, `tsconfig.json`

**Interfaces:**
- Consumes: nothing.
- Produces, from `src/output.ts`: `ErrorCode` (union of 11 string literals — the spec's ten plus `INTERNAL`), `JanusError` (class, `.code`), `envelope(value: unknown): Envelope`, `emit(data: unknown): void`, `fail(err: unknown): void`.
- Produces, from `src/cli/args.ts`: `readText(value: string | undefined): string | undefined`, `required(value: string | undefined, flag: string): string`, `num(raw: string | undefined, flag: string, min: number, max: number): number`, `oneOf<T extends string>(raw: string | undefined, flag: string, allowed: readonly T[]): T`, `csv(raw: string | undefined): string[] | undefined`, `pairs(raw: string[] | undefined, flag: string): Record<string, number>`.

- [ ] **Step 1: Pin the runtime and configure the project**

```bash
echo "24.18.1" > .nvmrc
printf 'use-node-version=24.18.1\nengine-strict=true\n' > .npmrc
```

`use-node-version` makes pnpm fetch and run v24 for every script and `pnpm exec`,
independent of the shell's nvm default (which is v20 on this machine).
`engine-strict` turns the `engines` field into a hard failure rather than a warning.
Verified working: `pnpm exec node -v` prints `v24.18.1` while bare `node -v` prints `v20.18.0`.

Replace `package.json` with:

```json
{
  "name": "janus",
  "version": "0.1.0",
  "description": "Trading system state manager for Lighter perpetuals",
  "type": "module",
  "bin": { "janus": "./dist/cli.js" },
  "engines": { "node": ">=24" },
  "scripts": {
    "build": "tsc -p .",
    "test": "node --test 'src/**/*.test.ts'",
    "janus": "node src/cli.ts"
  },
  "license": "ISC",
  "devDependencies": {
    "@types/node": "^26.1.2",
    "typescript": "^7.0.2"
  }
}
```

Replace `tsconfig.json` with:

```json
{
  "compilerOptions": {
    "target": "es2023",
    "lib": ["es2023"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "types": ["node"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "allowImportingTsExtensions": true,
    "rewriteRelativeImportExtensions": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"]
}
```

Then move the Anthropic SDK out of runtime dependencies — it is scratch code, not part of janus:

```bash
rm -rf tmp
pnpm install
```

- [ ] **Step 2: Write the failing test**

Create `src/output.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { JanusError, envelope } from "./output.ts";

test("envelope wraps data in an ok result", () => {
  assert.deepEqual(envelope({ symbol: "BTC" }), { ok: true, data: { symbol: "BTC" } });
});

test("envelope renders a JanusError with its code", () => {
  const e = new JanusError("NOT_FOUND", "no asset BTC");
  assert.deepEqual(envelope(e), {
    ok: false,
    error: { code: "NOT_FOUND", message: "no asset BTC" },
  });
});

test("envelope renders an unknown error as VALIDATION-free INTERNAL", () => {
  assert.deepEqual(envelope(new Error("boom")), {
    ok: false,
    error: { code: "INTERNAL", message: "boom" },
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm exec node --test src/output.test.ts`
Expected: FAIL — cannot find module `./output.ts`.

- [ ] **Step 4: Write the implementation**

Create `src/output.ts`:

```ts
export type ErrorCode =
  | "NOT_FOUND"
  | "ALREADY_EXISTS"
  | "VALIDATION"
  | "PHASE_ORDER"
  | "SESSION_MISSING"
  | "NO_COVERAGE"
  | "NOT_FLAGGED"
  | "POSITION_CONFLICT"
  | "UPSTREAM"
  | "INSUFFICIENT_HISTORY"
  | "INTERNAL";

export class JanusError extends Error {
  code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export type Envelope =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: ErrorCode; message: string } };

export function envelope(value: unknown): Envelope {
  if (value instanceof JanusError) {
    return { ok: false, error: { code: value.code, message: value.message } };
  }
  if (value instanceof Error) {
    return { ok: false, error: { code: "INTERNAL", message: value.message } };
  }
  return { ok: true, data: value };
}

export function emit(data: unknown): void {
  process.stdout.write(JSON.stringify(envelope(data)) + "\n");
}

export function fail(err: unknown): void {
  const e = err instanceof Error ? err : new Error(String(err));
  process.stdout.write(JSON.stringify(envelope(e)) + "\n");
  process.exitCode = 1;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm exec node --test src/output.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Write the argument helpers**

Create `src/cli/args.ts`:

```ts
import { readFileSync } from "node:fs";
import { JanusError } from "../output.ts";

/** A free-text flag; the literal `-` means "read the value from stdin". */
export function readText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value === "-") return readFileSync(0, "utf8").trim();
  return value;
}

export function required(value: string | undefined, flag: string): string {
  if (value === undefined || value === "") {
    throw new JanusError("VALIDATION", `missing required flag --${flag}`);
  }
  return value;
}

export function num(raw: string | undefined, flag: string, min: number, max: number): number {
  const n = Number(required(raw, flag));
  if (!Number.isFinite(n)) {
    throw new JanusError("VALIDATION", `--${flag} must be a number, got ${raw}`);
  }
  if (n < min || n > max) {
    throw new JanusError("VALIDATION", `--${flag} must be between ${min} and ${max}, got ${n}`);
  }
  return n;
}

export function oneOf<T extends string>(
  raw: string | undefined,
  flag: string,
  allowed: readonly T[],
): T {
  const v = required(raw, flag);
  if (!allowed.includes(v as T)) {
    throw new JanusError("VALIDATION", `--${flag} must be one of ${allowed.join(", ")}, got ${v}`);
  }
  return v as T;
}

/** `--asset BTC,ETH` → ["BTC","ETH"]; absent → undefined (meaning "all"). */
export function csv(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const parts = raw.split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (parts.length === 0) throw new JanusError("VALIDATION", "--asset was empty");
  return parts;
}

/** `["catalyst=1.5","trend=-0.5"]` → { catalyst: 1.5, trend: -0.5 } */
export function pairs(raw: string[] | undefined, flag: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of raw ?? []) {
    const eq = item.indexOf("=");
    if (eq <= 0) {
      throw new JanusError("VALIDATION", `--${flag} must be key=value, got ${item}`);
    }
    const key = item.slice(0, eq);
    const n = Number(item.slice(eq + 1));
    if (!Number.isFinite(n)) {
      throw new JanusError("VALIDATION", `--${flag} ${key} must be a number, got ${item.slice(eq + 1)}`);
    }
    out[key] = n;
  }
  return out;
}
```

- [ ] **Step 7: Write the router**

Create `src/cli.ts`:

```ts
import { emit, fail, JanusError } from "./output.ts";

type Handler = (verb: string | undefined, argv: string[]) => Promise<unknown>;

const NOUNS: Record<string, () => Promise<{ handle: Handler }>> = {};

async function main(): Promise<void> {
  const [noun, verb, ...rest] = process.argv.slice(2);
  if (noun === undefined || noun === "--help") {
    throw new JanusError("VALIDATION", `usage: janus <noun> <verb> [flags]; nouns: ${Object.keys(NOUNS).join(", ")}`);
  }
  const load = NOUNS[noun];
  if (load === undefined) {
    throw new JanusError("VALIDATION", `unknown command "${noun}"; nouns: ${Object.keys(NOUNS).join(", ")}`);
  }
  const mod = await load();
  emit(await mod.handle(verb, rest));
}

main().catch(fail);
```

`NOUNS` is populated as later tasks add command modules. Each registration is one line: `market: () => import("./cli/market.ts"),`.

- [ ] **Step 8: Verify the router and build**

Run: `pnpm exec node src/cli.ts` — expect `{"ok":false,"error":{"code":"VALIDATION","message":"usage: janus <noun> <verb> [flags]; nouns: "}}` and exit code 1 (`echo $?` → 1).
Run: `pnpm build` — expect no output and a populated `dist/`.
Run: `pnpm exec node --test` — expect PASS.

- [ ] **Step 9: Commit**

```bash
git add .nvmrc .npmrc package.json pnpm-lock.yaml tsconfig.json src/
git commit -m "feat: project scaffolding, JSON envelope, CLI router"
```

---

### Task 2: Database connection and migrations

**Files:**
- Create: `src/db/connect.ts`, `src/db/migrate.ts`, `src/db/migrate.test.ts`, `src/cli/init.ts`
- Modify: `src/cli.ts` (register the `init` noun)

**Interfaces:**
- Consumes: `JanusError` from `src/output.ts`.
- Produces: `openDb(path?: string): DatabaseSync`, `migrate(db: DatabaseSync): number` (returns the schema version reached), `MIGRATIONS: string[]`.

- [ ] **Step 1: Write the failing test**

Create `src/db/migrate.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./connect.ts";
import { migrate } from "./migrate.ts";

test("migrate creates every table and is idempotent", () => {
  const db = openDb(":memory:");
  const v1 = migrate(db);
  const v2 = migrate(db);
  assert.equal(v1, v2, "re-running migrate must not advance the version");

  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => (r as { name: string }).name);

  for (const t of [
    "asset", "cluster", "cluster_param", "cluster_read", "coverage",
    "global_param", "market", "regime_metric", "regime_read", "score",
    "score_factor", "screen", "session", "trade", "trade_unit",
  ]) {
    assert.ok(names.includes(t), `missing table ${t}`);
  }
  db.close();
});

test("only one open trade per asset is allowed", () => {
  const db = openDb(":memory:");
  migrate(db);
  db.exec(`
    INSERT INTO market VALUES (1,'BTC','perp','active',1,5,'2025-01-01','2026-07-31');
    INSERT INTO asset (id,market_id,symbol,class,active,added_at)
      VALUES (1,1,'BTC','crypto',1,'2026-07-31');
  `);
  const ins = db.prepare(
    `INSERT INTO trade (asset_id,direction,status,opened_on,initial_price,initial_stop,initial_risk,created_at)
     VALUES (1,'long','open','2026-07-31',100,90,10,'2026-07-31T00:00:00Z')`,
  );
  ins.run();
  assert.throws(() => ins.run(), /UNIQUE/i);
  db.close();
});

test("foreign keys cascade from session to its phase rows", () => {
  const db = openDb(":memory:");
  migrate(db);
  db.exec(`
    INSERT INTO session (session_date,opened_at) VALUES ('2026-07-31','2026-07-31T00:00:00Z');
    INSERT INTO regime_read VALUES ('2026-07-31','NEUTRAL',0.5,0.5,'flat','2026-07-31T00:00:00Z');
  `);
  db.exec("DELETE FROM session WHERE session_date='2026-07-31'");
  const rows = db.prepare("SELECT COUNT(*) AS n FROM regime_read").get() as { n: number };
  assert.equal(rows.n, 0, "regime_read should cascade");
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec node --test src/db/migrate.test.ts`
Expected: FAIL — cannot find module `./connect.ts`.

- [ ] **Step 3: Write the connection module**

Create `src/db/connect.ts`:

```ts
import { DatabaseSync } from "node:sqlite";

export function openDb(path?: string): DatabaseSync {
  const file = path ?? process.env["JANUS_DB"] ?? "./janus.db";
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  return db;
}
```

Note: `PRAGMA journal_mode = WAL` is a no-op on `:memory:` databases and harmless there.

- [ ] **Step 4: Write the migrations**

Create `src/db/migrate.ts`. `MIGRATIONS[0]` is the entire schema from the spec's Schema section, copied verbatim. Append future changes as new array entries — never edit an existing one.

```ts
import type { DatabaseSync } from "node:sqlite";

export const MIGRATIONS: string[] = [
  `
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

CREATE TABLE market (
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
  px_vs_sma20 REAL, px_vs_sma50 REAL, px_vs_sma200 REAL,
  cross_50_200     TEXT CHECK (cross_50_200 IN ('golden','death')),
  cross_50_200_age INTEGER,
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
  threshold     REAL NOT NULL,
  flagged       INTEGER NOT NULL,
  rationale     TEXT,
  recorded_at   TEXT NOT NULL,
  PRIMARY KEY (session_date, asset_id)
);

CREATE TABLE score (
  session_date    TEXT NOT NULL REFERENCES session(session_date) ON DELETE CASCADE,
  asset_id        INTEGER NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  d               REAL NOT NULL CHECK (d BETWEEN -2.0 AND 2.0),
  conv            REAL NOT NULL CHECK (conv BETWEEN 1 AND 10),
  directive       TEXT NOT NULL,
  queue_reason    TEXT NOT NULL,
  position_state  TEXT NOT NULL,
  params_json     TEXT NOT NULL,
  rationale       TEXT,
  recorded_at     TEXT NOT NULL,
  PRIMARY KEY (session_date, asset_id)
);

CREATE TABLE score_factor (
  session_date  TEXT NOT NULL,
  asset_id      INTEGER NOT NULL,
  key           TEXT NOT NULL,
  value         REAL NOT NULL CHECK (value BETWEEN -2.0 AND 2.0),
  weight        REAL NOT NULL,
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
  origin_session_date TEXT,
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
`,
];

export function migrate(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  let version = row.user_version;
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[i]!);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    version = i + 1;
  }
  return version;
}
```

Note: `PRAGMA user_version` cannot be parameterised, hence the template literal. `i` is loop-bounded so there is no injection surface.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm exec node --test src/db/migrate.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Add the `init` command**

Create `src/cli/init.ts`:

```ts
import { openDb } from "../db/connect.ts";
import { migrate } from "../db/migrate.ts";

export async function handle(): Promise<unknown> {
  const db = openDb();
  const version = migrate(db);
  const file = process.env["JANUS_DB"] ?? "./janus.db";
  db.close();
  return { database: file, schema_version: version };
}
```

In `src/cli.ts`, add to `NOUNS`:

```ts
  init: () => import("./cli/init.ts"),
```

- [ ] **Step 7: Verify end to end**

```bash
JANUS_DB=/tmp/janus-check.db pnpm exec node src/cli.ts init
```

Expected: `{"ok":true,"data":{"database":"/tmp/janus-check.db","schema_version":1}}`. Run it twice — the second run returns the same version. Then `rm /tmp/janus-check.db*`.

- [ ] **Step 8: Commit**

```bash
git add src/db src/cli/init.ts src/cli.ts
git commit -m "feat: sqlite schema, migrations, and janus init"
```

---

### Task 3: Rolling indicators — SMA, EMA, ATR

**Files:**
- Create: `src/types.ts`, `src/indicators/ma.ts`, `src/indicators/ma.test.ts`, `src/indicators/atr.ts`, `src/indicators/atr.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Bar` (`{t,o,h,l,c,v,i}` all `number`), `smaSeries(values: number[], period: number): (number|null)[]`, `emaSeries(values: number[], period: number): (number|null)[]`, `sma(values, period): number|null`, `ema(values, period): number|null`, `atr(bars: Bar[], period: number): number|null`. Series functions return one entry per input value, `null` until enough history exists.

- [ ] **Step 1: Write the failing tests**

Create `src/types.ts`:

```ts
/** One daily bar. Field names mirror the Lighter candles payload. */
export type Bar = { t: number; o: number; h: number; l: number; c: number; v: number; i: number };
```

Create `src/indicators/ma.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { sma, ema, smaSeries, emaSeries } from "./ma.ts";

test("sma averages the trailing window", () => {
  assert.equal(sma([1, 2, 3, 4, 5], 5), 3);
  assert.equal(sma([1, 2, 3, 4, 5], 2), 4.5);
});

test("sma returns null when history is shorter than the period", () => {
  assert.equal(sma([1, 2], 5), null);
  assert.equal(sma([], 1), null);
});

test("a non-positive period yields nulls, never NaN", () => {
  assert.deepEqual(smaSeries([1, 2, 3], 0), [null, null, null]);
  assert.deepEqual(smaSeries([1, 2, 3], -1), [null, null, null]);
  assert.equal(sma([1, 2, 3], 0), null);
  assert.equal(ema([1, 2, 3], 0), null);
});

test("smaSeries is null-padded and aligned to the input", () => {
  assert.deepEqual(smaSeries([1, 2, 3, 4], 2), [null, 1.5, 2.5, 3.5]);
});

test("ema seeds from the sma of the first window", () => {
  // seed = sma([1,2,3]) = 2; k = 2/(3+1) = 0.5
  // next = 4*0.5 + 2*0.5 = 3 ; then = 5*0.5 + 3*0.5 = 4
  assert.equal(ema([1, 2, 3, 4, 5], 3), 4);
});

test("emaSeries is null-padded before the seed index", () => {
  assert.deepEqual(emaSeries([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
});

test("ema returns null when history is shorter than the period", () => {
  assert.equal(ema([1, 2], 3), null);
});
```

Create `src/indicators/atr.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { atr } from "./atr.ts";
import type { Bar } from "../types.ts";

const bar = (h: number, l: number, c: number): Bar => ({ t: 0, o: c, h, l, c, v: 0, i: 0 });

test("atr over a constant range equals that range", () => {
  const bars = Array.from({ length: 20 }, () => bar(11, 9, 10));
  assert.equal(atr(bars, 14), 2);
});

test("atr accounts for gaps via the previous close", () => {
  // Two bars: first range 2, second bar gaps up so TR = high - prevClose = 20 - 10 = 10
  const bars: Bar[] = [bar(11, 9, 10), bar(20, 19, 19)];
  assert.equal(atr(bars, 2), 6); // (2 + 10) / 2
});

test("atr returns null when there are fewer bars than the period", () => {
  assert.equal(atr([bar(11, 9, 10)], 14), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec node --test src/indicators/`
Expected: FAIL — cannot find modules `./ma.ts` and `./atr.ts`.

- [ ] **Step 3: Implement the moving averages**

Create `src/indicators/ma.ts`:

```ts
export function smaSeries(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  // Without this guard a period <= 0 makes values[i - period] read past the end,
  // and the non-null assertion below turns that undefined into silent NaN.
  if (period < 1) return new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    out.push(i >= period - 1 ? sum / period : null);
  }
  return out;
}

export function emaSeries(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period || period < 1) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

const last = (series: (number | null)[]): number | null => series.at(-1) ?? null;

export const sma = (values: number[], period: number): number | null => last(smaSeries(values, period));
export const ema = (values: number[], period: number): number | null => last(emaSeries(values, period));
```

- [ ] **Step 4: Implement ATR**

Create `src/indicators/atr.ts`:

```ts
import type { Bar } from "../types.ts";

/** Wilder's true range: the widest of today's range and the two gap measures. */
function trueRange(bar: Bar, prev: Bar | undefined): number {
  const range = bar.h - bar.l;
  if (prev === undefined) return range;
  return Math.max(range, Math.abs(bar.h - prev.c), Math.abs(bar.l - prev.c));
}

/** Simple mean of the trailing `period` true ranges. Null if history is short. */
export function atr(bars: Bar[], period: number): number | null {
  if (bars.length < period || period < 1) return null;
  const tr = bars.map((b, i) => trueRange(b, bars[i - 1]));
  const window = tr.slice(-period);
  return window.reduce((a, b) => a + b, 0) / period;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm exec node --test src/indicators/`
Expected: PASS, 9 tests.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/indicators/
git commit -m "feat: sma, ema, and atr indicators"
```

---

### Task 4: Cross detection

**Files:**
- Create: `src/indicators/cross.ts`, `src/indicators/cross.test.ts`

**Interfaces:**
- Consumes: nothing (operates on `(number|null)[]` series produced by Task 3).
- Produces: `maCross(fast: (number|null)[], slow: (number|null)[]): { state: "golden"|"death"|null; age: number|null }`, `priceVsMa(close: number[], ma: (number|null)[]): { state: "above"|"below"|null; age: number|null }`. `age` counts bars since the state last changed; it is `0` on the bar the cross happened.

- [ ] **Step 1: Write the failing test**

Create `src/indicators/cross.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { maCross, priceVsMa } from "./cross.ts";

test("maCross reports golden and counts bars since the crossover", () => {
  // fast crosses above slow at index 2, then stays above for 2 more bars
  const fast = [1, 2, 4, 5, 6];
  const slow = [3, 3, 3, 3, 3];
  assert.deepEqual(maCross(fast, slow), { state: "golden", age: 2 });
});

test("maCross reports death when fast is below", () => {
  const fast = [5, 5, 2, 1];
  const slow = [3, 3, 3, 3];
  assert.deepEqual(maCross(fast, slow), { state: "death", age: 1 });
});

test("maCross age is 0 on the bar the cross happens", () => {
  const fast = [1, 1, 4];
  const slow = [3, 3, 3];
  assert.deepEqual(maCross(fast, slow), { state: "golden", age: 0 });
});

test("maCross ignores leading nulls and reports age from the first known bar", () => {
  const fast = [null, null, 4, 5];
  const slow = [null, null, 3, 3];
  assert.deepEqual(maCross(fast, slow), { state: "golden", age: 1 });
});

test("maCross returns nulls when no bar has both series", () => {
  assert.deepEqual(maCross([null, null], [null, 3]), { state: null, age: null });
});

test("priceVsMa reports which side price sits on and for how long", () => {
  assert.deepEqual(priceVsMa([1, 2, 5, 6], [3, 3, 3, 3]), { state: "above", age: 1 });
  assert.deepEqual(priceVsMa([5, 5, 1], [3, 3, 3]), { state: "below", age: 0 });
});

test("priceVsMa returns nulls when the ma is entirely null", () => {
  assert.deepEqual(priceVsMa([1, 2], [null, null]), { state: null, age: null });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec node --test src/indicators/cross.test.ts`
Expected: FAIL — cannot find module `./cross.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/indicators/cross.ts`:

```ts
/**
 * Walks two aligned series and reports the current side plus how many bars it
 * has held. Bars where either series is null are skipped entirely, so a short
 * history simply yields a smaller age rather than a wrong one.
 */
function sideRun<T extends string>(
  length: number,
  sideAt: (i: number) => T | null,
): { state: T | null; age: number | null } {
  let state: T | null = null;
  let age: number | null = null;
  for (let i = 0; i < length; i++) {
    const side = sideAt(i);
    if (side === null) continue;
    if (side === state) age = (age ?? 0) + 1;
    else {
      state = side;
      age = 0;
    }
  }
  return { state, age };
}

export function maCross(
  fast: (number | null)[],
  slow: (number | null)[],
): { state: "golden" | "death" | null; age: number | null } {
  return sideRun<"golden" | "death">(Math.min(fast.length, slow.length), (i) => {
    const f = fast[i];
    const s = slow[i];
    if (f == null || s == null) return null;
    return f >= s ? "golden" : "death";
  });
}

export function priceVsMa(
  close: number[],
  ma: (number | null)[],
): { state: "above" | "below" | null; age: number | null } {
  return sideRun<"above" | "below">(Math.min(close.length, ma.length), (i) => {
    const c = close[i];
    const m = ma[i];
    if (c == null || m == null) return null;
    return c >= m ? "above" : "below";
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec node --test src/indicators/cross.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/indicators/cross.ts src/indicators/cross.test.ts
git commit -m "feat: ma cross and price-vs-ma detection with age"
```

---

### Task 5: Parameter resolution

**Files:**
- Create: `src/domain/params.ts`, `src/domain/params.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `DEFAULT_PARAMS: Record<string, number>`, `resolveParams(cluster: Record<string, number>, global: Record<string, number>): Record<string, number>`. Precedence is cluster → global → default. The returned object is the snapshot written to `score.params_json`.

- [ ] **Step 1: Write the failing test**

Create `src/domain/params.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PARAMS, resolveParams } from "./params.ts";

test("defaults match the spec", () => {
  assert.equal(DEFAULT_PARAMS["d_initiate"], 1.0);
  assert.equal(DEFAULT_PARAMS["conv_initiate"], 6);
  assert.equal(DEFAULT_PARAMS["d_add"], 1.0);
  assert.equal(DEFAULT_PARAMS["conv_add"], 7);
  assert.equal(DEFAULT_PARAMS["conv_hold"], 4);
  assert.equal(DEFAULT_PARAMS["d_exit"], 1.0);
  assert.equal(DEFAULT_PARAMS["max_units"], 4);
  assert.equal(DEFAULT_PARAMS["screen_flag_threshold"], 1.0);
  assert.equal(DEFAULT_PARAMS["w_catalyst"], 1.0);
  assert.equal(DEFAULT_PARAMS["w_trend"], 1.0);
  assert.equal(DEFAULT_PARAMS["w_secular"], 1.0);
  assert.equal(DEFAULT_PARAMS["w_crowding"], -1.0);
});

test("cluster beats global beats default", () => {
  const r = resolveParams({ conv_add: 9 }, { conv_add: 8, conv_hold: 5 });
  assert.equal(r["conv_add"], 9, "cluster wins");
  assert.equal(r["conv_hold"], 5, "global wins over default");
  assert.equal(r["d_initiate"], 1.0, "default survives");
});

test("resolveParams passes through params with no default", () => {
  const r = resolveParams({ w_flows: 0.5 }, {});
  assert.equal(r["w_flows"], 0.5);
});

test("resolveParams does not mutate its inputs", () => {
  const cluster = { conv_add: 9 };
  resolveParams(cluster, {});
  assert.deepEqual(cluster, { conv_add: 9 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec node --test src/domain/params.test.ts`
Expected: FAIL — cannot find module `./params.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/domain/params.ts`:

```ts
/**
 * Hardcoded floor of the cluster-first / global-fallback chain. A factor weight
 * absent from every layer means that factor is recorded but does not move `d`.
 */
export const DEFAULT_PARAMS: Record<string, number> = {
  d_initiate: 1.0,
  conv_initiate: 6,
  d_add: 1.0,
  conv_add: 7,
  conv_hold: 4,
  d_exit: 1.0,
  max_units: 4,
  screen_flag_threshold: 1.0,
  w_catalyst: 1.0,
  w_trend: 1.0,
  w_secular: 1.0,
  w_crowding: -1.0,
};

export function resolveParams(
  cluster: Record<string, number>,
  global: Record<string, number>,
): Record<string, number> {
  return { ...DEFAULT_PARAMS, ...global, ...cluster };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec node --test src/domain/params.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/domain/params.ts src/domain/params.test.ts
git commit -m "feat: cluster-first parameter resolution with spec defaults"
```

---

### Task 6: Score derivation — D and Conv

**Files:**
- Create: `src/domain/score.ts`, `src/domain/score.test.ts`

**Interfaces:**
- Consumes: nothing (takes a resolved params object from Task 5).
- Produces: `deriveScore(factors: Record<string, number>, params: Record<string, number>): { d: number; conv: number; applied: Record<string, number> }`. `applied` maps **every** supplied factor key to the weight used — `0` for factors with no `w_<key>` — because `score_factor.weight` is `NOT NULL`.

- [ ] **Step 1: Write the failing test**

The table below is copied from the spec's "Worked examples" and is the authoritative fixture.

Create `src/domain/score.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveScore } from "./score.ts";
import { DEFAULT_PARAMS } from "./params.ts";

const f = (catalyst: number, trend: number, secular: number, crowding: number) => ({
  catalyst, trend, secular, crowding,
});

test("spec worked examples", () => {
  const cases: [ReturnType<typeof f>, number, number][] = [
    [f(2, 2, 2, -2), 2.0, 10],
    [f(2, 2, 2, 2), 1.0, 6],
    [f(0.5, 0.5, 0.5, -0.5), 0.5, 7],
    [f(2, -1, -1, 1), -0.25, 4],
    [f(0, 2, 0, 0), 0.5, 3],
    [f(0, 0, 0, 0), 0.0, 1],
    [f(-2, -2, -2, 2), -2.0, 10],
  ];
  for (const [factors, d, conv] of cases) {
    const got = deriveScore(factors, DEFAULT_PARAMS);
    assert.equal(Number(got.d.toFixed(2)), d, `d for ${JSON.stringify(factors)}`);
    assert.equal(got.conv, conv, `conv for ${JSON.stringify(factors)}`);
  }
});

test("a factor with no weight is reported but does not move d", () => {
  const weighted = deriveScore({ catalyst: 2 }, DEFAULT_PARAMS);
  const withExtra = deriveScore({ catalyst: 2, vibes: -2 }, DEFAULT_PARAMS);
  assert.equal(withExtra.d, weighted.d);
  assert.equal(withExtra.applied["vibes"], 0);
  assert.equal(withExtra.applied["catalyst"], 1.0);
});

test("no weighted factors yields a neutral score rather than dividing by zero", () => {
  const got = deriveScore({ vibes: 2 }, DEFAULT_PARAMS);
  assert.deepEqual({ d: got.d, conv: got.conv }, { d: 0, conv: 1 });
});

test("negative weights invert a factor", () => {
  // crowding alone, heavily crowded, with w_crowding = -1 → bearish
  const got = deriveScore({ crowding: 2 }, DEFAULT_PARAMS);
  assert.equal(got.d, -2);
  assert.equal(got.applied["crowding"], -1.0);
});

test("d is clamped into range", () => {
  const got = deriveScore({ catalyst: 2 }, { w_catalyst: 5 });
  assert.equal(got.d, 2);
});

test("deriveScore rejects an out-of-range factor", () => {
  assert.throws(() => deriveScore({ catalyst: 3 }, DEFAULT_PARAMS), /catalyst/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec node --test src/domain/score.test.ts`
Expected: FAIL — cannot find module `./score.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/domain/score.ts`:

```ts
import { JanusError } from "../output.ts";

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/**
 * v1 placeholder. `d` is the weighted mean of the factors; `conv` rewards signal
 * strength and inter-factor agreement equally. Replacing this is a single-file
 * change — nothing outside reads the formula.
 */
export function deriveScore(
  factors: Record<string, number>,
  params: Record<string, number>,
): { d: number; conv: number; applied: Record<string, number> } {
  const applied: Record<string, number> = {};
  for (const [key, value] of Object.entries(factors)) {
    if (!Number.isFinite(value) || value < -2 || value > 2) {
      throw new JanusError("VALIDATION", `factor ${key} must be between -2 and 2, got ${value}`);
    }
    applied[key] = params[`w_${key}`] ?? 0;
  }

  const weighted = Object.entries(applied).filter(([, w]) => w !== 0);
  const totalWeight = weighted.reduce((a, [, w]) => a + Math.abs(w), 0);
  if (totalWeight === 0) return { d: 0, conv: 1, applied };

  const d = clamp(
    weighted.reduce((a, [k, w]) => a + w * factors[k]!, 0) / totalWeight,
    -2,
    2,
  );
  const agree =
    Math.abs(weighted.reduce((a, [k, w]) => a + Math.sign(w * factors[k]!) * Math.abs(w), 0)) /
    totalWeight;
  const conv = clamp(Math.round(1 + 9 * (0.5 * (Math.abs(d) / 2) + 0.5 * agree)), 1, 10);

  return { d, conv, applied };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec node --test src/domain/score.test.ts`
Expected: PASS, 6 tests. If the worked-examples table fails, the formula is wrong — not the table. The table is verified against the spec.

- [ ] **Step 5: Commit**

```bash
git add src/domain/score.ts src/domain/score.test.ts
git commit -m "feat: derive d and conv from weighted agent factors"
```

---

### Task 7: Directive derivation

**Files:**
- Create: `src/domain/directive.ts`, `src/domain/directive.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Directive` (`"INITIATE"|"ADD"|"HOLD"|"TRIM"|"EXIT"|"STAND_ASIDE"`), `PositionState` (`{ side: "long"|"short"|null; units: number }`), `deriveDirective(d: number, conv: number, pos: PositionState, params: Record<string, number>): Directive`, `formatPosition(pos: PositionState): string` (`"flat"` | `"long:2"`).

- [ ] **Step 1: Write the failing test**

Create `src/domain/directive.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveDirective, formatPosition } from "./directive.ts";
import { DEFAULT_PARAMS } from "./params.ts";
import type { PositionState } from "./directive.ts";

const flat: PositionState = { side: null, units: 0 };
const long = (units: number): PositionState => ({ side: "long", units });
const short = (units: number): PositionState => ({ side: "short", units });
const call = (d: number, conv: number, pos: PositionState) =>
  deriveDirective(d, conv, pos, DEFAULT_PARAMS);

test("flat: initiates only when both d and conv clear their thresholds", () => {
  assert.equal(call(1.5, 8, flat), "INITIATE");
  assert.equal(call(1.0, 6, flat), "INITIATE", "boundary is inclusive");
  assert.equal(call(-1.5, 8, flat), "INITIATE", "short side initiates too");
  assert.equal(call(0.9, 8, flat), "STAND_ASIDE", "d below d_initiate");
  assert.equal(call(1.5, 5, flat), "STAND_ASIDE", "conv below conv_initiate");
});

test("open and agreeing: add, hold, or trim by conviction", () => {
  assert.equal(call(1.5, 8, long(2)), "ADD");
  assert.equal(call(1.0, 7, long(2)), "ADD", "boundary is inclusive");
  assert.equal(call(1.5, 8, long(4)), "HOLD", "max_units reached blocks ADD");
  assert.equal(call(0.5, 8, long(1)), "HOLD", "d below d_add blocks ADD");
  assert.equal(call(1.5, 5, long(1)), "HOLD", "conv below conv_add");
  assert.equal(call(1.5, 4, long(1)), "HOLD", "conv_hold boundary is inclusive");
  assert.equal(call(1.5, 3, long(1)), "TRIM", "conv below conv_hold");
});

test("open and agreeing works identically for shorts", () => {
  assert.equal(call(-1.5, 8, short(2)), "ADD");
  assert.equal(call(-1.5, 3, short(2)), "TRIM");
});

test("open and opposed: exit on a strong reversal, trim on a weak one", () => {
  assert.equal(call(-1.5, 8, long(2)), "EXIT");
  assert.equal(call(-1.0, 2, long(2)), "EXIT", "boundary is inclusive, conv irrelevant");
  assert.equal(call(-0.5, 8, long(2)), "TRIM");
  assert.equal(call(1.5, 8, short(2)), "EXIT");
  assert.equal(call(0.5, 8, short(2)), "TRIM");
});

test("d of exactly zero counts as opposing an open position", () => {
  assert.equal(call(0, 8, long(1)), "TRIM");
});

test("cluster params override the defaults", () => {
  const strict = { ...DEFAULT_PARAMS, conv_initiate: 9 };
  assert.equal(deriveDirective(1.5, 8, flat, strict), "STAND_ASIDE");
});

test("formatPosition renders side and unit count", () => {
  assert.equal(formatPosition(flat), "flat");
  assert.equal(formatPosition(long(2)), "long:2");
  assert.equal(formatPosition(short(1)), "short:1");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec node --test src/domain/directive.test.ts`
Expected: FAIL — cannot find module `./directive.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/domain/directive.ts`:

```ts
export type Directive = "INITIATE" | "ADD" | "HOLD" | "TRIM" | "EXIT" | "STAND_ASIDE";
export type PositionState = { side: "long" | "short" | null; units: number };

export function formatPosition(pos: PositionState): string {
  return pos.side === null ? "flat" : `${pos.side}:${pos.units}`;
}

/** v1 placeholder — see the spec's directive table. Replacing it touches only this file. */
export function deriveDirective(
  d: number,
  conv: number,
  pos: PositionState,
  params: Record<string, number>,
): Directive {
  const p = (key: string): number => params[key] ?? 0;

  if (pos.side === null) {
    return Math.abs(d) >= p("d_initiate") && conv >= p("conv_initiate")
      ? "INITIATE"
      : "STAND_ASIDE";
  }

  const agrees = pos.side === "long" ? d > 0 : d < 0;

  if (!agrees) return Math.abs(d) >= p("d_exit") ? "EXIT" : "TRIM";
  if (conv >= p("conv_add") && Math.abs(d) >= p("d_add") && pos.units < p("max_units")) return "ADD";
  if (conv >= p("conv_hold")) return "HOLD";
  return "TRIM";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec node --test src/domain/directive.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/domain/directive.ts src/domain/directive.test.ts
git commit -m "feat: position-aware directive derivation"
```

---

### Task 8: Session dates and phase order

**Files:**
- Create: `src/domain/session.ts`, `src/domain/session.test.ts`

**Interfaces:**
- Consumes: `JanusError` from `src/output.ts`.
- Produces: `PHASES` (readonly tuple `["regime","cluster_read","coverage","screen","score"]`), `Phase` (union), `SessionRow` (`{session_date: string; opened_at: string; regime_at: string|null; cluster_read_at: string|null; coverage_at: string|null; screen_at: string|null; score_at: string|null}`), `todayNY(now?: Date): string`, `nowIso(): string`, `phaseColumn(p: Phase): string`, `nextPhase(s: SessionRow): Phase | null`, `assertPhaseOrder(s: SessionRow, phase: Phase, force: boolean): void`.

- [ ] **Step 1: Write the failing test**

Create `src/domain/session.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { todayNY, nextPhase, assertPhaseOrder, phaseColumn, PHASES } from "./session.ts";
import type { SessionRow } from "./session.ts";

const session = (over: Partial<SessionRow> = {}): SessionRow => ({
  session_date: "2026-07-31",
  opened_at: "2026-07-31T12:00:00Z",
  regime_at: null,
  cluster_read_at: null,
  coverage_at: null,
  screen_at: null,
  score_at: null,
  ...over,
});

test("todayNY converts a UTC instant to the New York calendar date", () => {
  // 03:30 UTC on Aug 1 is still Jul 31 in New York
  assert.equal(todayNY(new Date("2026-08-01T03:30:00Z")), "2026-07-31");
  assert.equal(todayNY(new Date("2026-07-31T23:30:00Z")), "2026-07-31");
  // 04:30 UTC on Aug 1 has rolled over (EDT is UTC-4)
  assert.equal(todayNY(new Date("2026-08-01T04:30:00Z")), "2026-08-01");
});

test("todayNY emits YYYY-MM-DD", () => {
  assert.match(todayNY(new Date("2026-01-05T18:00:00Z")), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(todayNY(new Date("2026-01-05T18:00:00Z")), "2026-01-05");
});

test("phaseColumn maps each phase to its timestamp column", () => {
  assert.equal(phaseColumn("regime"), "regime_at");
  assert.equal(phaseColumn("cluster_read"), "cluster_read_at");
  assert.equal(phaseColumn("score"), "score_at");
});

test("nextPhase walks the pipeline in order", () => {
  assert.equal(nextPhase(session()), "regime");
  assert.equal(nextPhase(session({ regime_at: "x" })), "cluster_read");
  assert.equal(nextPhase(session({ regime_at: "x", cluster_read_at: "x" })), "coverage");
  const done = session({
    regime_at: "x", cluster_read_at: "x", coverage_at: "x", screen_at: "x", score_at: "x",
  });
  assert.equal(nextPhase(done), null);
});

test("assertPhaseOrder allows a phase whose predecessors are complete", () => {
  assertPhaseOrder(session(), "regime", false);
  assertPhaseOrder(session({ regime_at: "x" }), "cluster_read", false);
});

test("assertPhaseOrder allows re-running a completed phase", () => {
  assertPhaseOrder(session({ regime_at: "x" }), "regime", false);
});

test("assertPhaseOrder rejects a phase with an incomplete predecessor", () => {
  assert.throws(
    () => assertPhaseOrder(session(), "coverage", false),
    (e: Error & { code?: string }) => e.code === "PHASE_ORDER" && /regime/.test(e.message),
  );
});

test("assertPhaseOrder yields to --force", () => {
  assertPhaseOrder(session(), "score", true);
});

test("PHASES is the documented pipeline order", () => {
  assert.deepEqual([...PHASES], ["regime", "cluster_read", "coverage", "screen", "score"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec node --test src/domain/session.test.ts`
Expected: FAIL — cannot find module `./session.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/domain/session.ts`:

```ts
import { JanusError } from "../output.ts";

export const PHASES = ["regime", "cluster_read", "coverage", "screen", "score"] as const;
export type Phase = (typeof PHASES)[number];

export type SessionRow = {
  session_date: string;
  opened_at: string;
  regime_at: string | null;
  cluster_read_at: string | null;
  coverage_at: string | null;
  screen_at: string | null;
  score_at: string | null;
};

const NY_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The session's calendar date, anchored to New York so the day boundary matches the close. */
export function todayNY(now?: Date): string {
  return NY_DATE.format(now ?? new Date());
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function phaseColumn(phase: Phase): string {
  return `${phase}_at`;
}

export function nextPhase(session: SessionRow): Phase | null {
  for (const phase of PHASES) {
    if (session[phaseColumn(phase) as keyof SessionRow] === null) return phase;
  }
  return null;
}

/** Throws PHASE_ORDER naming the first incomplete predecessor. Re-running a done phase is fine. */
export function assertPhaseOrder(session: SessionRow, phase: Phase, force: boolean): void {
  if (force) return;
  for (const earlier of PHASES) {
    if (earlier === phase) return;
    if (session[phaseColumn(earlier) as keyof SessionRow] === null) {
      throw new JanusError(
        "PHASE_ORDER",
        `${earlier} not complete for ${session.session_date}; run it first or pass --force`,
      );
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec node --test src/domain/session.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/domain/session.ts src/domain/session.test.ts
git commit -m "feat: NY-anchored session dates and phase order gating"
```

---

### Task 9: Trade math

**Files:**
- Create: `src/domain/trade-math.ts`, `src/domain/trade-math.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `UnitRow` (`{seq: number; entry_price: number; notional: number; risk: number; stop: number; status: "open"|"closed"; exit_price: number|null}`), `tradeSummary(direction: "long"|"short", initialRisk: number, units: UnitRow[]): { open_units: number; closed_units: number; total_notional: number; avg_entry: number|null; open_risk: number; realized_pnl: number; r_multiple: number|null }`.

Size is derived as `notional / entry_price`. Open risk uses each unit's **current** stop, not its stored `risk`, so moving a stop is reflected immediately.

- [ ] **Step 1: Write the failing test**

Create `src/domain/trade-math.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { tradeSummary } from "./trade-math.ts";
import type { UnitRow } from "./trade-math.ts";

const unit = (over: Partial<UnitRow> = {}): UnitRow => ({
  seq: 1, entry_price: 100, notional: 1000, risk: 100, stop: 90,
  status: "open", exit_price: null, ...over,
});

test("summarises a single open long", () => {
  const s = tradeSummary("long", 100, [unit()]);
  assert.equal(s.open_units, 1);
  assert.equal(s.total_notional, 1000);
  assert.equal(s.avg_entry, 100);
  assert.equal(s.open_risk, 100); // size 10 x (100 - 90)
  assert.equal(s.realized_pnl, 0);
  assert.equal(s.r_multiple, null, "no r-multiple until something is closed");
});

test("average entry is notional-weighted across open units", () => {
  const s = tradeSummary("long", 100, [
    unit({ seq: 1, entry_price: 100, notional: 1000 }),
    unit({ seq: 2, entry_price: 120, notional: 3000 }),
  ]);
  // sizes 10 and 25 → total size 35, total notional 4000 → avg 114.2857
  assert.equal(s.total_notional, 4000);
  assert.equal(Number(s.avg_entry!.toFixed(4)), 114.2857);
});

test("open risk follows the current stop, not the stored risk", () => {
  const s = tradeSummary("long", 100, [unit({ stop: 95, risk: 999 })]);
  assert.equal(s.open_risk, 50); // size 10 x (100 - 95)
});

test("a stop above entry on a long yields negative open risk (locked-in gain)", () => {
  const s = tradeSummary("long", 100, [unit({ stop: 110 })]);
  assert.equal(s.open_risk, -100);
});

test("realized pnl and r-multiple for a closed long", () => {
  const s = tradeSummary("long", 100, [
    unit({ seq: 1, status: "closed", entry_price: 100, notional: 1000, exit_price: 130 }),
  ]);
  assert.equal(s.closed_units, 1);
  assert.equal(s.open_units, 0);
  assert.equal(s.realized_pnl, 300); // size 10 x 30
  assert.equal(s.r_multiple, 3);
  assert.equal(s.avg_entry, null, "no open units left");
});

test("shorts invert the pnl sign", () => {
  const s = tradeSummary("short", 100, [
    unit({ seq: 1, status: "closed", entry_price: 100, notional: 1000, exit_price: 70 }),
  ]);
  assert.equal(s.realized_pnl, 300);
  assert.equal(s.r_multiple, 3);
});

test("short open risk measures upward distance to the stop", () => {
  const s = tradeSummary("short", 100, [unit({ entry_price: 100, stop: 110 })]);
  assert.equal(s.open_risk, 100);
});

test("an empty unit list is neutral, not a divide by zero", () => {
  const s = tradeSummary("long", 100, []);
  assert.deepEqual(s, {
    open_units: 0, closed_units: 0, total_notional: 0,
    avg_entry: null, open_risk: 0, realized_pnl: 0, r_multiple: null,
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec node --test src/domain/trade-math.test.ts`
Expected: FAIL — cannot find module `./trade-math.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/domain/trade-math.ts`:

```ts
export type UnitRow = {
  seq: number;
  entry_price: number;
  notional: number;
  risk: number;
  stop: number;
  status: "open" | "closed";
  exit_price: number | null;
};

export type TradeSummary = {
  open_units: number;
  closed_units: number;
  total_notional: number;
  avg_entry: number | null;
  open_risk: number;
  realized_pnl: number;
  r_multiple: number | null;
};

const sizeOf = (u: UnitRow): number => u.notional / u.entry_price;

/**
 * Everything here is computed on read. Nothing is stored denormalized, so
 * correcting a unit can never leave a stale total behind.
 */
export function tradeSummary(
  direction: "long" | "short",
  initialRisk: number,
  units: UnitRow[],
): TradeSummary {
  const sign = direction === "long" ? 1 : -1;
  const open = units.filter((u) => u.status === "open");
  const closed = units.filter((u) => u.status === "closed");

  const total_notional = open.reduce((a, u) => a + u.notional, 0);
  const openSize = open.reduce((a, u) => a + sizeOf(u), 0);
  const open_risk = open.reduce((a, u) => a + sizeOf(u) * (u.entry_price - u.stop) * sign, 0);
  const realized_pnl = closed.reduce(
    (a, u) => a + sizeOf(u) * ((u.exit_price ?? u.entry_price) - u.entry_price) * sign,
    0,
  );

  return {
    open_units: open.length,
    closed_units: closed.length,
    total_notional,
    avg_entry: openSize === 0 ? null : total_notional / openSize,
    open_risk,
    realized_pnl,
    r_multiple: closed.length === 0 || initialRisk === 0 ? null : realized_pnl / initialRisk,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec node --test src/domain/trade-math.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/domain/trade-math.ts src/domain/trade-math.test.ts
git commit -m "feat: trade aggregation, open risk, and r-multiple"
```

---

### Task 10: Lighter API client

**Files:**
- Create: `src/lighter/client.ts`, `src/lighter/client.test.ts`, `test/fixtures/orderBooks.json`, `test/fixtures/orderBookDetails.json`, `test/fixtures/candles.json`

**Interfaces:**
- Consumes: `JanusError` from `src/output.ts`, `Bar` from `src/types.ts`.
- Produces:
  - `MarketInfo` = `{ symbol: string; market_id: number; market_type: string; status: string; price_decimals: number; size_decimals: number; listed_at: string }`
  - `Snapshot` = `{ mark_price: number|null; index_price: number|null; last_trade_price: number|null; daily_price_low: number|null; daily_price_high: number|null; daily_price_change: number|null; open_interest: number|null }`
  - `parseMarkets(json: unknown): MarketInfo[]`, `parseSnapshot(json: unknown): Snapshot`, `parseBars(json: unknown): Bar[]` — pure, tested against fixtures
  - `LighterApi` = `{ fetchMarkets(): Promise<MarketInfo[]>; fetchSnapshot(marketId: number): Promise<Snapshot>; fetchDailyBars(marketId: number, lookbackDays?: number): Promise<Bar[]> }`
  - `createLighterClient(baseUrl?: string): LighterApi`

`LighterApi` is a plain object type, not a class or an interface with an implementation hierarchy. Tests that need a stand-in pass an object literal.

- [ ] **Step 1: Capture the fixtures**

These commands are verified against the live API. Run them from the project root:

```bash
mkdir -p test/fixtures
curl -s "https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails?market_id=1" \
  -o test/fixtures/orderBookDetails.json
curl -s "https://mainnet.zklighter.elliot.ai/api/v1/candles?market_id=1&resolution=1d&start_timestamp=1775000000000&end_timestamp=1790000000000&count_back=0&set_timestamp_to_end=false" \
  -o test/fixtures/candles.json
# orderBooks is ~228 entries; keep only the first 3 so the fixture stays readable
curl -s "https://mainnet.zklighter.elliot.ai/api/v1/orderBooks" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);j.order_books=j.order_books.slice(0,3);process.stdout.write(JSON.stringify(j,null,2));})' \
  > test/fixtures/orderBooks.json
```

Verify each file is non-empty and starts with `{"code":200` (or `{\n  "code": 200` for the pretty-printed one):

```bash
head -c 60 test/fixtures/orderBooks.json test/fixtures/orderBookDetails.json test/fixtures/candles.json
```

Reference shapes, confirmed live on 2026-07-31:
- `orderBooks` → `{code, order_books: [{symbol, market_id, market_type, status, supported_price_decimals, supported_size_decimals, created_at, ...}]}` — `created_at` is a **string of epoch milliseconds**.
- `orderBookDetails` → `{code, order_book_details: [{mark_price, index_price, last_trade_price, daily_price_low, daily_price_high, daily_price_change, open_interest, ...}]}` — prices arrive as **strings**, `last_trade_price` and `open_interest` as **numbers**.
- `candles` → `{code, r: "1d", c: [{t, o, h, l, c, v, V, i}]}` — `t` is epoch ms, `i` is open interest.

- [ ] **Step 2: Write the failing test**

Create `src/lighter/client.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseMarkets, parseSnapshot, parseBars } from "./client.ts";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../test/fixtures/${name}.json`, import.meta.url), "utf8"));

test("parseMarkets maps the catalog payload", () => {
  const markets = parseMarkets(fixture("orderBooks"));
  assert.ok(markets.length > 0);
  const m = markets[0]!;
  assert.equal(typeof m.symbol, "string");
  assert.equal(typeof m.market_id, "number");
  assert.equal(typeof m.price_decimals, "number");
  assert.equal(typeof m.size_decimals, "number");
  assert.match(m.listed_at, /^\d{4}-\d{2}-\d{2}$/, "created_at ms is converted to a date");
});

test("parseSnapshot coerces string prices to numbers", () => {
  const s = parseSnapshot(fixture("orderBookDetails"));
  assert.equal(typeof s.mark_price, "number");
  assert.equal(typeof s.index_price, "number");
  assert.equal(typeof s.open_interest, "number");
});

test("parseBars returns chronologically ordered bars", () => {
  const bars = parseBars(fixture("candles"));
  assert.ok(bars.length > 5, "fixture should hold a useful history");
  for (let i = 1; i < bars.length; i++) {
    assert.ok(bars[i]!.t > bars[i - 1]!.t, `bar ${i} is out of order`);
  }
  const b = bars[0]!;
  for (const k of ["t", "o", "h", "l", "c", "v", "i"] as const) {
    assert.equal(typeof b[k], "number", `bar.${k} should be a number`);
  }
});

test("parsers reject a payload that is not the expected shape", () => {
  assert.throws(() => parseMarkets({ code: 200 }), /order_books/);
  assert.throws(() => parseSnapshot({ code: 200, order_book_details: [] }), /order_book_details/);
  assert.throws(() => parseBars({ code: 200 }), /candles/);
});

test("fetchDailyBars requests a millisecond range and parses the reply", async () => {
  const calls: string[] = [];
  const fakeFetch: typeof fetch = async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify(fixture("candles")), { status: 200 });
  };
  const { createLighterClient } = await import("./client.ts");
  const client = createLighterClient("https://example.test", fakeFetch);
  const bars = await client.fetchDailyBars(1, 400);
  assert.ok(bars.length > 5);
  const url = new URL(calls[0]!);
  assert.equal(url.pathname, "/api/v1/candles");
  assert.equal(url.searchParams.get("resolution"), "1d");
  assert.ok(Number(url.searchParams.get("start_timestamp")) > 1e12, "timestamps must be in ms");
});

test("a non-200 response becomes an UPSTREAM error naming the endpoint", async () => {
  const fakeFetch: typeof fetch = async () => new Response("nope", { status: 503 });
  const { createLighterClient } = await import("./client.ts");
  const client = createLighterClient("https://example.test", fakeFetch);
  await assert.rejects(
    () => client.fetchMarkets(),
    (e: Error & { code?: string }) => e.code === "UPSTREAM" && /503/.test(e.message),
  );
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm exec node --test src/lighter/client.test.ts`
Expected: FAIL — cannot find module `./client.ts`.

- [ ] **Step 4: Write the implementation**

Create `src/lighter/client.ts`:

```ts
import { JanusError } from "../output.ts";
import type { Bar } from "../types.ts";

export const LIGHTER_BASE_URL = "https://mainnet.zklighter.elliot.ai";

export type MarketInfo = {
  symbol: string;
  market_id: number;
  market_type: string;
  status: string;
  price_decimals: number;
  size_decimals: number;
  listed_at: string;
};

export type Snapshot = {
  mark_price: number | null;
  index_price: number | null;
  last_trade_price: number | null;
  daily_price_low: number | null;
  daily_price_high: number | null;
  daily_price_change: number | null;
  open_interest: number | null;
};

export type LighterApi = {
  fetchMarkets(): Promise<MarketInfo[]>;
  fetchSnapshot(marketId: number): Promise<Snapshot>;
  fetchDailyBars(marketId: number, lookbackDays?: number): Promise<Bar[]>;
};

/** Lighter returns some numerics as strings; anything unparseable becomes null. */
function toNum(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function required(value: unknown, field: string): number {
  const n = toNum(value);
  if (n === null) throw new JanusError("UPSTREAM", `missing numeric field ${field}`);
  return n;
}

function arrayAt(json: unknown, key: string): unknown[] {
  const value = (json as Record<string, unknown>)?.[key];
  if (!Array.isArray(value)) throw new JanusError("UPSTREAM", `expected ${key} array in response`);
  return value;
}

export function parseMarkets(json: unknown): MarketInfo[] {
  return arrayAt(json, "order_books").map((raw) => {
    const m = raw as Record<string, unknown>;
    return {
      symbol: String(m["symbol"]),
      market_id: required(m["market_id"], "market_id"),
      market_type: String(m["market_type"]),
      status: String(m["status"]),
      price_decimals: required(m["supported_price_decimals"], "supported_price_decimals"),
      size_decimals: required(m["supported_size_decimals"], "supported_size_decimals"),
      listed_at: new Date(required(m["created_at"], "created_at")).toISOString().slice(0, 10),
    };
  });
}

export function parseSnapshot(json: unknown): Snapshot {
  const [raw] = arrayAt(json, "order_book_details");
  if (raw === undefined) throw new JanusError("UPSTREAM", "empty order_book_details array");
  const d = raw as Record<string, unknown>;
  return {
    mark_price: toNum(d["mark_price"]),
    index_price: toNum(d["index_price"]),
    last_trade_price: toNum(d["last_trade_price"]),
    daily_price_low: toNum(d["daily_price_low"]),
    daily_price_high: toNum(d["daily_price_high"]),
    daily_price_change: toNum(d["daily_price_change"]),
    open_interest: toNum(d["open_interest"]),
  };
}

export function parseBars(json: unknown): Bar[] {
  const raw = (json as Record<string, unknown>)?.["c"];
  if (!Array.isArray(raw)) throw new JanusError("UPSTREAM", "expected candles array `c` in response");
  return raw
    .map((item) => {
      const b = item as Record<string, unknown>;
      return {
        t: required(b["t"], "t"),
        o: required(b["o"], "o"),
        h: required(b["h"], "h"),
        l: required(b["l"], "l"),
        c: required(b["c"], "c"),
        v: toNum(b["v"]) ?? 0,
        i: toNum(b["i"]) ?? 0,
      };
    })
    .sort((a, b) => a.t - b.t);
}

export function createLighterClient(
  baseUrl: string = LIGHTER_BASE_URL,
  fetchImpl: typeof fetch = fetch,
): LighterApi {
  async function get(path: string, params: Record<string, string> = {}): Promise<unknown> {
    const url = new URL(`/api/v1/${path}`, baseUrl);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await fetchImpl(url);
    } catch (cause) {
      throw new JanusError("UPSTREAM", `${path} request failed: ${(cause as Error).message}`);
    }
    if (!res.ok) throw new JanusError("UPSTREAM", `${path} returned HTTP ${res.status}`);
    return res.json();
  }

  return {
    async fetchMarkets() {
      return parseMarkets(await get("orderBooks"));
    },
    async fetchSnapshot(marketId) {
      return parseSnapshot(await get("orderBookDetails", { market_id: String(marketId) }));
    },
    async fetchDailyBars(marketId, lookbackDays = 400) {
      const end = Date.now();
      const start = end - lookbackDays * 86_400_000;
      return parseBars(
        await get("candles", {
          market_id: String(marketId),
          resolution: "1d",
          start_timestamp: String(start),
          end_timestamp: String(end),
          count_back: "0",
          set_timestamp_to_end: "false",
        }),
      );
    },
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm exec node --test src/lighter/client.test.ts`
Expected: PASS, 6 tests. No network is used — the two async tests inject a fake `fetch`.

- [ ] **Step 6: Commit**

```bash
git add src/lighter/ test/fixtures/
git commit -m "feat: lighter api client with fixture-backed parsers"
```

---

### Task 11: Roster — market, cluster, and asset repos and commands

**Files:**
- Create: `src/db/repo/market.ts`, `src/db/repo/cluster.ts`, `src/db/repo/asset.ts`, `src/db/repo/roster.test.ts`, `src/cli/market.ts`, `src/cli/cluster.ts`, `src/cli/asset.ts`
- Modify: `src/cli.ts` (register `market`, `cluster`, `asset`)

**Interfaces:**
- Consumes: `openDb`, `migrate`, `MarketInfo`, `createLighterClient`, `JanusError`, arg helpers, `nowIso`.
- Produces:
  - `market.ts`: `upsertMarkets(db, markets: MarketInfo[], syncedAt: string): number`, `listMarkets(db, opts: {search?: string; status?: string}): MarketRow[]`, `getMarketBySymbol(db, symbol: string): MarketRow | undefined`
  - `cluster.ts`: `addCluster(db, key, name, notes, now): ClusterRow`, `listClusters(db): ClusterRow[]`, `getClusterByKey(db, key): ClusterRow | undefined`, `requireClusterByKey(db, key): ClusterRow`, `setClusterParam(db, clusterId, key, value): void`, `getClusterParams(db, clusterId: number | null): Record<string, number>`, `getGlobalParams(db): Record<string, number>`, `removeCluster(db, key): void`
  - `asset.ts`: `ASSET_CLASSES` (readonly tuple), `addAsset(db, symbol, cls, clusterKey, notes, now): AssetRow`, `listAssets(db, filters): AssetRow[]`, `getAssetBySymbol(db, symbol): AssetRow | undefined`, `requireAssetBySymbol(db, symbol): AssetRow`, `updateAsset(db, symbol, patch): AssetRow`, `setAssetActive(db, symbol, active: boolean): AssetRow`, `removeAsset(db, symbol): void`, `eligibleAssets(db): AssetRow[]`
  - `AssetRow` = `{ id: number; market_id: number; symbol: string; class: string; cluster_id: number | null; cluster_key: string | null; active: number; notes: string | null; added_at: string; lighter_status: string }`

`eligibleAssets` returns assets where `asset.active = 1 AND market.status = 'active'`, **unioned with any asset carrying an open trade** — per the spec's coverage eligibility rule.

- [ ] **Step 1: Write the failing test**

Create `src/db/repo/roster.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../connect.ts";
import { migrate } from "../migrate.ts";
import { upsertMarkets, listMarkets } from "./market.ts";
import { addCluster, setClusterParam, getClusterParams, getGlobalParams, removeCluster } from "./cluster.ts";
import { addAsset, listAssets, updateAsset, setAssetActive, eligibleAssets, requireAssetBySymbol } from "./asset.ts";
import type { MarketInfo } from "../../lighter/client.ts";

const NOW = "2026-07-31T12:00:00Z";

const market = (symbol: string, id: number, status = "active"): MarketInfo => ({
  symbol, market_id: id, market_type: "perp", status,
  price_decimals: 2, size_decimals: 4, listed_at: "2025-01-01",
});

function fresh() {
  const db = openDb(":memory:");
  migrate(db);
  upsertMarkets(db, [market("BTC", 1), market("ETH", 2), market("OLDCOIN", 3, "inactive")], NOW);
  return db;
}

test("upsertMarkets inserts then updates without duplicating", () => {
  const db = fresh();
  assert.equal(listMarkets(db, {}).length, 3);
  upsertMarkets(db, [market("BTC", 1, "inactive")], NOW);
  assert.equal(listMarkets(db, {}).length, 3, "same market_id must not duplicate");
  assert.equal(listMarkets(db, { search: "BTC" })[0]!.status, "inactive", "status must update");
  db.close();
});

test("listMarkets filters by search and status", () => {
  const db = fresh();
  assert.equal(listMarkets(db, { status: "active" }).length, 2);
  assert.equal(listMarkets(db, { search: "eth" }).length, 1, "search is case-insensitive");
  db.close();
});

test("addAsset requires a known market", () => {
  const db = fresh();
  assert.throws(
    () => addAsset(db, "NOPE", "crypto", null, null, NOW),
    (e: Error & { code?: string }) => e.code === "NOT_FOUND",
  );
  db.close();
});

test("addAsset rejects a duplicate symbol", () => {
  const db = fresh();
  addAsset(db, "BTC", "crypto", null, null, NOW);
  assert.throws(
    () => addAsset(db, "BTC", "crypto", null, null, NOW),
    (e: Error & { code?: string }) => e.code === "ALREADY_EXISTS",
  );
  db.close();
});

test("an asset joins at most one cluster and reports its key", () => {
  const db = fresh();
  addCluster(db, "majors", "Majors", null, NOW);
  const a = addAsset(db, "BTC", "crypto", "majors", null, NOW);
  assert.equal(a.cluster_key, "majors");
  addCluster(db, "alts", "Alts", null, NOW);
  assert.equal(updateAsset(db, "BTC", { clusterKey: "alts" }).cluster_key, "alts");
  db.close();
});

test("removing a cluster detaches its assets rather than deleting them", () => {
  const db = fresh();
  addCluster(db, "majors", "Majors", null, NOW);
  addAsset(db, "BTC", "crypto", "majors", null, NOW);
  removeCluster(db, "majors");
  assert.equal(requireAssetBySymbol(db, "BTC").cluster_id, null);
  db.close();
});

test("cluster params fall back to global", () => {
  const db = fresh();
  const c = addCluster(db, "majors", "Majors", null, NOW);
  setClusterParam(db, c.id, "conv_add", 9);
  setClusterParam(db, null, "conv_hold", 5);
  assert.deepEqual(getClusterParams(db, c.id), { conv_add: 9 });
  assert.deepEqual(getGlobalParams(db), { conv_hold: 5 });
  assert.deepEqual(getClusterParams(db, null), {}, "no cluster means no cluster params");
  db.close();
});

test("setClusterParam overwrites an existing value", () => {
  const db = fresh();
  const c = addCluster(db, "majors", "Majors", null, NOW);
  setClusterParam(db, c.id, "conv_add", 9);
  setClusterParam(db, c.id, "conv_add", 8);
  assert.deepEqual(getClusterParams(db, c.id), { conv_add: 8 });
  db.close();
});

test("eligibleAssets excludes inactive roster entries and delisted markets", () => {
  const db = fresh();
  addAsset(db, "BTC", "crypto", null, null, NOW);
  addAsset(db, "ETH", "crypto", null, null, NOW);
  addAsset(db, "OLDCOIN", "crypto", null, null, NOW);
  assert.deepEqual(eligibleAssets(db).map((a) => a.symbol).sort(), ["BTC", "ETH"]);

  setAssetActive(db, "ETH", false);
  assert.deepEqual(eligibleAssets(db).map((a) => a.symbol), ["BTC"]);
  db.close();
});

test("eligibleAssets still includes an ineligible asset that holds an open trade", () => {
  const db = fresh();
  addAsset(db, "OLDCOIN", "crypto", null, null, NOW);
  const a = requireAssetBySymbol(db, "OLDCOIN");
  db.prepare(
    `INSERT INTO trade (asset_id,direction,status,opened_on,initial_price,initial_stop,initial_risk,created_at)
     VALUES (?,'long','open','2026-07-31',100,90,10,?)`,
  ).run(a.id, NOW);
  assert.deepEqual(eligibleAssets(db).map((s) => s.symbol), ["OLDCOIN"]);
  db.close();
});

test("listAssets filters by active, class, and cluster", () => {
  const db = fresh();
  addCluster(db, "majors", "Majors", null, NOW);
  addAsset(db, "BTC", "crypto", "majors", null, NOW);
  addAsset(db, "ETH", "crypto", null, null, NOW);
  setAssetActive(db, "ETH", false);
  assert.equal(listAssets(db, { active: true }).length, 1);
  assert.equal(listAssets(db, { active: false }).length, 1);
  assert.equal(listAssets(db, { clusterKey: "majors" }).length, 1);
  assert.equal(listAssets(db, { cls: "crypto" }).length, 2);
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec node --test src/db/repo/roster.test.ts`
Expected: FAIL — cannot find module `./market.ts`.

- [ ] **Step 3: Write the market repo**

Create `src/db/repo/market.ts`:

```ts
import type { DatabaseSync } from "node:sqlite";
import type { MarketInfo } from "../../lighter/client.ts";

export type MarketRow = {
  market_id: number;
  symbol: string;
  market_type: string;
  status: string;
  price_decimals: number;
  size_decimals: number;
  listed_at: string;
  synced_at: string;
};

export function upsertMarkets(db: DatabaseSync, markets: MarketInfo[], syncedAt: string): number {
  const stmt = db.prepare(`
    INSERT INTO market (market_id, symbol, market_type, status, price_decimals, size_decimals, listed_at, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(market_id) DO UPDATE SET
      symbol = excluded.symbol, market_type = excluded.market_type, status = excluded.status,
      price_decimals = excluded.price_decimals, size_decimals = excluded.size_decimals,
      listed_at = excluded.listed_at, synced_at = excluded.synced_at
  `);
  db.exec("BEGIN");
  try {
    for (const m of markets) {
      stmt.run(m.market_id, m.symbol, m.market_type, m.status, m.price_decimals, m.size_decimals, m.listed_at, syncedAt);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return markets.length;
}

export function listMarkets(
  db: DatabaseSync,
  opts: { search?: string | undefined; status?: string | undefined },
): MarketRow[] {
  const where: string[] = [];
  const args: string[] = [];
  if (opts.search !== undefined) {
    where.push("symbol LIKE ?");
    args.push(`%${opts.search.toUpperCase()}%`);
  }
  if (opts.status !== undefined) {
    where.push("status = ?");
    args.push(opts.status);
  }
  const sql = `SELECT * FROM market ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY symbol`;
  return db.prepare(sql).all(...args) as MarketRow[];
}

export function getMarketBySymbol(db: DatabaseSync, symbol: string): MarketRow | undefined {
  return db.prepare("SELECT * FROM market WHERE symbol = ?").get(symbol) as MarketRow | undefined;
}
```

Note: SQLite's `LIKE` is case-insensitive for ASCII by default, and symbols are stored uppercase, so upper-casing the needle is enough.

- [ ] **Step 4: Write the cluster repo**

Create `src/db/repo/cluster.ts`:

```ts
import type { DatabaseSync } from "node:sqlite";
import { JanusError } from "../../output.ts";

export type ClusterRow = {
  id: number;
  key: string;
  name: string;
  notes: string | null;
  created_at: string;
};

export function addCluster(
  db: DatabaseSync,
  key: string,
  name: string,
  notes: string | null,
  now: string,
): ClusterRow {
  if (getClusterByKey(db, key) !== undefined) {
    throw new JanusError("ALREADY_EXISTS", `cluster ${key} already exists`);
  }
  db.prepare("INSERT INTO cluster (key, name, notes, created_at) VALUES (?, ?, ?, ?)").run(
    key, name, notes, now,
  );
  return requireClusterByKey(db, key);
}

export function listClusters(db: DatabaseSync): ClusterRow[] {
  return db.prepare("SELECT * FROM cluster ORDER BY key").all() as ClusterRow[];
}

export function getClusterByKey(db: DatabaseSync, key: string): ClusterRow | undefined {
  return db.prepare("SELECT * FROM cluster WHERE key = ?").get(key) as ClusterRow | undefined;
}

export function requireClusterByKey(db: DatabaseSync, key: string): ClusterRow {
  const row = getClusterByKey(db, key);
  if (row === undefined) throw new JanusError("NOT_FOUND", `no cluster ${key}`);
  return row;
}

/** A null clusterId targets the global_param table. */
export function setClusterParam(
  db: DatabaseSync,
  clusterId: number | null,
  key: string,
  value: number,
): void {
  if (clusterId === null) {
    db.prepare(
      "INSERT INTO global_param (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(key, value);
    return;
  }
  db.prepare(
    `INSERT INTO cluster_param (cluster_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT(cluster_id, key) DO UPDATE SET value = excluded.value`,
  ).run(clusterId, key, value);
}

function toMap(rows: unknown[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows as { key: string; value: number }[]) out[r.key] = r.value;
  return out;
}

export function getClusterParams(db: DatabaseSync, clusterId: number | null): Record<string, number> {
  if (clusterId === null) return {};
  return toMap(db.prepare("SELECT key, value FROM cluster_param WHERE cluster_id = ?").all(clusterId));
}

export function getGlobalParams(db: DatabaseSync): Record<string, number> {
  return toMap(db.prepare("SELECT key, value FROM global_param").all());
}

export function removeCluster(db: DatabaseSync, key: string): void {
  const row = requireClusterByKey(db, key);
  db.prepare("DELETE FROM cluster WHERE id = ?").run(row.id);
}
```

Assets detach automatically — `asset.cluster_id` is `ON DELETE SET NULL`.

- [ ] **Step 5: Write the asset repo**

Create `src/db/repo/asset.ts`:

```ts
import type { DatabaseSync } from "node:sqlite";
import { JanusError } from "../../output.ts";
import { getMarketBySymbol } from "./market.ts";
import { requireClusterByKey } from "./cluster.ts";

export const ASSET_CLASSES = ["crypto", "equity", "etf", "commodity", "fx", "index"] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];

export type AssetRow = {
  id: number;
  market_id: number;
  symbol: string;
  class: string;
  cluster_id: number | null;
  cluster_key: string | null;
  active: number;
  notes: string | null;
  added_at: string;
  lighter_status: string;
};

const SELECT = `
  SELECT a.*, c.key AS cluster_key, m.status AS lighter_status
  FROM asset a
  JOIN market m ON m.market_id = a.market_id
  LEFT JOIN cluster c ON c.id = a.cluster_id
`;

export function getAssetBySymbol(db: DatabaseSync, symbol: string): AssetRow | undefined {
  return db.prepare(`${SELECT} WHERE a.symbol = ?`).get(symbol) as AssetRow | undefined;
}

export function requireAssetBySymbol(db: DatabaseSync, symbol: string): AssetRow {
  const row = getAssetBySymbol(db, symbol);
  if (row === undefined) throw new JanusError("NOT_FOUND", `no asset ${symbol} in the roster`);
  return row;
}

export function addAsset(
  db: DatabaseSync,
  symbol: string,
  cls: string,
  clusterKey: string | null,
  notes: string | null,
  now: string,
): AssetRow {
  if (getAssetBySymbol(db, symbol) !== undefined) {
    throw new JanusError("ALREADY_EXISTS", `${symbol} is already in the roster`);
  }
  const market = getMarketBySymbol(db, symbol);
  if (market === undefined) {
    throw new JanusError("NOT_FOUND", `no Lighter market ${symbol}; run "janus market sync" first`);
  }
  const clusterId = clusterKey === null ? null : requireClusterByKey(db, clusterKey).id;
  db.prepare(
    "INSERT INTO asset (market_id, symbol, class, cluster_id, active, notes, added_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
  ).run(market.market_id, symbol, cls, clusterId, notes, now);
  return requireAssetBySymbol(db, symbol);
}

export function listAssets(
  db: DatabaseSync,
  filters: { active?: boolean | undefined; cls?: string | undefined; clusterKey?: string | undefined },
): AssetRow[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (filters.active !== undefined) {
    where.push("a.active = ?");
    args.push(filters.active ? 1 : 0);
  }
  if (filters.cls !== undefined) {
    where.push("a.class = ?");
    args.push(filters.cls);
  }
  if (filters.clusterKey !== undefined) {
    where.push("c.key = ?");
    args.push(filters.clusterKey);
  }
  const sql = `${SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY a.symbol`;
  return db.prepare(sql).all(...args) as AssetRow[];
}

export function updateAsset(
  db: DatabaseSync,
  symbol: string,
  patch: { cls?: string | undefined; clusterKey?: string | undefined; notes?: string | undefined },
): AssetRow {
  const asset = requireAssetBySymbol(db, symbol);
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  if (patch.cls !== undefined) {
    sets.push("class = ?");
    args.push(patch.cls);
  }
  if (patch.clusterKey !== undefined) {
    sets.push("cluster_id = ?");
    args.push(patch.clusterKey === "" ? null : requireClusterByKey(db, patch.clusterKey).id);
  }
  if (patch.notes !== undefined) {
    sets.push("notes = ?");
    args.push(patch.notes);
  }
  if (sets.length === 0) throw new JanusError("VALIDATION", "nothing to update; pass --cluster, --class, or --notes");
  args.push(asset.id);
  db.prepare(`UPDATE asset SET ${sets.join(", ")} WHERE id = ?`).run(...args);
  return requireAssetBySymbol(db, symbol);
}

export function setAssetActive(db: DatabaseSync, symbol: string, active: boolean): AssetRow {
  const asset = requireAssetBySymbol(db, symbol);
  db.prepare("UPDATE asset SET active = ? WHERE id = ?").run(active ? 1 : 0, asset.id);
  return requireAssetBySymbol(db, symbol);
}

export function removeAsset(db: DatabaseSync, symbol: string): void {
  const asset = requireAssetBySymbol(db, symbol);
  db.prepare("DELETE FROM asset WHERE id = ?").run(asset.id);
}

/**
 * Coverage eligibility: active roster entries on live markets, plus anything
 * carrying an open trade so a held position cannot go dark.
 */
export function eligibleAssets(db: DatabaseSync): AssetRow[] {
  return db
    .prepare(
      `${SELECT}
       WHERE (a.active = 1 AND m.status = 'active')
          OR a.id IN (SELECT asset_id FROM trade WHERE status = 'open')
       ORDER BY a.symbol`,
    )
    .all() as AssetRow[];
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm exec node --test src/db/repo/roster.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 7: Commit the repos**

```bash
git add src/db/repo/
git commit -m "feat: market, cluster, and asset repositories"
```

- [ ] **Step 8: Write the three command modules**

Create `src/cli/market.ts`:

```ts
import { parseArgs } from "node:util";
import { openDb } from "../db/connect.ts";
import { upsertMarkets, listMarkets } from "../db/repo/market.ts";
import { createLighterClient } from "../lighter/client.ts";
import { nowIso } from "../domain/session.ts";
import { JanusError } from "../output.ts";

export async function handle(verb: string | undefined, argv: string[]): Promise<unknown> {
  const db = openDb();
  try {
    if (verb === "sync") {
      const markets = await createLighterClient().fetchMarkets();
      const synced_at = nowIso();
      return { synced: upsertMarkets(db, markets, synced_at), synced_at };
    }
    if (verb === "list") {
      const { values } = parseArgs({
        args: argv,
        options: { search: { type: "string" }, status: { type: "string" } },
      });
      const markets = listMarkets(db, { search: values.search, status: values.status });
      return { count: markets.length, markets };
    }
    throw new JanusError("VALIDATION", `unknown verb "${verb}" for market; try: sync, list`);
  } finally {
    db.close();
  }
}
```

Create `src/cli/cluster.ts`:

```ts
import { parseArgs } from "node:util";
import { openDb } from "../db/connect.ts";
import {
  addCluster, listClusters, requireClusterByKey, setClusterParam,
  getClusterParams, getGlobalParams, removeCluster,
} from "../db/repo/cluster.ts";
import { listAssets } from "../db/repo/asset.ts";
import { resolveParams } from "../domain/params.ts";
import { nowIso } from "../domain/session.ts";
import { readText, required } from "./args.ts";
import { JanusError } from "../output.ts";

export async function handle(verb: string | undefined, argv: string[]): Promise<unknown> {
  const db = openDb();
  try {
    if (verb === "add") {
      const [key, ...rest] = argv;
      const { values } = parseArgs({
        args: rest,
        options: { name: { type: "string" }, notes: { type: "string" } },
      });
      return addCluster(
        db,
        required(key, "key"),
        required(values.name, "name"),
        readText(values.notes) ?? null,
        nowIso(),
      );
    }
    if (verb === "list") {
      const clusters = listClusters(db);
      return { count: clusters.length, clusters };
    }
    if (verb === "show") {
      const cluster = requireClusterByKey(db, required(argv[0], "key"));
      return {
        cluster,
        params: getClusterParams(db, cluster.id),
        resolved: resolveParams(getClusterParams(db, cluster.id), getGlobalParams(db)),
        assets: listAssets(db, { clusterKey: cluster.key }).map((a) => a.symbol),
      };
    }
    if (verb === "set-param") {
      const [key, param, raw] = argv;
      const cluster = requireClusterByKey(db, required(key, "key"));
      const value = Number(required(raw, "value"));
      if (!Number.isFinite(value)) throw new JanusError("VALIDATION", `value must be a number, got ${raw}`);
      setClusterParam(db, cluster.id, required(param, "param"), value);
      return { cluster: cluster.key, params: getClusterParams(db, cluster.id) };
    }
    if (verb === "rm") {
      removeCluster(db, required(argv[0], "key"));
      return { removed: argv[0] };
    }
    throw new JanusError("VALIDATION", `unknown verb "${verb}" for cluster; try: add, list, show, set-param, rm`);
  } finally {
    db.close();
  }
}
```

Create `src/cli/asset.ts`:

```ts
import { parseArgs } from "node:util";
import { openDb } from "../db/connect.ts";
import {
  ASSET_CLASSES, addAsset, listAssets, requireAssetBySymbol,
  updateAsset, setAssetActive, removeAsset,
} from "../db/repo/asset.ts";
import { nowIso } from "../domain/session.ts";
import { readText, required, oneOf } from "./args.ts";
import { JanusError } from "../output.ts";

export async function handle(verb: string | undefined, argv: string[]): Promise<unknown> {
  const db = openDb();
  try {
    const [symbol, ...rest] = argv;

    if (verb === "add") {
      const { values } = parseArgs({
        args: rest,
        options: { class: { type: "string" }, cluster: { type: "string" }, notes: { type: "string" } },
      });
      return addAsset(
        db,
        required(symbol, "symbol").toUpperCase(),
        oneOf(values.class, "class", ASSET_CLASSES),
        values.cluster ?? null,
        readText(values.notes) ?? null,
        nowIso(),
      );
    }
    if (verb === "list") {
      const { values } = parseArgs({
        args: argv,
        options: {
          active: { type: "boolean" }, inactive: { type: "boolean" },
          cluster: { type: "string" }, class: { type: "string" },
        },
      });
      const active = values.active === true ? true : values.inactive === true ? false : undefined;
      const assets = listAssets(db, { active, cls: values.class, clusterKey: values.cluster });
      return { count: assets.length, assets };
    }
    if (verb === "show") {
      return requireAssetBySymbol(db, required(symbol, "symbol").toUpperCase());
    }
    if (verb === "set") {
      const { values } = parseArgs({
        args: rest,
        options: { cluster: { type: "string" }, class: { type: "string" }, notes: { type: "string" } },
      });
      if (values.class !== undefined) oneOf(values.class, "class", ASSET_CLASSES);
      return updateAsset(db, required(symbol, "symbol").toUpperCase(), {
        cls: values.class,
        clusterKey: values.cluster,
        notes: readText(values.notes),
      });
    }
    if (verb === "activate" || verb === "deactivate") {
      return setAssetActive(db, required(symbol, "symbol").toUpperCase(), verb === "activate");
    }
    if (verb === "rm") {
      removeAsset(db, required(symbol, "symbol").toUpperCase());
      return { removed: symbol };
    }
    throw new JanusError(
      "VALIDATION",
      `unknown verb "${verb}" for asset; try: add, list, show, set, activate, deactivate, rm`,
    );
  } finally {
    db.close();
  }
}
```

Register all three in `src/cli.ts`'s `NOUNS`:

```ts
  market: () => import("./cli/market.ts"),
  cluster: () => import("./cli/cluster.ts"),
  asset: () => import("./cli/asset.ts"),
```

Note: `--cluster ""` on `asset set` detaches the asset — `updateAsset` maps an empty string to `null`.

- [ ] **Step 9: Verify against the live API**

```bash
export JANUS_DB=/tmp/janus-roster.db
pnpm exec node src/cli.ts init
pnpm exec node src/cli.ts market sync                       # expect {"ok":true,"data":{"synced":228,...}}
pnpm exec node src/cli.ts market list --search BTC
pnpm exec node src/cli.ts cluster add majors --name "Majors"
pnpm exec node src/cli.ts cluster set-param majors conv_add 8
pnpm exec node src/cli.ts asset add BTC --class crypto --cluster majors
pnpm exec node src/cli.ts asset add SPY --class etf
pnpm exec node src/cli.ts asset list --active
pnpm exec node src/cli.ts cluster show majors                # resolved params show conv_add: 8
pnpm exec node src/cli.ts asset deactivate SPY
pnpm exec node src/cli.ts asset list --inactive
pnpm exec node src/cli.ts asset add NOSUCHTHING --class crypto   # expect NOT_FOUND, exit 1
rm -f /tmp/janus-roster.db*; unset JANUS_DB
```

- [ ] **Step 10: Commit**

```bash
git add src/cli/ src/cli.ts
git commit -m "feat: market, cluster, and asset commands"
```

---

### Task 12: Session repository and status command

**Files:**
- Create: `src/db/repo/session.ts`, `src/db/repo/session.test.ts`, `src/cli/session.ts`
- Modify: `src/cli.ts` (register `session`)

**Interfaces:**
- Consumes: `SessionRow`, `Phase`, `PHASES`, `nextPhase`, `todayNY`, `nowIso` from `src/domain/session.ts`; `eligibleAssets` from `src/db/repo/asset.ts`.
- Produces: `ensureSession(db, date: string, now: string): SessionRow` (creates if absent), `getSession(db, date): SessionRow | undefined`, `requireSession(db, date): SessionRow` (throws `SESSION_MISSING`), `resolveSession(db, dateFlag: string | undefined, now: string): SessionRow` (with `--date` requires an existing session; without, creates today's), `listSessions(db, limit: number): SessionRow[]`, `stampPhase(db, date: string, phase: Phase, at: string): void`.

- [ ] **Step 1: Write the failing test**

Create `src/db/repo/session.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../connect.ts";
import { migrate } from "../migrate.ts";
import { ensureSession, getSession, requireSession, resolveSession, listSessions, stampPhase } from "./session.ts";

const NOW = "2026-07-31T12:00:00Z";

function fresh() {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

test("ensureSession creates a session then returns the same one", () => {
  const db = fresh();
  const a = ensureSession(db, "2026-07-31", NOW);
  const b = ensureSession(db, "2026-07-31", "2026-07-31T18:00:00Z");
  assert.equal(a.session_date, "2026-07-31");
  assert.equal(b.opened_at, NOW, "opened_at must not be overwritten");
  assert.equal(listSessions(db, 10).length, 1);
  db.close();
});

test("a new session has every phase timestamp null", () => {
  const db = fresh();
  const s = ensureSession(db, "2026-07-31", NOW);
  assert.deepEqual(
    [s.regime_at, s.cluster_read_at, s.coverage_at, s.screen_at, s.score_at],
    [null, null, null, null, null],
  );
  db.close();
});

test("stampPhase records completion", () => {
  const db = fresh();
  ensureSession(db, "2026-07-31", NOW);
  stampPhase(db, "2026-07-31", "regime", NOW);
  assert.equal(requireSession(db, "2026-07-31").regime_at, NOW);
  db.close();
});

test("requireSession throws SESSION_MISSING for an unknown date", () => {
  const db = fresh();
  assert.throws(
    () => requireSession(db, "1999-01-01"),
    (e: Error & { code?: string }) => e.code === "SESSION_MISSING",
  );
  db.close();
});

test("resolveSession without --date creates today's session", () => {
  const db = fresh();
  const s = resolveSession(db, undefined, NOW);
  assert.equal(getSession(db, s.session_date)?.session_date, s.session_date);
  db.close();
});

test("resolveSession with --date requires the session to exist already", () => {
  const db = fresh();
  assert.throws(
    () => resolveSession(db, "2026-01-01", NOW),
    (e: Error & { code?: string }) => e.code === "SESSION_MISSING",
  );
  ensureSession(db, "2026-01-01", NOW);
  assert.equal(resolveSession(db, "2026-01-01", NOW).session_date, "2026-01-01");
  db.close();
});

test("listSessions returns newest first and honours the limit", () => {
  const db = fresh();
  ensureSession(db, "2026-07-29", NOW);
  ensureSession(db, "2026-07-31", NOW);
  ensureSession(db, "2026-07-30", NOW);
  assert.deepEqual(listSessions(db, 2).map((s) => s.session_date), ["2026-07-31", "2026-07-30"]);
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec node --test src/db/repo/session.test.ts`
Expected: FAIL — cannot find module `./session.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/db/repo/session.ts`:

```ts
import type { DatabaseSync } from "node:sqlite";
import { JanusError } from "../../output.ts";
import { phaseColumn, todayNY } from "../../domain/session.ts";
import type { Phase, SessionRow } from "../../domain/session.ts";

export function getSession(db: DatabaseSync, date: string): SessionRow | undefined {
  return db.prepare("SELECT * FROM session WHERE session_date = ?").get(date) as SessionRow | undefined;
}

export function requireSession(db: DatabaseSync, date: string): SessionRow {
  const row = getSession(db, date);
  if (row === undefined) throw new JanusError("SESSION_MISSING", `no session for ${date}`);
  return row;
}

export function ensureSession(db: DatabaseSync, date: string, now: string): SessionRow {
  db.prepare("INSERT OR IGNORE INTO session (session_date, opened_at) VALUES (?, ?)").run(date, now);
  return requireSession(db, date);
}

/**
 * `--date` addresses an existing session and never creates one. Omitting it
 * targets today, creating the session on demand — there is no separate open step.
 */
export function resolveSession(
  db: DatabaseSync,
  dateFlag: string | undefined,
  now: string,
): SessionRow {
  if (dateFlag !== undefined) return requireSession(db, dateFlag);
  return ensureSession(db, todayNY(new Date(now)), now);
}

export function listSessions(db: DatabaseSync, limit: number): SessionRow[] {
  return db
    .prepare("SELECT * FROM session ORDER BY session_date DESC LIMIT ?")
    .all(limit) as SessionRow[];
}

export function stampPhase(db: DatabaseSync, date: string, phase: Phase, at: string): void {
  // phaseColumn returns one of five fixed literals, so interpolation is safe here.
  db.prepare(`UPDATE session SET ${phaseColumn(phase)} = ? WHERE session_date = ?`).run(at, date);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec node --test src/db/repo/session.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Write the session command**

Create `src/cli/session.ts`:

```ts
import { parseArgs } from "node:util";
import { openDb } from "../db/connect.ts";
import { getSession, listSessions } from "../db/repo/session.ts";
import { eligibleAssets } from "../db/repo/asset.ts";
import { nextPhase, todayNY, PHASES } from "../domain/session.ts";
import { JanusError } from "../output.ts";

export async function handle(verb: string | undefined, argv: string[]): Promise<unknown> {
  const db = openDb();
  try {
    if (verb === "status") {
      const { values } = parseArgs({ args: argv, options: { date: { type: "string" } } });
      const date = values.date ?? todayNY();
      const session = getSession(db, date);
      if (session === undefined) {
        return { session_date: date, exists: false, next_phase: "regime", eligible_assets: eligibleAssets(db).length };
      }
      const counts = db.prepare(
        `SELECT
           (SELECT COUNT(*) FROM coverage WHERE session_date = ?1) AS coverage,
           (SELECT COUNT(*) FROM screen   WHERE session_date = ?1) AS screened,
           (SELECT COUNT(*) FROM screen   WHERE session_date = ?1 AND flagged = 1) AS flagged,
           (SELECT COUNT(*) FROM score    WHERE session_date = ?1) AS scored`,
      ).get(date);
      return {
        session_date: date,
        exists: true,
        phases: Object.fromEntries(PHASES.map((p) => [p, session[`${p}_at` as keyof typeof session]])),
        next_phase: nextPhase(session),
        eligible_assets: eligibleAssets(db).length,
        counts,
      };
    }
    if (verb === "list") {
      const { values } = parseArgs({ args: argv, options: { limit: { type: "string" } } });
      const limit = Number(values.limit ?? 20);
      if (!Number.isInteger(limit) || limit < 1) {
        throw new JanusError("VALIDATION", `--limit must be a positive integer, got ${values.limit}`);
      }
      const sessions = listSessions(db, limit);
      return { count: sessions.length, sessions };
    }
    throw new JanusError("VALIDATION", `unknown verb "${verb}" for session; try: status, list`);
  } finally {
    db.close();
  }
}
```

Register in `src/cli.ts`: `session: () => import("./cli/session.ts"),`

- [ ] **Step 6: Verify**

```bash
export JANUS_DB=/tmp/janus-session.db
pnpm exec node src/cli.ts init
pnpm exec node src/cli.ts session status      # exists:false, next_phase:"regime"
pnpm exec node src/cli.ts session list        # empty
rm -f /tmp/janus-session.db*; unset JANUS_DB
```

- [ ] **Step 7: Commit**

```bash
git add src/db/repo/session.ts src/db/repo/session.test.ts src/cli/session.ts src/cli.ts
git commit -m "feat: session repository and status command"
```

---

### Task 13: Regime read and cluster read

**Files:**
- Create: `src/db/repo/phase.ts`, `src/db/repo/phase.test.ts`, `src/cli/regime.ts`, `src/cli/cluster-read.ts`
- Modify: `src/cli.ts` (register `regime`, `cluster-read`)

**Interfaces:**
- Consumes: `resolveSession`, `stampPhase`, `assertPhaseOrder`, `nowIso`, `requireClusterByKey`.
- Produces: `recordRegime(db, date, input, now): void` where `input` is `{ state: string; score: number; confidence: number; summary: string; metrics: Record<string, number> }`; `getRegime(db, date): unknown`; `recordClusterRead(db, date, clusterId: number, bias: number, judgement: string, now: string): void`; `listClusterReads(db, date): unknown[]`.

- [ ] **Step 1: Write the failing test**

Create `src/db/repo/phase.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../connect.ts";
import { migrate } from "../migrate.ts";
import { ensureSession } from "./session.ts";
import { addCluster } from "./cluster.ts";
import { recordRegime, getRegime, recordClusterRead, listClusterReads } from "./phase.ts";

const NOW = "2026-07-31T12:00:00Z";
const DATE = "2026-07-31";

function fresh() {
  const db = openDb(":memory:");
  migrate(db);
  ensureSession(db, DATE, NOW);
  return db;
}

const regime = {
  state: "RISK_ON", score: 1.5, confidence: 0.5,
  summary: "breadth improving", metrics: { vix: 14.2, dxy: 99.1 },
};

test("recordRegime stores the read and its metrics", () => {
  const db = fresh();
  recordRegime(db, DATE, regime, NOW);
  const got = getRegime(db, DATE) as { read: { score: number }; metrics: Record<string, number> };
  assert.equal(got.read.score, 1.5);
  assert.deepEqual(got.metrics, { vix: 14.2, dxy: 99.1 });
  db.close();
});

test("re-recording a regime replaces the previous slice entirely", () => {
  const db = fresh();
  recordRegime(db, DATE, regime, NOW);
  recordRegime(db, DATE, { ...regime, score: -1, metrics: { vix: 30 } }, NOW);
  const got = getRegime(db, DATE) as { read: { score: number }; metrics: Record<string, number> };
  assert.equal(got.read.score, -1);
  assert.deepEqual(got.metrics, { vix: 30 }, "stale metrics must not survive");
  db.close();
});

test("the database rejects an out-of-range confidence", () => {
  const db = fresh();
  assert.throws(() => recordRegime(db, DATE, { ...regime, confidence: -0.5 }, NOW), /CHECK/i);
  db.close();
});

test("recordClusterRead is keyed per cluster and overwrites on re-run", () => {
  const db = fresh();
  const c = addCluster(db, "majors", "Majors", null, NOW);
  recordClusterRead(db, DATE, c.id, 1.0, "constructive", NOW);
  recordClusterRead(db, DATE, c.id, -1.0, "rolling over", NOW);
  const reads = listClusterReads(db, DATE) as { bias: number; cluster_key: string }[];
  assert.equal(reads.length, 1);
  assert.equal(reads[0]!.bias, -1.0);
  assert.equal(reads[0]!.cluster_key, "majors");
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec node --test src/db/repo/phase.test.ts`
Expected: FAIL — cannot find module `./phase.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/db/repo/phase.ts`:

```ts
import type { DatabaseSync } from "node:sqlite";

export type RegimeInput = {
  state: string;
  score: number;
  confidence: number;
  summary: string;
  metrics: Record<string, number>;
};

/** Replaces the whole regime slice for the date so stale metrics cannot survive a re-run. */
export function recordRegime(
  db: DatabaseSync,
  date: string,
  input: RegimeInput,
  now: string,
): void {
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM regime_metric WHERE session_date = ?").run(date);
    db.prepare(
      `INSERT INTO regime_read (session_date, state, score, confidence, summary, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_date) DO UPDATE SET
         state = excluded.state, score = excluded.score, confidence = excluded.confidence,
         summary = excluded.summary, recorded_at = excluded.recorded_at`,
    ).run(date, input.state, input.score, input.confidence, input.summary, now);
    const metric = db.prepare(
      "INSERT INTO regime_metric (session_date, key, value_num) VALUES (?, ?, ?)",
    );
    for (const [key, value] of Object.entries(input.metrics)) metric.run(date, key, value);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function getRegime(db: DatabaseSync, date: string): unknown {
  const read = db.prepare("SELECT * FROM regime_read WHERE session_date = ?").get(date);
  const rows = db
    .prepare("SELECT key, value_num FROM regime_metric WHERE session_date = ? ORDER BY key")
    .all(date) as { key: string; value_num: number }[];
  const metrics: Record<string, number> = {};
  for (const r of rows) metrics[r.key] = r.value_num;
  return { read, metrics };
}

export function recordClusterRead(
  db: DatabaseSync,
  date: string,
  clusterId: number,
  bias: number,
  judgement: string,
  now: string,
): void {
  db.prepare(
    `INSERT INTO cluster_read (session_date, cluster_id, bias, judgement, recorded_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session_date, cluster_id) DO UPDATE SET
       bias = excluded.bias, judgement = excluded.judgement, recorded_at = excluded.recorded_at`,
  ).run(date, clusterId, bias, judgement, now);
}

export function listClusterReads(db: DatabaseSync, date: string): unknown[] {
  return db
    .prepare(
      `SELECT cr.*, c.key AS cluster_key, c.name AS cluster_name
       FROM cluster_read cr JOIN cluster c ON c.id = cr.cluster_id
       WHERE cr.session_date = ? ORDER BY c.key`,
    )
    .all(date);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec node --test src/db/repo/phase.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write the command modules**

Create `src/cli/regime.ts`:

```ts
import { parseArgs } from "node:util";
import { openDb } from "../db/connect.ts";
import { resolveSession, stampPhase } from "../db/repo/session.ts";
import { recordRegime, getRegime } from "../db/repo/phase.ts";
import { assertPhaseOrder, nowIso } from "../domain/session.ts";
import { num, oneOf, readText, required, pairs } from "./args.ts";
import { JanusError } from "../output.ts";

const STATES = ["RISK_ON", "NEUTRAL", "RISK_OFF"] as const;

export async function handle(verb: string | undefined, argv: string[]): Promise<unknown> {
  const db = openDb();
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        state: { type: "string" }, score: { type: "string" }, confidence: { type: "string" },
        summary: { type: "string" }, metric: { type: "string", multiple: true },
        date: { type: "string" }, force: { type: "boolean" },
      },
    });

    if (verb === "record") {
      const now = nowIso();
      const session = resolveSession(db, values.date, now);
      assertPhaseOrder(session, "regime", values.force === true);
      recordRegime(db, session.session_date, {
        state: oneOf(values.state, "state", STATES),
        score: num(values.score, "score", -2, 2),
        confidence: num(values.confidence, "confidence", 0, 2),
        summary: required(readText(values.summary), "summary"),
        metrics: pairs(values.metric, "metric"),
      }, now);
      stampPhase(db, session.session_date, "regime", now);
      return { session_date: session.session_date, ...(getRegime(db, session.session_date) as object) };
    }
    if (verb === "show") {
      const session = resolveSession(db, values.date, nowIso());
      return { session_date: session.session_date, ...(getRegime(db, session.session_date) as object) };
    }
    throw new JanusError("VALIDATION", `unknown verb "${verb}" for regime; try: record, show`);
  } finally {
    db.close();
  }
}
```

Create `src/cli/cluster-read.ts`:

```ts
import { parseArgs } from "node:util";
import { openDb } from "../db/connect.ts";
import { resolveSession, stampPhase } from "../db/repo/session.ts";
import { recordClusterRead, listClusterReads } from "../db/repo/phase.ts";
import { requireClusterByKey, listClusters } from "../db/repo/cluster.ts";
import { assertPhaseOrder, nowIso } from "../domain/session.ts";
import { num, readText, required } from "./args.ts";
import { JanusError } from "../output.ts";

export async function handle(verb: string | undefined, argv: string[]): Promise<unknown> {
  const db = openDb();
  try {
    const [key, ...rest] = argv;
    const { values } = parseArgs({
      args: verb === "list" ? argv : rest,
      options: {
        bias: { type: "string" }, judgement: { type: "string" },
        date: { type: "string" }, force: { type: "boolean" },
      },
    });

    if (verb === "record") {
      const now = nowIso();
      const session = resolveSession(db, values.date, now);
      assertPhaseOrder(session, "cluster_read", values.force === true);
      const cluster = requireClusterByKey(db, required(key, "cluster"));
      recordClusterRead(
        db, session.session_date, cluster.id,
        num(values.bias, "bias", -2, 2),
        required(readText(values.judgement), "judgement"),
        now,
      );
      const reads = listClusterReads(db, session.session_date);
      // The phase is complete only once every cluster has been read.
      if (reads.length >= listClusters(db).length) {
        stampPhase(db, session.session_date, "cluster_read", now);
      }
      return {
        session_date: session.session_date,
        recorded: cluster.key,
        read: reads.length,
        of: listClusters(db).length,
      };
    }
    if (verb === "list") {
      const session = resolveSession(db, values.date, nowIso());
      const reads = listClusterReads(db, session.session_date);
      return { session_date: session.session_date, count: reads.length, reads };
    }
    throw new JanusError("VALIDATION", `unknown verb "${verb}" for cluster-read; try: record, list`);
  } finally {
    db.close();
  }
}
```

Register both in `src/cli.ts`:

```ts
  regime: () => import("./cli/regime.ts"),
  "cluster-read": () => import("./cli/cluster-read.ts"),
```

Note: `cluster_read_at` is stamped only once every cluster has a read for the session. A system with no clusters stamps it on the first call, which is correct — there is nothing to read.

- [ ] **Step 6: Verify**

```bash
export JANUS_DB=/tmp/janus-phase.db
pnpm exec node src/cli.ts init && pnpm exec node src/cli.ts market sync
pnpm exec node src/cli.ts cluster add majors --name "Majors"
pnpm exec node src/cli.ts asset add BTC --class crypto --cluster majors
echo "breadth improving, credit calm" | pnpm exec node src/cli.ts regime record \
  --state RISK_ON --score 1.5 --confidence 0.5 --summary - --metric vix=14.2 --metric dxy=99.1
pnpm exec node src/cli.ts session status                     # regime_at set, next_phase cluster_read
pnpm exec node src/cli.ts cluster-read record majors --bias 1.0 --judgement "leadership intact"
pnpm exec node src/cli.ts session status                     # cluster_read_at set, next_phase coverage
pnpm exec node src/cli.ts regime record --state RISK_ON --score 1.5 --confidence 3 --summary x  # VALIDATION
rm -f /tmp/janus-phase.db*; unset JANUS_DB
```

- [ ] **Step 7: Commit**

```bash
git add src/db/repo/phase.ts src/db/repo/phase.test.ts src/cli/regime.ts src/cli/cluster-read.ts src/cli.ts
git commit -m "feat: regime read and cluster read phases"
```

---

### Task 14: Coverage phase

**Files:**
- Create: `src/domain/coverage.ts`, `src/domain/coverage.test.ts`, `src/db/repo/coverage.ts`, `src/db/repo/coverage.test.ts`, `src/cli/coverage.ts`
- Modify: `src/cli.ts` (register `coverage`)

**Interfaces:**
- Consumes: `Bar`, `Snapshot`, `LighterApi`, indicator functions, `eligibleAssets`, `resolveSession`, `stampPhase`, `assertPhaseOrder`.
- Produces:
  - `CoverageValues` — every numeric column of the `coverage` table except `session_date` and `asset_id`.
  - `computeCoverage(bars: Bar[], snapshot: Snapshot, fetchedAt: string): CoverageValues` — pure.
  - `upsertCoverage(db, date: string, rows: {asset_id: number; values: CoverageValues}[]): void` — single transaction.
  - `listCoverage(db, date: string, symbols?: string[]): unknown[]`.

- [ ] **Step 1: Write the failing test for the pure computation**

Create `src/domain/coverage.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCoverage } from "./coverage.ts";
import type { Bar } from "../types.ts";
import type { Snapshot } from "../lighter/client.ts";

const FETCHED = "2026-07-31T12:00:00Z";

const snapshot: Snapshot = {
  mark_price: 101, index_price: 100.5, last_trade_price: 101,
  daily_price_low: 99, daily_price_high: 102, daily_price_change: 1.25, open_interest: 5000,
};

/** A rising series: close goes 100, 101, 102 ... so every MA sits below price. */
const rising = (n: number): Bar[] =>
  Array.from({ length: n }, (_, i) => ({
    t: 1_700_000_000_000 + i * 86_400_000,
    o: 100 + i, h: 101 + i, l: 99 + i, c: 100 + i, v: 10, i: 1000,
  }));

test("uses the last bar for the OHLCV columns", () => {
  const c = computeCoverage(rising(5), snapshot, FETCHED);
  assert.equal(c.close, 104);
  assert.equal(c.high, 105);
  assert.equal(c.low, 103);
  assert.equal(c.bars_available, 5);
  assert.equal(c.fetched_at, FETCHED);
});

test("copies the snapshot fields through", () => {
  const c = computeCoverage(rising(5), snapshot, FETCHED);
  assert.equal(c.mark_price, 101);
  assert.equal(c.index_price, 100.5);
  assert.equal(c.open_interest, 5000);
  assert.equal(c.daily_change_pct, 1.25);
});

test("indicators are null until enough history exists", () => {
  const c = computeCoverage(rising(30), snapshot, FETCHED);
  assert.notEqual(c.sma20, null, "20 bars is enough for sma20");
  assert.equal(c.sma50, null, "30 bars is not enough for sma50");
  assert.equal(c.sma200, null);
  assert.equal(c.px_vs_sma50, null, "distance is null when the ma is null");
  assert.equal(c.cross_50_200, null);
});

test("a full history populates every indicator", () => {
  const c = computeCoverage(rising(250), snapshot, FETCHED);
  for (const k of ["sma20", "sma50", "sma200", "ema12", "ema26", "atr14"] as const) {
    assert.notEqual(c[k], null, `${k} should be computed`);
  }
  assert.equal(c.cross_50_200, "golden", "a rising series keeps sma50 above sma200");
  assert.equal(c.cross_px_50, "above");
  assert.ok(c.px_vs_sma20! > 0, "price above its ma yields a positive distance");
});

test("percentage distance is signed and expressed in percent", () => {
  const c = computeCoverage(rising(250), snapshot, FETCHED);
  // close 349, sma20 = mean(330..349) = 339.5 → (349 - 339.5) / 339.5 * 100
  assert.equal(Number(c.px_vs_sma20!.toFixed(4)), Number((((349 - 339.5) / 339.5) * 100).toFixed(4)));
});

test("an empty bar list is rejected rather than written as a hole", () => {
  assert.throws(
    () => computeCoverage([], snapshot, FETCHED),
    (e: Error & { code?: string }) => e.code === "INSUFFICIENT_HISTORY",
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec node --test src/domain/coverage.test.ts`
Expected: FAIL — cannot find module `./coverage.ts`.

- [ ] **Step 3: Write the pure computation**

Create `src/domain/coverage.ts`:

```ts
import { JanusError } from "../output.ts";
import type { Bar } from "../types.ts";
import type { Snapshot } from "../lighter/client.ts";
import { smaSeries, emaSeries } from "../indicators/ma.ts";
import { atr } from "../indicators/atr.ts";
import { maCross, priceVsMa } from "../indicators/cross.ts";

export type CoverageValues = {
  open: number; high: number; low: number; close: number; volume: number;
  mark_price: number | null; index_price: number | null; open_interest: number | null;
  daily_change_pct: number | null;
  sma20: number | null; sma50: number | null; sma200: number | null;
  ema12: number | null; ema26: number | null; atr14: number | null;
  px_vs_sma20: number | null; px_vs_sma50: number | null; px_vs_sma200: number | null;
  cross_50_200: "golden" | "death" | null; cross_50_200_age: number | null;
  cross_px_50: "above" | "below" | null; cross_px_50_age: number | null;
  bars_available: number; fetched_at: string;
};

const lastOf = (series: (number | null)[]): number | null => series.at(-1) ?? null;

/** Signed percentage distance from price to a moving average. */
const distance = (close: number, ma: number | null): number | null =>
  ma === null || ma === 0 ? null : ((close - ma) / ma) * 100;

export function computeCoverage(bars: Bar[], snapshot: Snapshot, fetchedAt: string): CoverageValues {
  const latest = bars.at(-1);
  if (latest === undefined) {
    throw new JanusError("INSUFFICIENT_HISTORY", "no daily bars returned for this market");
  }

  const closes = bars.map((b) => b.c);
  const sma20s = smaSeries(closes, 20);
  const sma50s = smaSeries(closes, 50);
  const sma200s = smaSeries(closes, 200);
  const cross = maCross(sma50s, sma200s);
  const side = priceVsMa(closes, sma50s);

  const sma20 = lastOf(sma20s);
  const sma50 = lastOf(sma50s);
  const sma200 = lastOf(sma200s);

  return {
    open: latest.o, high: latest.h, low: latest.l, close: latest.c, volume: latest.v,
    mark_price: snapshot.mark_price,
    index_price: snapshot.index_price,
    open_interest: snapshot.open_interest,
    daily_change_pct: snapshot.daily_price_change,
    sma20, sma50, sma200,
    ema12: lastOf(emaSeries(closes, 12)),
    ema26: lastOf(emaSeries(closes, 26)),
    atr14: atr(bars, 14),
    px_vs_sma20: distance(latest.c, sma20),
    px_vs_sma50: distance(latest.c, sma50),
    px_vs_sma200: distance(latest.c, sma200),
    cross_50_200: cross.state,
    cross_50_200_age: cross.age,
    cross_px_50: side.state,
    cross_px_50_age: side.age,
    bars_available: bars.length,
    fetched_at: fetchedAt,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec node --test src/domain/coverage.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Write the coverage repo and its test**

Create `src/db/repo/coverage.ts`:

```ts
import type { DatabaseSync } from "node:sqlite";
import type { CoverageValues } from "../../domain/coverage.ts";

const COLUMNS = [
  "open", "high", "low", "close", "volume",
  "mark_price", "index_price", "open_interest", "daily_change_pct",
  "sma20", "sma50", "sma200", "ema12", "ema26", "atr14",
  "px_vs_sma20", "px_vs_sma50", "px_vs_sma200",
  "cross_50_200", "cross_50_200_age", "cross_px_50", "cross_px_50_age",
  "bars_available", "fetched_at",
] as const;

/** All rows land in one transaction, so an upstream failure never leaves a partial slice. */
export function upsertCoverage(
  db: DatabaseSync,
  date: string,
  rows: { asset_id: number; values: CoverageValues }[],
): void {
  const placeholders = COLUMNS.map(() => "?").join(", ");
  const updates = COLUMNS.map((c) => `${c} = excluded.${c}`).join(", ");
  const stmt = db.prepare(
    `INSERT INTO coverage (session_date, asset_id, ${COLUMNS.join(", ")})
     VALUES (?, ?, ${placeholders})
     ON CONFLICT(session_date, asset_id) DO UPDATE SET ${updates}`,
  );
  db.exec("BEGIN");
  try {
    for (const row of rows) {
      stmt.run(date, row.asset_id, ...COLUMNS.map((c) => row.values[c]));
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function listCoverage(db: DatabaseSync, date: string, symbols?: string[]): unknown[] {
  const filter = symbols === undefined ? "" : `AND a.symbol IN (${symbols.map(() => "?").join(",")})`;
  return db
    .prepare(
      `SELECT a.symbol, a.class, c.* FROM coverage c
       JOIN asset a ON a.id = c.asset_id
       WHERE c.session_date = ? ${filter}
       ORDER BY a.symbol`,
    )
    .all(date, ...(symbols ?? []));
}
```

Create `src/db/repo/coverage.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../connect.ts";
import { migrate } from "../migrate.ts";
import { ensureSession } from "./session.ts";
import { upsertMarkets } from "./market.ts";
import { addAsset, requireAssetBySymbol } from "./asset.ts";
import { upsertCoverage, listCoverage } from "./coverage.ts";
import type { CoverageValues } from "../../domain/coverage.ts";

const NOW = "2026-07-31T12:00:00Z";
const DATE = "2026-07-31";

const values = (close: number): CoverageValues => ({
  open: close, high: close, low: close, close, volume: 1,
  mark_price: close, index_price: close, open_interest: 1, daily_change_pct: 0,
  sma20: null, sma50: null, sma200: null, ema12: null, ema26: null, atr14: null,
  px_vs_sma20: null, px_vs_sma50: null, px_vs_sma200: null,
  cross_50_200: null, cross_50_200_age: null, cross_px_50: null, cross_px_50_age: null,
  bars_available: 3, fetched_at: NOW,
});

function fresh() {
  const db = openDb(":memory:");
  migrate(db);
  ensureSession(db, DATE, NOW);
  upsertMarkets(db, [
    { symbol: "BTC", market_id: 1, market_type: "perp", status: "active", price_decimals: 1, size_decimals: 5, listed_at: "2025-01-01" },
    { symbol: "ETH", market_id: 2, market_type: "perp", status: "active", price_decimals: 2, size_decimals: 4, listed_at: "2025-01-01" },
  ], NOW);
  addAsset(db, "BTC", "crypto", null, null, NOW);
  addAsset(db, "ETH", "crypto", null, null, NOW);
  return db;
}

test("upsertCoverage writes rows and overwrites on re-run", () => {
  const db = fresh();
  const btc = requireAssetBySymbol(db, "BTC").id;
  upsertCoverage(db, DATE, [{ asset_id: btc, values: values(100) }]);
  upsertCoverage(db, DATE, [{ asset_id: btc, values: values(200) }]);
  const rows = listCoverage(db, DATE) as { close: number }[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.close, 200);
  db.close();
});

test("listCoverage filters by symbol", () => {
  const db = fresh();
  upsertCoverage(db, DATE, [
    { asset_id: requireAssetBySymbol(db, "BTC").id, values: values(100) },
    { asset_id: requireAssetBySymbol(db, "ETH").id, values: values(50) },
  ]);
  assert.equal((listCoverage(db, DATE) as unknown[]).length, 2);
  const only = listCoverage(db, DATE, ["ETH"]) as { symbol: string }[];
  assert.deepEqual(only.map((r) => r.symbol), ["ETH"]);
  db.close();
});

test("a failed row rolls the whole batch back", () => {
  const db = fresh();
  const btc = requireAssetBySymbol(db, "BTC").id;
  assert.throws(() =>
    upsertCoverage(db, DATE, [
      { asset_id: btc, values: values(100) },
      { asset_id: 9999, values: values(100) }, // no such asset — FK violation
    ]),
  );
  assert.equal((listCoverage(db, DATE) as unknown[]).length, 0, "nothing may survive a failed batch");
  db.close();
});
```

- [ ] **Step 6: Run the repo test**

Run: `pnpm exec node --test src/db/repo/coverage.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 7: Write the coverage command**

Create `src/cli/coverage.ts`:

```ts
import { parseArgs } from "node:util";
import { openDb } from "../db/connect.ts";
import { resolveSession, stampPhase } from "../db/repo/session.ts";
import { eligibleAssets } from "../db/repo/asset.ts";
import { upsertCoverage, listCoverage } from "../db/repo/coverage.ts";
import { computeCoverage } from "../domain/coverage.ts";
import { createLighterClient } from "../lighter/client.ts";
import { assertPhaseOrder, nowIso } from "../domain/session.ts";
import { csv } from "./args.ts";
import { JanusError } from "../output.ts";
import type { AssetRow } from "../db/repo/asset.ts";

/** Narrow the eligible set to an explicit symbol list, rejecting the whole call on any miss. */
function select(eligible: AssetRow[], symbols: string[] | undefined): AssetRow[] {
  if (symbols === undefined) return eligible;
  const wanted = symbols.map((s) => s.toUpperCase());
  const bySymbol = new Map(eligible.map((a) => [a.symbol, a]));
  const missing = wanted.filter((s) => !bySymbol.has(s));
  if (missing.length > 0) {
    throw new JanusError(
      "VALIDATION",
      `not eligible for coverage: ${missing.join(", ")} (unknown, deactivated, or delisted)`,
    );
  }
  return wanted.map((s) => bySymbol.get(s)!);
}

export async function handle(verb: string | undefined, argv: string[]): Promise<unknown> {
  const db = openDb();
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        asset: { type: "string" }, date: { type: "string" }, force: { type: "boolean" },
      },
    });
    const symbols = csv(values.asset);

    if (verb === "run") {
      const now = nowIso();
      const session = resolveSession(db, values.date, now);
      assertPhaseOrder(session, "coverage", values.force === true);

      const eligible = eligibleAssets(db);
      const targets = select(eligible, symbols);
      const client = createLighterClient();

      const rows: { asset_id: number; values: ReturnType<typeof computeCoverage> }[] = [];
      const skipped: { symbol: string; reason: string }[] = [];
      for (const asset of targets) {
        const [bars, snapshot] = await Promise.all([
          client.fetchDailyBars(asset.market_id),
          client.fetchSnapshot(asset.market_id),
        ]);
        try {
          rows.push({ asset_id: asset.id, values: computeCoverage(bars, snapshot, now) });
        } catch (e) {
          if (e instanceof JanusError && e.code === "INSUFFICIENT_HISTORY") {
            skipped.push({ symbol: asset.symbol, reason: e.message });
            continue;
          }
          throw e;
        }
      }

      upsertCoverage(db, session.session_date, rows);

      // Only a full run that covered every eligible asset completes the phase.
      const full = symbols === undefined && skipped.length === 0;
      if (full) stampPhase(db, session.session_date, "coverage", now);

      return {
        session_date: session.session_date,
        covered: rows.length,
        eligible: eligible.length,
        skipped,
        phase_complete: full,
      };
    }

    if (verb === "list") {
      const session = resolveSession(db, values.date, nowIso());
      const rows = listCoverage(db, session.session_date, symbols);
      return { session_date: session.session_date, count: rows.length, coverage: rows };
    }

    throw new JanusError("VALIDATION", `unknown verb "${verb}" for coverage; try: run, list`);
  } finally {
    db.close();
  }
}
```

Register in `src/cli.ts`: `coverage: () => import("./cli/coverage.ts"),`

- [ ] **Step 8: Verify against the live API**

```bash
export JANUS_DB=/tmp/janus-cov.db
pnpm exec node src/cli.ts init && pnpm exec node src/cli.ts market sync
pnpm exec node src/cli.ts asset add BTC --class crypto
pnpm exec node src/cli.ts asset add SPY --class etf
pnpm exec node src/cli.ts regime record --state NEUTRAL --score 0 --confidence 0.5 --summary "flat"
pnpm exec node src/cli.ts coverage run
```

Expect `covered: 2`, `phase_complete: true`. Then:

```bash
pnpm exec node src/cli.ts coverage list --asset BTC     # sma200 populated, cross_50_200 set
pnpm exec node src/cli.ts coverage run --asset NOSUCH   # VALIDATION naming NOSUCH, exit 1
rm -f /tmp/janus-cov.db*; unset JANUS_DB
```

- [ ] **Step 9: Commit**

```bash
git add src/domain/coverage.ts src/domain/coverage.test.ts src/db/repo/coverage.ts src/db/repo/coverage.test.ts src/cli/coverage.ts src/cli.ts
git commit -m "feat: coverage phase with lighter fetch and indicator computation"
```

---

### Task 15: Screening phase

**Files:**
- Create: `src/db/repo/screen.ts`, `src/db/repo/screen.test.ts`, `src/cli/screen.ts`
- Modify: `src/cli.ts` (register `screen`)

**Interfaces:**
- Consumes: `resolveParams`, `getClusterParams`, `getGlobalParams`, `requireAssetBySymbol`, `resolveSession`, `stampPhase`, `assertPhaseOrder`.
- Produces: `recordScreen(db, date, assetId, {score, confidence, threshold, flagged, rationale}, now): void`, `listScreen(db, date, opts: {flaggedOnly?: boolean}): unknown[]`, `countCoverage(db, date): number`, `countScreened(db, date): number`.

The flag decision is janus's: `flagged = score >= screen_flag_threshold`, with the threshold resolved cluster-first and snapshotted onto the row.

- [ ] **Step 1: Write the failing test**

Create `src/db/repo/screen.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../connect.ts";
import { migrate } from "../migrate.ts";
import { ensureSession } from "./session.ts";
import { upsertMarkets } from "./market.ts";
import { addAsset, requireAssetBySymbol } from "./asset.ts";
import { recordScreen, listScreen, countScreened } from "./screen.ts";

const NOW = "2026-07-31T12:00:00Z";
const DATE = "2026-07-31";

function fresh() {
  const db = openDb(":memory:");
  migrate(db);
  ensureSession(db, DATE, NOW);
  upsertMarkets(db, [
    { symbol: "BTC", market_id: 1, market_type: "perp", status: "active", price_decimals: 1, size_decimals: 5, listed_at: "2025-01-01" },
    { symbol: "ETH", market_id: 2, market_type: "perp", status: "active", price_decimals: 2, size_decimals: 4, listed_at: "2025-01-01" },
  ], NOW);
  addAsset(db, "BTC", "crypto", null, null, NOW);
  addAsset(db, "ETH", "crypto", null, null, NOW);
  return db;
}

test("recordScreen stores the score, threshold, and flag", () => {
  const db = fresh();
  const id = requireAssetBySymbol(db, "BTC").id;
  recordScreen(db, DATE, id, { score: 1.5, confidence: 0.5, threshold: 1.0, flagged: true, rationale: "breakout" }, NOW);
  const rows = listScreen(db, DATE, {}) as { symbol: string; flagged: number; threshold: number }[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.symbol, "BTC");
  assert.equal(rows[0]!.flagged, 1);
  assert.equal(rows[0]!.threshold, 1.0);
  db.close();
});

test("re-recording a screen overwrites it", () => {
  const db = fresh();
  const id = requireAssetBySymbol(db, "BTC").id;
  recordScreen(db, DATE, id, { score: 1.5, confidence: 0.5, threshold: 1.0, flagged: true, rationale: null }, NOW);
  recordScreen(db, DATE, id, { score: 0.2, confidence: 0.5, threshold: 1.0, flagged: false, rationale: null }, NOW);
  const rows = listScreen(db, DATE, {}) as { score: number; flagged: number }[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.score, 0.2);
  assert.equal(rows[0]!.flagged, 0);
  db.close();
});

test("listScreen can return only the flagged rows", () => {
  const db = fresh();
  recordScreen(db, DATE, requireAssetBySymbol(db, "BTC").id,
    { score: 1.5, confidence: 0, threshold: 1, flagged: true, rationale: null }, NOW);
  recordScreen(db, DATE, requireAssetBySymbol(db, "ETH").id,
    { score: 0.1, confidence: 0, threshold: 1, flagged: false, rationale: null }, NOW);
  assert.equal(countScreened(db, DATE), 2);
  const flagged = listScreen(db, DATE, { flaggedOnly: true }) as { symbol: string }[];
  assert.deepEqual(flagged.map((r) => r.symbol), ["BTC"]);
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec node --test src/db/repo/screen.test.ts`
Expected: FAIL — cannot find module `./screen.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/db/repo/screen.ts`:

```ts
import type { DatabaseSync } from "node:sqlite";

export type ScreenInput = {
  score: number;
  confidence: number;
  threshold: number;
  flagged: boolean;
  rationale: string | null;
};

export function recordScreen(
  db: DatabaseSync,
  date: string,
  assetId: number,
  input: ScreenInput,
  now: string,
): void {
  db.prepare(
    `INSERT INTO screen (session_date, asset_id, score, confidence, threshold, flagged, rationale, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_date, asset_id) DO UPDATE SET
       score = excluded.score, confidence = excluded.confidence, threshold = excluded.threshold,
       flagged = excluded.flagged, rationale = excluded.rationale, recorded_at = excluded.recorded_at`,
  ).run(date, assetId, input.score, input.confidence, input.threshold, input.flagged ? 1 : 0, input.rationale, now);
}

export function listScreen(
  db: DatabaseSync,
  date: string,
  opts: { flaggedOnly?: boolean | undefined },
): unknown[] {
  return db
    .prepare(
      `SELECT a.symbol, a.class, s.* FROM screen s
       JOIN asset a ON a.id = s.asset_id
       WHERE s.session_date = ? ${opts.flaggedOnly === true ? "AND s.flagged = 1" : ""}
       ORDER BY s.score DESC, a.symbol`,
    )
    .all(date);
}

export function countCoverage(db: DatabaseSync, date: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM coverage WHERE session_date = ?").get(date) as { n: number }).n;
}

export function countScreened(db: DatabaseSync, date: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM screen WHERE session_date = ?").get(date) as { n: number }).n;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec node --test src/db/repo/screen.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Write the screen command**

Create `src/cli/screen.ts`:

```ts
import { parseArgs } from "node:util";
import { openDb } from "../db/connect.ts";
import { resolveSession, stampPhase } from "../db/repo/session.ts";
import { requireAssetBySymbol } from "../db/repo/asset.ts";
import { getClusterParams, getGlobalParams } from "../db/repo/cluster.ts";
import { recordScreen, listScreen, countCoverage, countScreened } from "../db/repo/screen.ts";
import { resolveParams } from "../domain/params.ts";
import { assertPhaseOrder, nowIso } from "../domain/session.ts";
import { num, readText, required } from "./args.ts";
import { JanusError } from "../output.ts";

export async function handle(verb: string | undefined, argv: string[]): Promise<unknown> {
  const db = openDb();
  try {
    const [symbol, ...rest] = argv;
    const { values } = parseArgs({
      args: verb === "list" ? argv : rest,
      options: {
        score: { type: "string" }, confidence: { type: "string" }, rationale: { type: "string" },
        flagged: { type: "boolean" }, date: { type: "string" }, force: { type: "boolean" },
      },
    });

    if (verb === "record") {
      const now = nowIso();
      const session = resolveSession(db, values.date, now);
      assertPhaseOrder(session, "screen", values.force === true);
      const asset = requireAssetBySymbol(db, required(symbol, "symbol").toUpperCase());

      const hasCoverage = db
        .prepare("SELECT 1 FROM coverage WHERE session_date = ? AND asset_id = ?")
        .get(session.session_date, asset.id);
      if (hasCoverage === undefined) {
        throw new JanusError("NO_COVERAGE", `${asset.symbol} has no coverage for ${session.session_date}`);
      }

      const params = resolveParams(getClusterParams(db, asset.cluster_id), getGlobalParams(db));
      const threshold = params["screen_flag_threshold"]!;
      const score = num(values.score, "score", -2, 2);

      recordScreen(db, session.session_date, asset.id, {
        score,
        confidence: num(values.confidence, "confidence", 0, 2),
        threshold,
        flagged: score >= threshold,
        rationale: readText(values.rationale) ?? null,
      }, now);

      // The phase completes once every covered asset has been screened.
      const complete = countScreened(db, session.session_date) >= countCoverage(db, session.session_date);
      if (complete) stampPhase(db, session.session_date, "screen", now);

      return {
        session_date: session.session_date,
        symbol: asset.symbol,
        score, threshold,
        flagged: score >= threshold,
        screened: countScreened(db, session.session_date),
        of: countCoverage(db, session.session_date),
        phase_complete: complete,
      };
    }

    if (verb === "list") {
      const session = resolveSession(db, values.date, nowIso());
      const rows = listScreen(db, session.session_date, { flaggedOnly: values.flagged });
      return { session_date: session.session_date, count: rows.length, screens: rows };
    }

    throw new JanusError("VALIDATION", `unknown verb "${verb}" for screen; try: record, list`);
  } finally {
    db.close();
  }
}
```

Register in `src/cli.ts`: `screen: () => import("./cli/screen.ts"),`

- [ ] **Step 6: Commit**

```bash
git add src/db/repo/screen.ts src/db/repo/screen.test.ts src/cli/screen.ts src/cli.ts
git commit -m "feat: screening phase with cluster-resolved flag threshold"
```

---

### Task 16: Scoring phase

**Files:**
- Create: `src/db/repo/score.ts`, `src/db/repo/score.test.ts`, `src/cli/score.ts`
- Modify: `src/cli.ts` (register `score`)

**Interfaces:**
- Consumes: `deriveScore`, `deriveDirective`, `formatPosition`, `resolveParams`, `tradeSummary`.
- Produces:
  - `QueueEntry` = `{ asset_id: number; symbol: string; class: string; cluster_id: number | null; queue_reason: "flagged" | "open_trade" | "both" }`
  - `scoreQueue(db, date: string): QueueEntry[]` — flagged this session ∪ assets with an open trade.
  - `positionOf(db, assetId: number): PositionState` — side and open unit count.
  - `recordScore(db, date, assetId, row, factors, now): void` — writes the score and its factor rows in one transaction.
  - `listScores(db, date): unknown[]`.

- [ ] **Step 1: Write the failing test**

Create `src/db/repo/score.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../connect.ts";
import { migrate } from "../migrate.ts";
import { ensureSession } from "./session.ts";
import { upsertMarkets } from "./market.ts";
import { addAsset, requireAssetBySymbol } from "./asset.ts";
import { recordScreen } from "./screen.ts";
import { scoreQueue, positionOf, recordScore, listScores } from "./score.ts";

const NOW = "2026-07-31T12:00:00Z";
const DATE = "2026-07-31";

function fresh() {
  const db = openDb(":memory:");
  migrate(db);
  ensureSession(db, DATE, NOW);
  upsertMarkets(db, [
    { symbol: "BTC", market_id: 1, market_type: "perp", status: "active", price_decimals: 1, size_decimals: 5, listed_at: "2025-01-01" },
    { symbol: "ETH", market_id: 2, market_type: "perp", status: "active", price_decimals: 2, size_decimals: 4, listed_at: "2025-01-01" },
    { symbol: "SOL", market_id: 3, market_type: "perp", status: "active", price_decimals: 3, size_decimals: 3, listed_at: "2025-01-01" },
  ], NOW);
  for (const s of ["BTC", "ETH", "SOL"]) addAsset(db, s, "crypto", null, null, NOW);
  return db;
}

function openTrade(db: ReturnType<typeof fresh>, symbol: string, units: number) {
  const id = requireAssetBySymbol(db, symbol).id;
  db.prepare(
    `INSERT INTO trade (asset_id,direction,status,opened_on,initial_price,initial_stop,initial_risk,created_at)
     VALUES (?,'long','open',?,100,90,10,?)`,
  ).run(id, DATE, NOW);
  const tradeId = (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
  for (let i = 1; i <= units; i++) {
    db.prepare(
      `INSERT INTO trade_unit (trade_id,seq,entry_on,entry_price,notional,risk,stop,status)
       VALUES (?,?,?,100,1000,100,90,'open')`,
    ).run(tradeId, i, DATE);
  }
}

test("the queue is the union of flagged assets and open positions", () => {
  const db = fresh();
  recordScreen(db, DATE, requireAssetBySymbol(db, "BTC").id,
    { score: 1.5, confidence: 0, threshold: 1, flagged: true, rationale: null }, NOW);
  recordScreen(db, DATE, requireAssetBySymbol(db, "ETH").id,
    { score: 0.1, confidence: 0, threshold: 1, flagged: false, rationale: null }, NOW);
  openTrade(db, "SOL", 1);

  const queue = scoreQueue(db, DATE);
  assert.deepEqual(
    queue.map((q) => [q.symbol, q.queue_reason]).sort(),
    [["BTC", "flagged"], ["SOL", "open_trade"]],
  );
  db.close();
});

test("an asset both flagged and held reports reason both", () => {
  const db = fresh();
  recordScreen(db, DATE, requireAssetBySymbol(db, "BTC").id,
    { score: 1.5, confidence: 0, threshold: 1, flagged: true, rationale: null }, NOW);
  openTrade(db, "BTC", 2);
  assert.equal(scoreQueue(db, DATE)[0]!.queue_reason, "both");
  db.close();
});

test("positionOf reports side and open unit count", () => {
  const db = fresh();
  assert.deepEqual(positionOf(db, requireAssetBySymbol(db, "BTC").id), { side: null, units: 0 });
  openTrade(db, "BTC", 3);
  assert.deepEqual(positionOf(db, requireAssetBySymbol(db, "BTC").id), { side: "long", units: 3 });
  db.close();
});

test("recordScore writes the score and its factors together", () => {
  const db = fresh();
  const id = requireAssetBySymbol(db, "BTC").id;
  recordScore(db, DATE, id, {
    d: 1.5, conv: 8, directive: "INITIATE", queue_reason: "flagged",
    position_state: "flat", params_json: "{}", rationale: "breakout",
  }, { catalyst: 2, crowding: -1 }, { catalyst: 1, crowding: -1 }, NOW);

  const rows = listScores(db, DATE) as { symbol: string; directive: string; factors: Record<string, unknown> }[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.directive, "INITIATE");
  assert.deepEqual(rows[0]!.factors, { catalyst: { value: 2, weight: 1 }, crowding: { value: -1, weight: -1 } });
  db.close();
});

test("re-scoring replaces the previous factors rather than merging them", () => {
  const db = fresh();
  const id = requireAssetBySymbol(db, "BTC").id;
  const row = {
    d: 1.5, conv: 8, directive: "INITIATE", queue_reason: "flagged",
    position_state: "flat", params_json: "{}", rationale: null,
  };
  recordScore(db, DATE, id, row, { catalyst: 2, vibes: 1 }, { catalyst: 1, vibes: 0 }, NOW);
  recordScore(db, DATE, id, row, { catalyst: 1 }, { catalyst: 1 }, NOW);
  const rows = listScores(db, DATE) as { factors: Record<string, unknown> }[];
  assert.deepEqual(Object.keys(rows[0]!.factors), ["catalyst"], "stale factors must not survive");
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec node --test src/db/repo/score.test.ts`
Expected: FAIL — cannot find module `./score.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/db/repo/score.ts`:

```ts
import type { DatabaseSync } from "node:sqlite";
import type { PositionState } from "../../domain/directive.ts";

export type QueueEntry = {
  asset_id: number;
  symbol: string;
  class: string;
  cluster_id: number | null;
  queue_reason: "flagged" | "open_trade" | "both";
};

export type ScoreRow = {
  d: number;
  conv: number;
  directive: string;
  queue_reason: string;
  position_state: string;
  params_json: string;
  rationale: string | null;
};

/**
 * Flagged this session, unioned with anything carrying an open trade. An open
 * position needs a directive daily whether or not it screened.
 */
export function scoreQueue(db: DatabaseSync, date: string): QueueEntry[] {
  return db
    .prepare(
      `SELECT a.id AS asset_id, a.symbol, a.class, a.cluster_id,
              CASE WHEN f.asset_id IS NOT NULL AND t.asset_id IS NOT NULL THEN 'both'
                   WHEN f.asset_id IS NOT NULL THEN 'flagged'
                   ELSE 'open_trade' END AS queue_reason
       FROM asset a
       LEFT JOIN (SELECT asset_id FROM screen WHERE session_date = ? AND flagged = 1) f ON f.asset_id = a.id
       LEFT JOIN (SELECT DISTINCT asset_id FROM trade WHERE status = 'open') t ON t.asset_id = a.id
       WHERE f.asset_id IS NOT NULL OR t.asset_id IS NOT NULL
       ORDER BY a.symbol`,
    )
    .all(date) as QueueEntry[];
}

export function positionOf(db: DatabaseSync, assetId: number): PositionState {
  const row = db
    .prepare(
      `SELECT t.direction, COUNT(u.id) AS units
       FROM trade t LEFT JOIN trade_unit u ON u.trade_id = t.id AND u.status = 'open'
       WHERE t.asset_id = ? AND t.status = 'open'
       GROUP BY t.id`,
    )
    .get(assetId) as { direction: "long" | "short"; units: number } | undefined;
  return row === undefined ? { side: null, units: 0 } : { side: row.direction, units: row.units };
}

export function recordScore(
  db: DatabaseSync,
  date: string,
  assetId: number,
  row: ScoreRow,
  factors: Record<string, number>,
  weights: Record<string, number>,
  now: string,
): void {
  db.exec("BEGIN");
  try {
    db.prepare(
      `INSERT INTO score (session_date, asset_id, d, conv, directive, queue_reason, position_state, params_json, rationale, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_date, asset_id) DO UPDATE SET
         d = excluded.d, conv = excluded.conv, directive = excluded.directive,
         queue_reason = excluded.queue_reason, position_state = excluded.position_state,
         params_json = excluded.params_json, rationale = excluded.rationale,
         recorded_at = excluded.recorded_at`,
    ).run(date, assetId, row.d, row.conv, row.directive, row.queue_reason, row.position_state, row.params_json, row.rationale, now);

    db.prepare("DELETE FROM score_factor WHERE session_date = ? AND asset_id = ?").run(date, assetId);
    const stmt = db.prepare(
      "INSERT INTO score_factor (session_date, asset_id, key, value, weight) VALUES (?, ?, ?, ?, ?)",
    );
    for (const [key, value] of Object.entries(factors)) {
      stmt.run(date, assetId, key, value, weights[key] ?? 0);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function listScores(db: DatabaseSync, date: string): unknown[] {
  const scores = db
    .prepare(
      `SELECT a.symbol, a.class, s.* FROM score s
       JOIN asset a ON a.id = s.asset_id
       WHERE s.session_date = ? ORDER BY ABS(s.d) DESC, a.symbol`,
    )
    .all(date) as (ScoreRow & { asset_id: number; symbol: string })[];

  const factorRows = db
    .prepare("SELECT asset_id, key, value, weight FROM score_factor WHERE session_date = ?")
    .all(date) as { asset_id: number; key: string; value: number; weight: number }[];

  return scores.map((s) => {
    const factors: Record<string, { value: number; weight: number }> = {};
    for (const f of factorRows) {
      if (f.asset_id === s.asset_id) factors[f.key] = { value: f.value, weight: f.weight };
    }
    return { ...s, factors };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec node --test src/db/repo/score.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the score command**

Create `src/cli/score.ts`:

```ts
import { parseArgs } from "node:util";
import { openDb } from "../db/connect.ts";
import { resolveSession, stampPhase } from "../db/repo/session.ts";
import { requireAssetBySymbol } from "../db/repo/asset.ts";
import { getClusterParams, getGlobalParams } from "../db/repo/cluster.ts";
import { scoreQueue, positionOf, recordScore, listScores } from "../db/repo/score.ts";
import { listCoverage } from "../db/repo/coverage.ts";
import { listScreen } from "../db/repo/screen.ts";
import { resolveParams } from "../domain/params.ts";
import { deriveScore } from "../domain/score.ts";
import { deriveDirective, formatPosition } from "../domain/directive.ts";
import { assertPhaseOrder, nowIso } from "../domain/session.ts";
import { pairs, readText, required } from "./args.ts";
import { JanusError } from "../output.ts";

export async function handle(verb: string | undefined, argv: string[]): Promise<unknown> {
  const db = openDb();
  try {
    const [symbol, ...rest] = argv;
    const { values } = parseArgs({
      args: verb === "record" ? rest : argv,
      options: {
        factor: { type: "string", multiple: true }, rationale: { type: "string" },
        date: { type: "string" }, force: { type: "boolean" },
      },
    });

    if (verb === "queue") {
      const session = resolveSession(db, values.date, nowIso());
      const queue = scoreQueue(db, session.session_date);
      const coverage = listCoverage(db, session.session_date) as { symbol: string }[];
      const screens = listScreen(db, session.session_date, {}) as { symbol: string }[];
      const bySymbol = <T extends { symbol: string }>(rows: T[]): Map<string, T> =>
        new Map(rows.map((r) => [r.symbol, r]));
      const cov = bySymbol(coverage);
      const scr = bySymbol(screens);
      return {
        session_date: session.session_date,
        count: queue.length,
        queue: queue.map((q) => ({
          ...q,
          position: formatPosition(positionOf(db, q.asset_id)),
          coverage: cov.get(q.symbol) ?? null,
          screen: scr.get(q.symbol) ?? null,
        })),
      };
    }

    if (verb === "record") {
      const now = nowIso();
      const session = resolveSession(db, values.date, now);
      assertPhaseOrder(session, "score", values.force === true);
      const asset = requireAssetBySymbol(db, required(symbol, "symbol").toUpperCase());

      const queue = scoreQueue(db, session.session_date);
      const entry = queue.find((q) => q.asset_id === asset.id);
      if (entry === undefined) {
        throw new JanusError(
          "NOT_FLAGGED",
          `${asset.symbol} is not in the scoring queue for ${session.session_date}`,
        );
      }

      const factors = pairs(values.factor, "factor");
      if (Object.keys(factors).length === 0) {
        throw new JanusError("VALIDATION", "at least one --factor key=value is required");
      }

      const params = resolveParams(getClusterParams(db, asset.cluster_id), getGlobalParams(db));
      const { d, conv, applied } = deriveScore(factors, params);
      const position = positionOf(db, asset.id);
      const directive = deriveDirective(d, conv, position, params);

      recordScore(db, session.session_date, asset.id, {
        d, conv, directive,
        queue_reason: entry.queue_reason,
        position_state: formatPosition(position),
        params_json: JSON.stringify(params),
        rationale: readText(values.rationale) ?? null,
      }, factors, applied, now);

      const scored = (listScores(db, session.session_date) as unknown[]).length;
      const complete = scored >= queue.length;
      if (complete) stampPhase(db, session.session_date, "score", now);

      return {
        session_date: session.session_date,
        symbol: asset.symbol,
        d, conv, directive,
        position: formatPosition(position),
        queue_reason: entry.queue_reason,
        factors: Object.fromEntries(
          Object.entries(factors).map(([k, v]) => [k, { value: v, weight: applied[k] ?? 0 }]),
        ),
        scored, of: queue.length,
        phase_complete: complete,
      };
    }

    if (verb === "list") {
      const session = resolveSession(db, values.date, nowIso());
      const scores = listScores(db, session.session_date);
      return { session_date: session.session_date, count: scores.length, scores };
    }

    throw new JanusError("VALIDATION", `unknown verb "${verb}" for score; try: queue, record, list`);
  } finally {
    db.close();
  }
}
```

Register in `src/cli.ts`: `score: () => import("./cli/score.ts"),`

- [ ] **Step 6: Commit**

```bash
git add src/db/repo/score.ts src/db/repo/score.test.ts src/cli/score.ts src/cli.ts
git commit -m "feat: scoring phase deriving d, conv, and directive"
```

---

### Task 17: Trade logging

**Files:**
- Create: `src/db/repo/trade.ts`, `src/db/repo/trade.test.ts`, `src/cli/trade.ts`
- Modify: `src/cli.ts` (register `trade`)

**Interfaces:**
- Consumes: `tradeSummary`, `UnitRow`, `requireAssetBySymbol`, `todayNY`, `nowIso`.
- Produces: `openTrade(db, input, now): number` (returns the trade id), `addUnit(db, tradeId, input): number` (returns the new seq), `setStop(db, tradeId, stop, seq?): number` (units updated), `exitUnits(db, tradeId, price, exitOn, seq?): {closed: number; trade_status: string}`, `getTrade(db, tradeId): unknown`, `listTrades(db, filters): unknown[]`.

Opening a trade creates unit 1 in the same transaction — a trade with no units is not a state the system should be able to reach.

- [ ] **Step 1: Write the failing test**

Create `src/db/repo/trade.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../connect.ts";
import { migrate } from "../migrate.ts";
import { upsertMarkets } from "./market.ts";
import { addAsset, requireAssetBySymbol } from "./asset.ts";
import { openTrade, addUnit, setStop, exitUnits, getTrade, listTrades } from "./trade.ts";

const NOW = "2026-07-31T12:00:00Z";
const DATE = "2026-07-31";

function fresh() {
  const db = openDb(":memory:");
  migrate(db);
  upsertMarkets(db, [
    { symbol: "BTC", market_id: 1, market_type: "perp", status: "active", price_decimals: 1, size_decimals: 5, listed_at: "2025-01-01" },
  ], NOW);
  addAsset(db, "BTC", "crypto", null, null, NOW);
  return db;
}

const input = {
  asset_id: 1, direction: "long" as const, opened_on: DATE,
  price: 100, stop: 90, risk: 100, notional: 1000,
  thesis: "breakout", origin_session_date: DATE,
};

test("openTrade creates the trade and its first unit", () => {
  const db = fresh();
  const id = openTrade(db, { ...input, asset_id: requireAssetBySymbol(db, "BTC").id }, NOW);
  const t = getTrade(db, id) as { units: unknown[]; summary: { open_units: number; total_notional: number } };
  assert.equal(t.units.length, 1);
  assert.equal(t.summary.open_units, 1);
  assert.equal(t.summary.total_notional, 1000);
  db.close();
});

test("a second open trade on the same asset is rejected", () => {
  const db = fresh();
  const asset_id = requireAssetBySymbol(db, "BTC").id;
  openTrade(db, { ...input, asset_id }, NOW);
  assert.throws(
    () => openTrade(db, { ...input, asset_id }, NOW),
    (e: Error & { code?: string }) => e.code === "POSITION_CONFLICT",
  );
  db.close();
});

test("addUnit assigns sequential seq numbers", () => {
  const db = fresh();
  const id = openTrade(db, { ...input, asset_id: requireAssetBySymbol(db, "BTC").id }, NOW);
  assert.equal(addUnit(db, id, { entry_on: DATE, price: 110, stop: 100, risk: 100, notional: 1100 }), 2);
  assert.equal(addUnit(db, id, { entry_on: DATE, price: 120, stop: 110, risk: 100, notional: 1200 }), 3);
  const t = getTrade(db, id) as { summary: { open_units: number; total_notional: number } };
  assert.equal(t.summary.open_units, 3);
  assert.equal(t.summary.total_notional, 3300);
  db.close();
});

test("setStop without a seq moves every open unit", () => {
  const db = fresh();
  const id = openTrade(db, { ...input, asset_id: requireAssetBySymbol(db, "BTC").id }, NOW);
  addUnit(db, id, { entry_on: DATE, price: 110, stop: 100, risk: 100, notional: 1100 });
  assert.equal(setStop(db, id, 105), 2);
  const t = getTrade(db, id) as { units: { stop: number }[] };
  assert.deepEqual(t.units.map((u) => u.stop), [105, 105]);
  db.close();
});

test("setStop with a seq moves only that unit", () => {
  const db = fresh();
  const id = openTrade(db, { ...input, asset_id: requireAssetBySymbol(db, "BTC").id }, NOW);
  addUnit(db, id, { entry_on: DATE, price: 110, stop: 100, risk: 100, notional: 1100 });
  assert.equal(setStop(db, id, 108, 2), 1);
  const t = getTrade(db, id) as { units: { seq: number; stop: number }[] };
  assert.deepEqual(t.units.map((u) => u.stop), [90, 108]);
  db.close();
});

test("exiting every unit closes the trade", () => {
  const db = fresh();
  const id = openTrade(db, { ...input, asset_id: requireAssetBySymbol(db, "BTC").id }, NOW);
  addUnit(db, id, { entry_on: DATE, price: 110, stop: 100, risk: 100, notional: 1100 });
  const res = exitUnits(db, id, 130, DATE);
  assert.equal(res.closed, 2);
  assert.equal(res.trade_status, "closed");
  const t = getTrade(db, id) as { trade: { status: string; closed_on: string } };
  assert.equal(t.trade.status, "closed");
  assert.equal(t.trade.closed_on, DATE);
  db.close();
});

test("a partial exit leaves the trade open", () => {
  const db = fresh();
  const id = openTrade(db, { ...input, asset_id: requireAssetBySymbol(db, "BTC").id }, NOW);
  addUnit(db, id, { entry_on: DATE, price: 110, stop: 100, risk: 100, notional: 1100 });
  const res = exitUnits(db, id, 130, DATE, 1);
  assert.equal(res.closed, 1);
  assert.equal(res.trade_status, "open");
  const t = getTrade(db, id) as { summary: { open_units: number; realized_pnl: number } };
  assert.equal(t.summary.open_units, 1);
  assert.equal(t.summary.realized_pnl, 300); // size 10 x 30
  db.close();
});

test("closing a trade frees the asset for a new one", () => {
  const db = fresh();
  const asset_id = requireAssetBySymbol(db, "BTC").id;
  const id = openTrade(db, { ...input, asset_id }, NOW);
  exitUnits(db, id, 130, DATE);
  assert.ok(openTrade(db, { ...input, asset_id }, NOW) > id, "the partial index only covers open trades");
  db.close();
});

test("exiting an already-closed unit is rejected", () => {
  const db = fresh();
  const id = openTrade(db, { ...input, asset_id: requireAssetBySymbol(db, "BTC").id }, NOW);
  exitUnits(db, id, 130, DATE);
  assert.throws(
    () => exitUnits(db, id, 140, DATE),
    (e: Error & { code?: string }) => e.code === "VALIDATION",
  );
  db.close();
});

test("listTrades filters by status and symbol", () => {
  const db = fresh();
  const asset_id = requireAssetBySymbol(db, "BTC").id;
  const id = openTrade(db, { ...input, asset_id }, NOW);
  assert.equal((listTrades(db, { status: "open" }) as unknown[]).length, 1);
  exitUnits(db, id, 130, DATE);
  assert.equal((listTrades(db, { status: "open" }) as unknown[]).length, 0);
  assert.equal((listTrades(db, { status: "closed" }) as unknown[]).length, 1);
  assert.equal((listTrades(db, { symbols: ["BTC"] }) as unknown[]).length, 1);
  assert.equal((listTrades(db, { symbols: ["ETH"] }) as unknown[]).length, 0);
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec node --test src/db/repo/trade.test.ts`
Expected: FAIL — cannot find module `./trade.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/db/repo/trade.ts`:

```ts
import type { DatabaseSync } from "node:sqlite";
import { JanusError } from "../../output.ts";
import { tradeSummary } from "../../domain/trade-math.ts";
import type { UnitRow } from "../../domain/trade-math.ts";

export type OpenTradeInput = {
  asset_id: number;
  direction: "long" | "short";
  opened_on: string;
  price: number;
  stop: number;
  risk: number;
  notional: number;
  thesis: string | null;
  origin_session_date: string | null;
};

export type UnitInput = {
  entry_on: string;
  price: number;
  stop: number;
  risk: number;
  notional: number;
};

type TradeRecord = {
  id: number;
  asset_id: number;
  direction: "long" | "short";
  status: "open" | "closed";
  initial_risk: number;
  symbol: string;
};

function requireTrade(db: DatabaseSync, tradeId: number): TradeRecord {
  const row = db
    .prepare("SELECT t.*, a.symbol FROM trade t JOIN asset a ON a.id = t.asset_id WHERE t.id = ?")
    .get(tradeId) as TradeRecord | undefined;
  if (row === undefined) throw new JanusError("NOT_FOUND", `no trade ${tradeId}`);
  return row;
}

function unitsOf(db: DatabaseSync, tradeId: number): UnitRow[] {
  return db
    .prepare("SELECT * FROM trade_unit WHERE trade_id = ? ORDER BY seq")
    .all(tradeId) as UnitRow[];
}

export function openTrade(db: DatabaseSync, input: OpenTradeInput, now: string): number {
  const held = db
    .prepare("SELECT id FROM trade WHERE asset_id = ? AND status = 'open'")
    .get(input.asset_id) as { id: number } | undefined;
  if (held !== undefined) {
    throw new JanusError(
      "POSITION_CONFLICT",
      `trade ${held.id} is already open on this asset; add a unit or exit it first`,
    );
  }

  db.exec("BEGIN");
  try {
    db.prepare(
      `INSERT INTO trade (asset_id, direction, status, opened_on, initial_price, initial_stop,
                          initial_risk, thesis, origin_session_date, created_at)
       VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(input.asset_id, input.direction, input.opened_on, input.price, input.stop,
          input.risk, input.thesis, input.origin_session_date, now);
    const id = (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
    db.prepare(
      `INSERT INTO trade_unit (trade_id, seq, entry_on, entry_price, notional, risk, stop, status)
       VALUES (?, 1, ?, ?, ?, ?, ?, 'open')`,
    ).run(id, input.opened_on, input.price, input.notional, input.risk, input.stop);
    db.exec("COMMIT");
    return id;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function addUnit(db: DatabaseSync, tradeId: number, input: UnitInput): number {
  const trade = requireTrade(db, tradeId);
  if (trade.status !== "open") {
    throw new JanusError("VALIDATION", `trade ${tradeId} is closed`);
  }
  const max = db
    .prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM trade_unit WHERE trade_id = ?")
    .get(tradeId) as { seq: number };
  const seq = max.seq + 1;
  db.prepare(
    `INSERT INTO trade_unit (trade_id, seq, entry_on, entry_price, notional, risk, stop, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open')`,
  ).run(tradeId, seq, input.entry_on, input.price, input.notional, input.risk, input.stop);
  return seq;
}

/** Returns the number of units moved. Omitting seq moves every open unit. */
export function setStop(db: DatabaseSync, tradeId: number, stop: number, seq?: number): number {
  requireTrade(db, tradeId);
  const result = seq === undefined
    ? db.prepare("UPDATE trade_unit SET stop = ? WHERE trade_id = ? AND status = 'open'").run(stop, tradeId)
    : db.prepare("UPDATE trade_unit SET stop = ? WHERE trade_id = ? AND seq = ? AND status = 'open'").run(stop, tradeId, seq);
  const changed = Number(result.changes);
  if (changed === 0) throw new JanusError("VALIDATION", `no open unit to move on trade ${tradeId}`);
  return changed;
}

/** Omitting seq exits every open unit and closes the trade. */
export function exitUnits(
  db: DatabaseSync,
  tradeId: number,
  price: number,
  exitOn: string,
  seq?: number,
): { closed: number; trade_status: string } {
  requireTrade(db, tradeId);
  db.exec("BEGIN");
  try {
    const result = seq === undefined
      ? db.prepare(
          "UPDATE trade_unit SET status='closed', exit_price=?, exit_on=? WHERE trade_id=? AND status='open'",
        ).run(price, exitOn, tradeId)
      : db.prepare(
          "UPDATE trade_unit SET status='closed', exit_price=?, exit_on=? WHERE trade_id=? AND seq=? AND status='open'",
        ).run(price, exitOn, tradeId, seq);

    const closed = Number(result.changes);
    if (closed === 0) {
      throw new JanusError("VALIDATION", `no open unit to exit on trade ${tradeId}`);
    }

    const remaining = db
      .prepare("SELECT COUNT(*) AS n FROM trade_unit WHERE trade_id = ? AND status = 'open'")
      .get(tradeId) as { n: number };
    const status = remaining.n === 0 ? "closed" : "open";
    if (status === "closed") {
      db.prepare("UPDATE trade SET status='closed', closed_on=? WHERE id=?").run(exitOn, tradeId);
    }
    db.exec("COMMIT");
    return { closed, trade_status: status };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function getTrade(db: DatabaseSync, tradeId: number): unknown {
  const trade = requireTrade(db, tradeId);
  const units = unitsOf(db, tradeId);
  return { trade, units, summary: tradeSummary(trade.direction, trade.initial_risk, units) };
}

export function listTrades(
  db: DatabaseSync,
  filters: { status?: string | undefined; symbols?: string[] | undefined },
): unknown[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (filters.status !== undefined) {
    where.push("t.status = ?");
    args.push(filters.status);
  }
  if (filters.symbols !== undefined) {
    where.push(`a.symbol IN (${filters.symbols.map(() => "?").join(",")})`);
    args.push(...filters.symbols);
  }
  const trades = db
    .prepare(
      `SELECT t.*, a.symbol FROM trade t JOIN asset a ON a.id = t.asset_id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY t.opened_on DESC, t.id DESC`,
    )
    .all(...args) as TradeRecord[];

  return trades.map((t) => {
    const units = unitsOf(db, t.id);
    return { ...t, summary: tradeSummary(t.direction, t.initial_risk, units) };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec node --test src/db/repo/trade.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Write the trade command**

Create `src/cli/trade.ts`:

```ts
import { parseArgs } from "node:util";
import { openDb } from "../db/connect.ts";
import { requireAssetBySymbol } from "../db/repo/asset.ts";
import { openTrade, addUnit, setStop, exitUnits, getTrade, listTrades } from "../db/repo/trade.ts";
import { getSession } from "../db/repo/session.ts";
import { todayNY, nowIso } from "../domain/session.ts";
import { csv, num, readText, required } from "./args.ts";
import { JanusError } from "../output.ts";

const POSITIVE = Number.MAX_SAFE_INTEGER;

function tradeId(raw: string | undefined): number {
  const id = Number(required(raw, "trade_id"));
  if (!Number.isInteger(id) || id < 1) {
    throw new JanusError("VALIDATION", `trade_id must be a positive integer, got ${raw}`);
  }
  return id;
}

export async function handle(verb: string | undefined, argv: string[]): Promise<unknown> {
  const db = openDb();
  try {
    const [first, ...rest] = argv;
    const { values } = parseArgs({
      args: verb === "list" ? argv : rest,
      options: {
        direction: { type: "string" }, price: { type: "string" }, stop: { type: "string" },
        risk: { type: "string" }, notional: { type: "string" }, thesis: { type: "string" },
        unit: { type: "string" }, date: { type: "string" },
        open: { type: "boolean" }, closed: { type: "boolean" }, asset: { type: "string" },
      },
    });
    // `--date` here is the real entry or exit date of a unit, not a session address.
    const on = values.date ?? todayNY();
    const seq = values.unit === undefined ? undefined : Number(values.unit);
    if (seq !== undefined && (!Number.isInteger(seq) || seq < 1)) {
      throw new JanusError("VALIDATION", `--unit must be a positive integer, got ${values.unit}`);
    }

    if (verb === "open") {
      const asset = requireAssetBySymbol(db, required(first, "symbol").toUpperCase());
      const session = getSession(db, on);
      const id = openTrade(db, {
        asset_id: asset.id,
        direction: values.direction === "short" ? "short" : "long",
        opened_on: on,
        price: num(values.price, "price", 0, POSITIVE),
        stop: num(values.stop, "stop", 0, POSITIVE),
        risk: num(values.risk, "risk", 0, POSITIVE),
        notional: num(values.notional, "notional", 0, POSITIVE),
        thesis: readText(values.thesis) ?? null,
        origin_session_date: session === undefined ? null : session.session_date,
      }, nowIso());
      return getTrade(db, id);
    }

    if (verb === "add-unit") {
      const id = tradeId(first);
      const newSeq = addUnit(db, id, {
        entry_on: on,
        price: num(values.price, "price", 0, POSITIVE),
        stop: num(values.stop, "stop", 0, POSITIVE),
        risk: num(values.risk, "risk", 0, POSITIVE),
        notional: num(values.notional, "notional", 0, POSITIVE),
      });
      return { seq: newSeq, ...(getTrade(db, id) as object) };
    }

    if (verb === "set-stop") {
      const id = tradeId(first);
      const moved = setStop(db, id, num(values.stop, "stop", 0, POSITIVE), seq);
      return { units_moved: moved, ...(getTrade(db, id) as object) };
    }

    if (verb === "exit") {
      const id = tradeId(first);
      const res = exitUnits(db, id, num(values.price, "price", 0, POSITIVE), on, seq);
      return { ...res, ...(getTrade(db, id) as object) };
    }

    if (verb === "show") return getTrade(db, tradeId(first));

    if (verb === "list") {
      const status = values.open === true ? "open" : values.closed === true ? "closed" : undefined;
      const trades = listTrades(db, { status, symbols: csv(values.asset)?.map((s) => s.toUpperCase()) });
      return { count: trades.length, trades };
    }

    throw new JanusError(
      "VALIDATION",
      `unknown verb "${verb}" for trade; try: open, add-unit, set-stop, exit, list, show`,
    );
  } finally {
    db.close();
  }
}
```

Register in `src/cli.ts`: `trade: () => import("./cli/trade.ts"),`

`trade open` links the trade to today's session when one exists, so `origin_session_date` joins back to the score that motivated it.

- [ ] **Step 6: Commit**

```bash
git add src/db/repo/trade.ts src/db/repo/trade.test.ts src/cli/trade.ts src/cli.ts
git commit -m "feat: trade and unit logging with position summaries"
```

---

### Task 18: End-to-end CLI smoke test

**Files:**
- Create: `src/cli.e2e.test.ts`

**Interfaces:**
- Consumes: the built CLI as a subprocess. Nothing imports from this file.

This test drives the real binary the way the agent does — spawning it, parsing stdout as JSON, and asserting on exit codes. It is the only place the agent's actual contract is verified. It uses a stub Lighter server so no network is touched.

- [ ] **Step 1: Write the failing test**

Create `src/cli.e2e.test.ts`:

```ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = promisify(execFile);
const dir = mkdtempSync(join(tmpdir(), "janus-e2e-"));
const DB = join(dir, "test.db");
const CLI = new URL("./cli.ts", import.meta.url).pathname;

let server: Server;
let baseUrl: string;

/** Serves the recorded fixtures so the coverage phase never touches the network. */
before(async () => {
  const fixture = (name: string): string =>
    readFileSync(new URL(`../test/fixtures/${name}.json`, import.meta.url), "utf8");

  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    res.setHeader("content-type", "application/json");
    if (path === "/api/v1/orderBooks") return void res.end(fixture("orderBooks"));
    if (path === "/api/v1/orderBookDetails") return void res.end(fixture("orderBookDetails"));
    if (path === "/api/v1/candles") return void res.end(fixture("candles"));
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr !== null ? addr.port : 0}`;
});

after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Runs the CLI and returns the parsed envelope plus the exit code. */
async function janus(...args: string[]): Promise<{ code: number; body: any }> {
  const env = { ...process.env, JANUS_DB: DB, JANUS_LIGHTER_URL: baseUrl };
  try {
    const { stdout } = await run(process.execPath, [CLI, ...args], { env });
    return { code: 0, body: JSON.parse(stdout) };
  } catch (e) {
    const err = e as { code?: number; stdout?: string };
    return { code: err.code ?? 1, body: JSON.parse(err.stdout ?? "{}") };
  }
}

test("every command emits a parseable envelope", async () => {
  const { code, body } = await janus("init");
  assert.equal(code, 0);
  assert.equal(body.ok, true);
  assert.equal(body.data.schema_version, 1);
});

test("an unknown command fails with VALIDATION and exit 1", async () => {
  const { code, body } = await janus("nonsense");
  assert.equal(code, 1);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "VALIDATION");
});

test("the full daily pipeline runs end to end", async () => {
  await janus("market", "sync");
  await janus("cluster", "add", "majors", "--name", "Majors");
  const added = await janus("asset", "add", "BTC", "--class", "crypto", "--cluster", "majors");
  assert.equal(added.body.ok, true, JSON.stringify(added.body));

  // Scoring before screening must be refused.
  const early = await janus("score", "queue");
  assert.equal(early.body.ok, true, "queue is a read and is always allowed");

  const outOfOrder = await janus("coverage", "run");
  assert.equal(outOfOrder.code, 1);
  assert.equal(outOfOrder.body.error.code, "PHASE_ORDER");
  assert.match(outOfOrder.body.error.message, /regime/);

  const regime = await janus(
    "regime", "record", "--state", "RISK_ON", "--score", "1.5",
    "--confidence", "0.5", "--summary", "breadth improving", "--metric", "vix=14.2",
  );
  assert.equal(regime.body.ok, true, JSON.stringify(regime.body));

  const clusterRead = await janus("cluster-read", "record", "majors", "--bias", "1.0", "--judgement", "intact");
  assert.equal(clusterRead.body.ok, true);

  const coverage = await janus("coverage", "run");
  assert.equal(coverage.body.ok, true, JSON.stringify(coverage.body));
  assert.equal(coverage.body.data.covered, 1);
  assert.equal(coverage.body.data.phase_complete, true);

  const screen = await janus("screen", "record", "BTC", "--score", "1.5", "--confidence", "0.5");
  assert.equal(screen.body.ok, true, JSON.stringify(screen.body));
  assert.equal(screen.body.data.flagged, true);

  const queue = await janus("score", "queue");
  assert.equal(queue.body.data.count, 1);
  assert.equal(queue.body.data.queue[0].queue_reason, "flagged");

  const scored = await janus(
    "score", "record", "BTC",
    "--factor", "catalyst=2", "--factor", "trend=2",
    "--factor", "secular=2", "--factor", "crowding=-2",
  );
  assert.equal(scored.body.ok, true, JSON.stringify(scored.body));
  assert.equal(scored.body.data.d, 2);
  assert.equal(scored.body.data.conv, 10);
  assert.equal(scored.body.data.directive, "INITIATE");
  assert.equal(scored.body.data.position, "flat");

  const status = await janus("session", "status");
  assert.equal(status.body.data.next_phase, null, "every phase should be complete");
});

test("scoring an asset outside the queue is refused", async () => {
  const res = await janus("score", "record", "BTC", "--factor", "catalyst=1", "--date", "1999-01-01");
  assert.equal(res.code, 1);
  assert.equal(res.body.error.code, "SESSION_MISSING");
});

test("a trade changes the directive on the next scoring run", async () => {
  const opened = await janus(
    "trade", "open", "BTC", "--direction", "long",
    "--price", "100", "--stop", "90", "--risk", "100", "--notional", "1000",
  );
  assert.equal(opened.body.ok, true, JSON.stringify(opened.body));
  const id = String(opened.body.data.trade.id);

  const conflict = await janus(
    "trade", "open", "BTC", "--direction", "long",
    "--price", "100", "--stop", "90", "--risk", "100", "--notional", "1000",
  );
  assert.equal(conflict.body.error.code, "POSITION_CONFLICT");

  // Re-scoring now sees an open position, so the directive is position-aware.
  const rescored = await janus(
    "score", "record", "BTC", "--force",
    "--factor", "catalyst=2", "--factor", "trend=2",
    "--factor", "secular=2", "--factor", "crowding=-2",
  );
  assert.equal(rescored.body.data.position, "long:1");
  assert.equal(rescored.body.data.directive, "ADD");

  const added = await janus("trade", "add-unit", id, "--price", "110", "--stop", "100", "--risk", "100", "--notional", "1100");
  assert.equal(added.body.data.summary.open_units, 2);
  assert.equal(added.body.data.summary.total_notional, 2100);

  const exited = await janus("trade", "exit", id, "--price", "130");
  assert.equal(exited.body.data.trade_status, "closed");
  assert.equal(exited.body.data.summary.open_units, 0);
  assert.ok(exited.body.data.summary.r_multiple > 0);
});
```

- [ ] **Step 2: Make the Lighter base URL configurable**

The e2e test points the client at a stub server. In `src/lighter/client.ts`, change the default so the environment can override it:

```ts
export function createLighterClient(
  baseUrl: string = process.env["JANUS_LIGHTER_URL"] ?? LIGHTER_BASE_URL,
  fetchImpl: typeof fetch = fetch,
): LighterApi {
```

Add a line to the spec's Data source section noting that `JANUS_LIGHTER_URL` overrides the base URL, and mention it in the README if one exists.

- [ ] **Step 3: Run the test**

Run: `pnpm exec node --test src/cli.e2e.test.ts`
Expected: PASS, 5 tests. If `coverage run` reports `covered: 0`, the stub server is not matching the request path — check that `orderBooks` fixture contains a `BTC` entry with `market_id` 1.

- [ ] **Step 4: Run the whole suite and build**

Run: `pnpm exec node --test`
Expected: PASS, every test across all files.

Run: `pnpm build`
Expected: clean compile into `dist/`.

Run: `pnpm exec node dist/cli.js --help`
Expected: the usage envelope with every registered noun, exit code 1.

- [ ] **Step 5: Commit**

```bash
git add src/cli.e2e.test.ts src/lighter/client.ts
git commit -m "test: end-to-end cli contract against a stub lighter server"
```

---

## Verification checklist

Before declaring the implementation done, confirm each of these by running the command and reading the output — not by assuming:

- [ ] `pnpm exec node --test` passes with zero failures.
- [ ] `pnpm build` compiles cleanly.
- [ ] `pnpm exec node dist/cli.js init` works from a clean directory.
- [ ] `git status` is clean and `janus.db` is not tracked.
- [ ] Every command in the spec's CLI surface section exists and returns an envelope.
- [ ] The spec's directive table and score worked-examples table are both covered by passing tests.
