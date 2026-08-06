# Trade Laddering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the already-implemented `deriveLadderPlan` into `deriveScore` as the source of `stop_plan`, add the partial-exit primitive its +1.5R rung depends on, and drop four dead columns.

**Architecture:** `deriveLadderPlan` (`src/domain/ladder.ts:36`) is complete and tested but has no caller. Its inputs reach the pure domain layer as one new optional `ScoreContext.open_trade` field, loaded in the CLI. Its output overlays the directive's `stop_plan` at a single point in `derivePlan`. A partial exit is recorded by splitting a unit into a closed sibling row plus a reduced open row, so every total in `trade-math.ts` stays computed on read.

**Tech Stack:** TypeScript run directly by Node (type-stripping, no build step for tests), `node:sqlite` (`DatabaseSync`, SQLite 3.53.1), `node:test` + `node:assert/strict`, commander for the CLI.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-06-trade-laddering-design.md`. Read it before starting.
- Run all tests with `npm test` (`node --test 'src/**/*.test.ts'`). Run one file with `node --test src/path/to/file.test.ts`.
- Never edit `MIGRATIONS[0]`. An already-applied migration is frozen.
- Errors thrown from domain and repo code are `JanusError` from `src/output.ts`, with codes `VALIDATION`, `NOT_FOUND`, `PHASE_ORDER`, `POSITION_CONFLICT`.
- `trade-math.ts:51` states the rule this design obeys: *"Everything here is computed on read. Nothing is stored denormalized, so correcting a unit can never leave a stale total behind."* Do not add a stored `realized_pnl`.
- Test fixtures are chosen so money and size arithmetic is exact in binary floating point (entry 100, notional 1000, halves of 500), so `assert.equal` is correct and intended for those. Use a tolerance only where a fixture genuinely cannot be exact — the `fraction: 1/3` case is the one place, and there the assertion is on the *sum* of the halves, which must be exact.
- Commit after every task. Conventional-commit prefixes (`feat:`, `fix:`, `refactor:`, `test:`).

---

### Task 1: Drop the four dead columns

**Files:**
- Modify: `src/db/migrate.ts` (append to `MIGRATIONS`, currently a 1-element array ending line 260)
- Modify: `src/domain/trade-math.ts:11-14` (remove two `UnitRow` fields)
- Test: `src/db/migrate.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: schema at `user_version` 2. `UnitRow` keeps `partial_exited?: number` and loses `breakeven_moved_at` and `time_stop_date`.

**Context:** `target_price` and `add_window_open` have zero references outside `migrate.ts`. `breakeven_moved_at` and `time_stop_date` are referenced only as optional `UnitRow` declarations — no logic reads them. `partial_exited` stays; Task 2 starts writing it.

- [ ] **Step 1: Write the failing test**

Add to `src/db/migrate.test.ts`:

```ts
test("migration 1 drops the dead ladder columns", () => {
  const db = openDb(":memory:");
  const version = migrate(db);
  assert.equal(version, 2, "schema should be at version 2");

  const cols = (table: string) =>
    db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table)
      .map((r) => (r as { name: string }).name);

  const trade = cols("trade");
  assert.ok(!trade.includes("target_price"), "trade.target_price should be dropped");
  assert.ok(!trade.includes("add_window_open"), "trade.add_window_open should be dropped");

  const unit = cols("trade_unit");
  assert.ok(!unit.includes("breakeven_moved_at"), "breakeven_moved_at should be dropped");
  assert.ok(!unit.includes("time_stop_date"), "time_stop_date should be dropped");
  assert.ok(unit.includes("partial_exited"), "partial_exited must survive");
  db.close();
});

test("migration 1 preserves existing trade rows", () => {
  const db = openDb(":memory:");
  db.exec("PRAGMA user_version = 1");
  // Recreate just enough of v1 to hold a trade, then migrate.
  migrate(db);
  db.exec(`
    INSERT INTO market VALUES (1,'BTC','perp','active',1,5,'2025-01-01','2026-07-31');
    INSERT INTO asset (id,market_id,symbol,class,active,added_at)
      VALUES (1,1,'BTC','crypto',1,'2026-07-31');
    INSERT INTO trade (id,asset_id,direction,status,opened_on,initial_price,initial_stop,initial_risk,created_at)
      VALUES (1,1,'long','open','2026-07-31',100,90,10,'2026-07-31T00:00:00Z');
    INSERT INTO trade_unit (trade_id,seq,entry_on,entry_price,notional,risk,stop,status)
      VALUES (1,1,'2026-07-31',100,1000,10,90,'open');
  `);
  assert.equal(migrate(db), 2, "re-running migrate must not advance past 2");
  const row = db.prepare("SELECT notional, entry_price FROM trade_unit WHERE trade_id=1 AND seq=1")
    .get() as { notional: number; entry_price: number };
  assert.equal(row.notional, 1000);
  assert.equal(row.entry_price, 100);
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/db/migrate.test.ts`
Expected: FAIL — `schema should be at version 2` (actual 1), and the dropped-column assertions fail because the columns still exist.

- [ ] **Step 3: Write minimal implementation**

In `src/db/migrate.ts`, append a second element to `MIGRATIONS` — after the closing `` ` `` of `MIGRATIONS[0]` on line 259 and before the `];` on line 260:

```ts
  // Four columns were added to the baseline schema and never read. partial_exited
  // is the only one the stop ladder actually uses, so the rest go. MIGRATIONS[0]
  // is left alone: a fresh database creates them and this drops them, landing in
  // the same state as a database that predates the ladder work.
  `
ALTER TABLE trade DROP COLUMN target_price;
ALTER TABLE trade DROP COLUMN add_window_open;
ALTER TABLE trade_unit DROP COLUMN breakeven_moved_at;
ALTER TABLE trade_unit DROP COLUMN time_stop_date;
`,
```

In `src/domain/trade-math.ts`, replace lines 11-14:

```ts
  // Sizing / ladder fields (optional for backwards compatibility).
  partial_exited?: number;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/db/migrate.test.ts`
Expected: PASS

Run: `npm test`
Expected: PASS. If any test references `breakeven_moved_at` or `time_stop_date`, delete those references — no logic depends on them.

- [ ] **Step 5: Commit**

```bash
git add src/db/migrate.ts src/domain/trade-math.ts src/db/migrate.test.ts
git commit -m "refactor: drop four unused trade columns in migration 1"
```

---

### Task 2: Partial exits in the repo layer

**Files:**
- Modify: `src/db/repo/trade.ts` (new function after `exitUnits`, which ends line 151)
- Test: `src/db/repo/trade.test.ts`

**Interfaces:**
- Consumes: Task 1's schema.
- Produces:
```ts
export function partialExitUnit(
  db: DatabaseSync, tradeId: number, seq: number, price: number,
  exitOn: string, fraction: number, funding?: number,
): { closed_seq: number; closed_notional: number; remaining_notional: number }
```

**Context:** `exitUnits` (`trade.ts:113`) closes whole units and is left untouched — a separate function keeps the full-exit transaction free of new branching. `unitsOf` uses `SELECT *`, so `partial_exited` reaches `UnitRow` with no query change. `tradeSummary` needs no changes at all: it sums closed units for `realized_pnl`, and `avg_entry` is `total_notional / openSize` over open units, so two rows sharing one `entry_price` preserve it exactly.

- [ ] **Step 1: Write the failing test**

Add to `src/db/repo/trade.test.ts` (`fresh()` and `input` already exist at the top of that file):

```ts
test("partialExitUnit splits a unit and preserves avg entry", () => {
  const db = fresh();
  const id = openTrade(db, { ...input, asset_id: requireAssetBySymbol(db, "BTC").id }, NOW);
  // input: entry 100, notional 1000, risk 100, stop 90 -> size 10
  const res = partialExitUnit(db, id, 1, 120, DATE, 0.5);

  assert.equal(res.closed_notional, 500);
  assert.equal(res.remaining_notional, 500);
  assert.equal(res.closed_seq, 2);

  const t = getTrade(db, id) as {
    trade: { status: string };
    units: { seq: number; status: string; notional: number; risk: number; partial_exited?: number }[];
    summary: { open_units: number; closed_units: number; total_notional: number; avg_entry: number | null; realized_pnl: number; open_risk: number };
  };

  assert.equal(t.trade.status, "open", "a partial must not close the trade");
  assert.equal(t.summary.open_units, 1);
  assert.equal(t.summary.closed_units, 1);
  assert.equal(t.summary.total_notional, 500);
  assert.equal(t.summary.avg_entry, 100, "both halves share entry_price, so avg entry is unchanged");
  // closed slice: size 500/100 = 5, (120 - 100) * 5 = 100
  assert.equal(t.summary.realized_pnl, 100);
  // remaining: size 5, (100 - 90) * 5 = 50
  assert.equal(t.summary.open_risk, 50);

  const open = t.units.find((u) => u.seq === 1)!;
  assert.equal(open.status, "open");
  assert.equal(open.partial_exited, 1, "the open remainder carries the ladder's latch");
  assert.equal(open.risk, 50);
  db.close();
});

test("partial halves sum to the original notional exactly", () => {
  const db = fresh();
  const id = openTrade(db, { ...input, asset_id: requireAssetBySymbol(db, "BTC").id }, NOW);
  const res = partialExitUnit(db, id, 1, 120, DATE, 1 / 3);
  assert.equal(res.closed_notional + res.remaining_notional, 1000);
  db.close();
});

test("a partial on an already-partial unit compounds against current notional", () => {
  const db = fresh();
  const id = openTrade(db, { ...input, asset_id: requireAssetBySymbol(db, "BTC").id }, NOW);
  partialExitUnit(db, id, 1, 120, DATE, 0.5);   // 1000 -> 500
  const res = partialExitUnit(db, id, 1, 130, DATE, 0.5); // 500 -> 250
  assert.equal(res.closed_notional, 250);
  assert.equal(res.remaining_notional, 250);
  db.close();
});

test("partialExitUnit rejects fractions outside (0,1) and unknown units", () => {
  const db = fresh();
  const id = openTrade(db, { ...input, asset_id: requireAssetBySymbol(db, "BTC").id }, NOW);
  for (const f of [0, 1, -0.5, 1.5]) {
    assert.throws(() => partialExitUnit(db, id, 1, 120, DATE, f), /fraction/i, `fraction ${f}`);
  }
  assert.throws(() => partialExitUnit(db, id, 99, 120, DATE, 0.5), /no open unit/i);
  db.close();
});

test("a short books a gain when price falls", () => {
  const db = fresh();
  const id = openTrade(
    db,
    { ...input, asset_id: requireAssetBySymbol(db, "BTC").id, direction: "short" as const, stop: 110 },
    NOW,
  );
  partialExitUnit(db, id, 1, 80, DATE, 0.5);
  const t = getTrade(db, id) as { summary: { realized_pnl: number } };
  // size 5, (80 - 100) * 5 * -1 = 100
  assert.equal(t.summary.realized_pnl, 100);
  db.close();
});
```

Add `partialExitUnit` to the existing import from `./trade.ts` at the top of the file.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/db/repo/trade.test.ts`
Expected: FAIL with `partialExitUnit is not a function` / import error.

- [ ] **Step 3: Write minimal implementation**

Add to `src/db/repo/trade.ts` after `exitUnits` (which ends line 151):

```ts
/**
 * Bank part of one unit. The closed slice becomes its own row rather than a
 * stored P&L figure on the survivor, so every total in trade-math stays
 * computed on read. Both rows keep the original entry price, which is what
 * leaves avg_entry untouched across the split.
 */
export function partialExitUnit(
  db: DatabaseSync,
  tradeId: number,
  seq: number,
  price: number,
  exitOn: string,
  fraction: number,
  funding?: number,
): { closed_seq: number; closed_notional: number; remaining_notional: number } {
  requireTrade(db, tradeId);
  if (!(fraction > 0 && fraction < 1)) {
    throw new JanusError(
      "VALIDATION",
      `fraction must be greater than 0 and less than 1, got ${fraction}`,
    );
  }
  db.exec("BEGIN");
  try {
    const unit = db
      .prepare("SELECT * FROM trade_unit WHERE trade_id = ? AND seq = ? AND status = 'open'")
      .get(tradeId, seq) as
        | { entry_on: string; entry_price: number; notional: number; risk: number; stop: number; tag: string | null }
        | undefined;
    if (unit === undefined) {
      throw new JanusError("VALIDATION", `no open unit ${seq} on trade ${tradeId}`);
    }

    // Subtract rather than multiply twice, so the two halves sum to the original
    // exactly instead of drifting by a float ulp.
    const closedNotional = unit.notional * fraction;
    const closedRisk = unit.risk * fraction;
    const remainingNotional = unit.notional - closedNotional;
    const remainingRisk = unit.risk - closedRisk;

    const max = db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM trade_unit WHERE trade_id = ?")
      .get(tradeId) as { seq: number };
    const closedSeq = max.seq + 1;

    db.prepare(
      `INSERT INTO trade_unit
         (trade_id, seq, entry_on, entry_price, notional, risk, stop, status,
          exit_on, exit_price, funding, tag, partial_exited)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'closed', ?, ?, ?, ?, 1)`,
    ).run(
      tradeId, closedSeq, unit.entry_on, unit.entry_price, closedNotional, closedRisk,
      unit.stop, exitOn, price, funding ?? 0, unit.tag,
    );

    db.prepare(
      "UPDATE trade_unit SET notional = ?, risk = ?, partial_exited = 1 WHERE trade_id = ? AND seq = ?",
    ).run(remainingNotional, remainingRisk, tradeId, seq);

    db.exec("COMMIT");
    return {
      closed_seq: closedSeq,
      closed_notional: closedNotional,
      remaining_notional: remainingNotional,
    };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
```

The trade deliberately stays `open`: an open row remains, so there is no status transition to make.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/db/repo/trade.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/repo/trade.ts src/db/repo/trade.test.ts
git commit -m "feat: record partial exits by splitting a unit"
```

---

### Task 3: `--fraction` on `trade exit`

**Files:**
- Modify: `src/cli/trade.ts:87-94` (option), `:215-222` (the `exit` function), `:29` (`ExitOpts`)
- Test: `src/cli/trade.test.ts`

**Interfaces:**
- Consumes: `partialExitUnit` from Task 2.
- Produces: CLI verb `trade exit <id> --unit N --price P --fraction f`.

**Context:** `--fraction` requires `--unit`; "partially exit every open unit" is ambiguous and must reject rather than guess. `finite` from `./args.ts` parses a float without a positivity constraint; the range check lives in `partialExitUnit`, but the `--unit` pairing must be checked in the CLI where the flags are visible.

- [ ] **Step 1: Write the failing test**

Add to `src/cli/trade.test.ts`. That file already defines `withHarness`, `OPEN_ARGS`, and imports `handle` from `./trade.ts`; commands are invoked as `handle(verb, argv)`:

```ts
test("exit --fraction requires --unit", async () => {
  await withHarness(async () => {
    await handle("open", OPEN_ARGS);
    await assert.rejects(
      () => handle("exit", ["1", "--price", "120", "--fraction", "0.5"]),
      (e: Error & { code?: string }) =>
        e.code === "VALIDATION" && /--fraction requires --unit/.test(e.message),
    );
  });
});

test("exit --fraction 1 points at plain exit", async () => {
  await withHarness(async () => {
    await handle("open", OPEN_ARGS);
    await assert.rejects(
      () => handle("exit", ["1", "--unit", "1", "--price", "120", "--fraction", "1"]),
      (e: Error & { code?: string }) =>
        e.code === "VALIDATION" && /without --fraction/.test(e.message),
    );
  });
});

test("exit --fraction 0 is rejected", async () => {
  await withHarness(async () => {
    await handle("open", OPEN_ARGS);
    await assert.rejects(
      () => handle("exit", ["1", "--unit", "1", "--price", "120", "--fraction", "0"]),
      (e: Error & { code?: string }) => e.code === "VALIDATION",
    );
  });
});

test("exit --fraction banks half and leaves the trade open", async () => {
  await withHarness(async () => {
    await handle("open", OPEN_ARGS);
    const out = await handle("exit", [
      "1", "--unit", "1", "--price", "120", "--fraction", "0.5",
    ]) as {
      partial: boolean;
      closed_notional: number;
      remaining_notional: number;
      trade: { status: string };
      summary: { open_units: number; closed_units: number; avg_entry: number | null };
    };
    assert.equal(out.partial, true);
    assert.equal(out.closed_notional, 500);
    assert.equal(out.remaining_notional, 500);
    assert.equal(out.trade.status, "open");
    assert.equal(out.summary.open_units, 1);
    assert.equal(out.summary.closed_units, 1);
    assert.equal(out.summary.avg_entry, 100);
  });
});
```

`OPEN_ARGS` opens BTC long at price 100, stop 90, risk 100, notional 1000, which is what makes the numbers above come out round.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/cli/trade.test.ts`
Expected: FAIL — commander reports `unknown option '--fraction'`.

- [ ] **Step 3: Write minimal implementation**

`src/cli/trade.ts:29` — extend the type:

```ts
type ExitOpts = { price?: string; unit?: string; date?: string; funding?: string; fraction?: string };
```

Add the option to the `exit` command (after the `--funding` option, line 92):

```ts
    .option("--fraction <N>", "bank only this fraction of one unit, 0 < N < 1; requires --unit")
```

Replace the `exit` function body (lines 215-222):

```ts
function exit(raw: string | undefined, opts: ExitOpts): Promise<unknown> {
  return withDb((db) => {
    const id = tradeId(raw);
    const funding = opts.funding === undefined
      ? undefined
      : num(opts.funding, "funding", -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    const price = positive(opts.price, "price");
    const on = opts.date ?? todayNY();
    const seq = unitSeq(opts.unit);

    if (opts.fraction !== undefined) {
      if (seq === undefined) {
        throw new JanusError("VALIDATION", "--fraction requires --unit: it banks part of one unit");
      }
      const fraction = finite(opts.fraction, "fraction");
      if (fraction === 1) {
        throw new JanusError("VALIDATION", "--fraction 1 closes the unit; use exit without --fraction");
      }
      const res = partialExitUnit(db, id, seq, price, on, fraction, funding);
      return { partial: true, ...res, ...(getTrade(db, id) as object) };
    }

    const res = exitUnits(db, id, price, on, seq, funding);
    return { ...res, ...(getTrade(db, id) as object) };
  });
}
```

Update the imports at `src/cli/trade.ts:3` and `:7`:

```ts
import { openTrade, addUnit, setStop, exitUnits, partialExitUnit, getTrade, listTrades } from "../db/repo/trade.ts";
import { csv, finite, num, oneOf, positive, readText, required, unknownVerb } from "./args.ts";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/cli/trade.test.ts`
Expected: PASS

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/trade.ts src/cli/trade.test.ts
git commit -m "feat: add --fraction to trade exit for partial banking"
```

---

### Task 4: The decay gate

**Files:**
- Modify: `src/domain/gates.ts` (new export after `persistenceGate`, which ends ~line 72)
- Modify: `src/domain/params.ts` (two entries near `signal_persist_days`, line 36)
- Create: `src/domain/gates.test.ts`

**Interfaces:**
- Consumes: `ScoreResult` (already imported by `gates.ts`).
- Produces: `export function decayGate(conviction: number, side: "long" | "short" | null, recentScores: ScoreResult[], params: Record<string, number>): boolean`
- Produces params: `decay_conviction_floor` (4), `decay_persist_days` (2).

**Context:** This is the missing source for `deriveLadderPlan`'s `decaySignal` input. `ladder.ts:101` already claims decay is *"confirmed over two run-days"* but nothing upstream ever confirmed it. A direction flip is deliberately **not** a decay condition — the existing EXIT branch (`score.ts:450`) covers it. Mirror `persistenceGate` (`gates.ts:40-68`), which walks `recentScores` newest-first and breaks at the first miss.

- [ ] **Step 1: Write the failing test**

Create `src/domain/gates.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { decayGate } from "./gates.ts";
import type { ScoreResult } from "./score.ts";

const PARAMS = { decay_conviction_floor: 4, decay_persist_days: 2 };

// Only direction and conviction are read; the rest satisfies the type.
function score(direction: number, conviction: number): ScoreResult {
  return {
    direction,
    conviction,
    directive: "HOLD",
    plan: { directive: "HOLD", reason: "", size_tier: "full", signal_gate: "pass",
      persistence_gate: "pass", trend_gate: "pass", binary_gate: "pass",
      heat_gate: "pass", flipflop_gate: "n/a" },
    results: {},
  } as ScoreResult;
}

test("decay fires at exactly N consecutive sub-floor days", () => {
  assert.equal(decayGate(3, "long", [score(1, 3)], PARAMS), true, "today plus one prior = 2");
});

test("one sub-floor day alone is not decay", () => {
  assert.equal(decayGate(3, "long", [score(1, 8)], PARAMS), false);
});

test("a good day resets the run", () => {
  assert.equal(decayGate(3, "long", [score(1, 8), score(1, 3)], PARAMS), false);
});

test("conviction at or above the floor is never decay", () => {
  assert.equal(decayGate(4, "long", [score(1, 1), score(1, 1)], PARAMS), false);
  assert.equal(decayGate(9, "long", [score(1, 1), score(1, 1)], PARAMS), false);
});

test("an opposite-side prior score breaks the run", () => {
  assert.equal(decayGate(3, "long", [score(-1, 3)], PARAMS), false);
});

test("a flat position never decays, since there is no side to match", () => {
  assert.equal(decayGate(3, null, [score(1, 3)], PARAMS), false);
});

test("decay_persist_days 1 fires on today alone", () => {
  assert.equal(decayGate(3, "long", [], { ...PARAMS, decay_persist_days: 1 }), true);
});

test("missing params fall back to floor 4 over 2 days", () => {
  assert.equal(decayGate(3, "long", [score(1, 3)], {}), true);
  assert.equal(decayGate(5, "long", [score(1, 3)], {}), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/domain/gates.test.ts`
Expected: FAIL — `decayGate` is not exported from `./gates.ts`.

- [ ] **Step 3: Write minimal implementation**

Add to `src/domain/gates.ts` after `persistenceGate`:

```ts
/**
 * Signal decay: conviction has sat below the floor for N consecutive run-days
 * on the side we are actually holding. One bad print is noise, which is why
 * this needs persistence — the ladder turns a true reading into a full exit.
 *
 * A direction flip is not decay. The EXIT directive branch already owns that.
 */
export function decayGate(
  conviction: number,
  side: "long" | "short" | null,
  recentScores: ScoreResult[],
  params: Record<string, number>,
): boolean {
  const floor = params["decay_conviction_floor"] ?? 4;
  const required = Math.max(1, Math.round(params["decay_persist_days"] ?? 2));
  if (conviction >= floor) return false;
  let count = 1; // today is the first decay day
  for (const s of recentScores) {
    const sameSide = side !== null &&
      ((side === "long" && s.direction > 0) || (side === "short" && s.direction < 0));
    if (sameSide && s.conviction < floor) count++;
    else break;
  }
  return count >= required;
}
```

Add to `DEFAULT_PARAMS` in `src/domain/params.ts`, next to `signal_persist_days` on line 36:

```ts
  decay_conviction_floor: 4,
  decay_persist_days: 2,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/domain/gates.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/domain/gates.ts src/domain/params.ts src/domain/gates.test.ts
git commit -m "feat: add decayGate, a persistence-confirmed conviction collapse"
```

---

### Task 5: Fix the two latent defects

**Files:**
- Modify: `src/db/repo/score.ts:210-266` (delete the duplicate plan reader)
- Modify: `src/cli/score.ts:105` (deepen the `recentScores` window)
- Test: `src/db/repo/score.test.ts`

**Interfaces:**
- Consumes: `scorePlanFromResults` from `src/domain/directive.ts:159`.
- Produces: `stop_plan.new_stop` survives a round-trip through the database.

**Context:** Two pre-existing bugs that only become visible once the ladder starts producing values, so they are fixed before it is wired up.

1. `planToResults` writes `stop_new_stop` (`directive.ts:142`) and `scorePlanFromResults` restores it (`directive.ts:190`) — but `repo/score.ts:242-249` is a **near-duplicate reader that silently omits `new_stop`**. `new_stop` is the ladder's primary output; every trailing stop would vanish on reload.
2. `cli/score.ts:105` fetches recent scores with `LIMIT = signal_persist_days` (default 2). If `decay_persist_days` is larger, `decayGate` cannot see enough history and can never fire.

- [ ] **Step 1: Write the failing test**

Add to `src/db/repo/score.test.ts`:

```ts
test("stop_plan.new_stop survives a record/read round-trip", () => {
  const db = fresh();
  const assetId = requireAssetBySymbol(db, "BTC").id;
  const plan = {
    directive: "HOLD" as const,
    reason: "trailing",
    size_tier: "full" as const,
    signal_gate: "pass" as const,
    persistence_gate: "pass" as const,
    trend_gate: "pass" as const,
    binary_gate: "pass" as const,
    heat_gate: "pass" as const,
    flipflop_gate: "n/a" as const,
    stop_plan: {
      action: "trail" as const,
      affected_units: "all" as const,
      new_stop: 61240.5,
      rationale: "runner phase: trail stop behind price",
    },
  };
  recordScore(db, DATE, assetId, {
    direction: 1, conviction: 7, directive: "HOLD",
    queue_reason: "position", position_state: "long",
    rationale: "trailing", metrics: {}, results: planToResults(plan),
  }, NOW);

  const back = getScore(db, DATE, assetId);
  assert.equal(back?.plan?.stop_plan?.new_stop, 61240.5);
});
```

Import `planToResults` from `../../domain/directive.ts`. Match the exact `ScoreRow` shape the file's other `recordScore` calls use.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/db/repo/score.test.ts`
Expected: FAIL — `new_stop` is `undefined`, because the reader in `repo/score.ts` drops it.

- [ ] **Step 3: Write minimal implementation**

In `src/db/repo/score.ts`, delete the hand-rolled plan reconstruction (the block spanning roughly lines 210-266 that builds `plan`, `entry_plan`, `stop_plan`, `trim_plan`, `sizing_plan` from `results`) and call the canonical one instead:

```ts
import { scorePlanFromResults } from "../../domain/directive.ts";
```

Replace the reconstruction with:

```ts
  const plan = scorePlanFromResults(results);
```

Two readers for one format was the bug. Keep the one in `directive.ts`, beside the writer it must stay in sync with.

In `src/cli/score.ts:105`, deepen the window so the decay gate can see its own history:

```ts
    // The window must cover the deepest gate that reads it, not just persistence.
    const recentDays = Math.max(
      params["signal_persist_days"] ?? 2,
      params["decay_persist_days"] ?? 2,
    );
    const recent = recentScores(db, asset.id, session.session_date, recentDays);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/db/repo/score.test.ts`
Expected: PASS

Run: `npm test`
Expected: PASS. `scorePlanFromResults` returns `ScorePlan | undefined`; adjust the call site's typing if the old code assumed non-undefined.

- [ ] **Step 5: Commit**

```bash
git add src/db/repo/score.ts src/cli/score.ts src/db/repo/score.test.ts
git commit -m "fix: stop dropping new_stop on read and deepen the score window"
```

---

### Task 6: `stop_plan` carries `event` and `trim_fraction`

**Files:**
- Modify: `src/domain/directive.ts:61-68` (type), `:138-143` (writer), `:184-192` (reader)
- Test: `src/domain/directive.test.ts`

**Interfaces:**
- Consumes: `LadderEvent` from `src/domain/ladder.ts:4`.
- Produces: `stop_plan.event?: LadderEvent` and `stop_plan.trim_fraction?: number`, persisted as `stop_event` and `stop_trim_fraction`.

**Context:** The operator needs to know which rung fired and what fraction to hand to `trade exit --fraction`. Follow the existing key-naming convention in `planToResults`.

- [ ] **Step 1: Write the failing test**

Add to `src/domain/directive.test.ts`:

```ts
test("stop_plan event and trim_fraction round-trip through results", () => {
  const plan = {
    directive: "HOLD" as const, reason: "banking", size_tier: "full" as const,
    signal_gate: "pass" as const, persistence_gate: "pass" as const,
    trend_gate: "pass" as const, binary_gate: "pass" as const,
    heat_gate: "pass" as const, flipflop_gate: "n/a" as const,
    stop_plan: {
      action: "trail" as const, affected_units: "newest" as const,
      event: "partial" as const, trim_fraction: 0.5,
      rationale: "unrealized R 1.62 reached +1.5R; bank partial and open add window",
    },
  };
  const results = planToResults(plan);
  assert.equal(results["stop_event"], "partial");
  assert.equal(results["stop_trim_fraction"], 0.5);

  const back = scorePlanFromResults(results);
  assert.equal(back?.stop_plan?.event, "partial");
  assert.equal(back?.stop_plan?.trim_fraction, 0.5);
});

test("a stop_plan without event or trim_fraction omits both keys", () => {
  const plan = {
    directive: "HOLD" as const, reason: "hold", size_tier: "full" as const,
    signal_gate: "pass" as const, persistence_gate: "pass" as const,
    trend_gate: "pass" as const, binary_gate: "pass" as const,
    heat_gate: "pass" as const, flipflop_gate: "n/a" as const,
    stop_plan: { action: "hold" as const, affected_units: "all" as const, rationale: "no change" },
  };
  const results = planToResults(plan);
  assert.equal(results["stop_event"], undefined);
  assert.equal(results["stop_trim_fraction"], undefined);
  assert.equal(scorePlanFromResults(results)?.stop_plan?.trim_fraction, undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/domain/directive.test.ts`
Expected: FAIL — TypeScript rejects `event` on `stop_plan`, and `stop_event` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

`src/domain/directive.ts` — add the import:

```ts
import type { LadderEvent } from "./ladder.ts";
```

Extend the `stop_plan` type (lines 61-68):

```ts
  /** Recommended stop/exit management for open units. */
  stop_plan?: {
    action: "move_to_breakeven" | "trail" | "tighten" | "time_exit" | "decay_exit" | "hold";
    /** Which units the action targets. */
    affected_units: "all" | "oldest" | "newest" | "partial_target" | string;
    /** Optional computed stop price, e.g. from ATR trailing. */
    new_stop?: number;
    /** Which ladder rung produced this, when the stop ladder was the source. */
    event?: LadderEvent;
    /** Fraction of the affected unit to bank, for the partial rung. */
    trim_fraction?: number;
    rationale: string;
  };
```

Extend the writer (after line 142):

```ts
    if (plan.stop_plan.event !== undefined) r["stop_event"] = plan.stop_plan.event;
    if (plan.stop_plan.trim_fraction !== undefined) {
      r["stop_trim_fraction"] = plan.stop_plan.trim_fraction;
    }
```

Extend the reader (inside the `stop_plan` block at lines 186-191):

```ts
      event: results["stop_event"] as LadderEvent | undefined,
      trim_fraction: results["stop_trim_fraction"] === undefined
        ? undefined
        : Number(results["stop_trim_fraction"]),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/domain/directive.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/domain/directive.ts src/domain/directive.test.ts
git commit -m "feat: carry ladder event and trim fraction on stop_plan"
```

---

### Task 7: Load the open trade into `ScoreContext`

**Files:**
- Modify: `src/db/repo/trade.ts` (new export beside `getTrade`, line 153)
- Modify: `src/domain/score.ts:36-59` (`ScoreContext`)
- Modify: `src/cli/score.ts:106-126` (context assembly)
- Test: `src/db/repo/trade.test.ts`

**Interfaces:**
- Consumes: `UnitRow` from `src/domain/trade-math.ts`.
- Produces:
```ts
export type OpenTradeState = {
  direction: "long" | "short";
  units: UnitRow[];
  entry_price: number;
  initial_risk: number;
  opened_on: string;
};
export function openTradeForAsset(db: DatabaseSync, assetId: number): OpenTradeState | null
```
plus `ScoreContext.open_trade?: OpenTradeState | null`.

**Context:** `deriveScore` is pure and never touches the database, so trade state arrives through context. This is the trade-level counterpart to `positionOf` (`repo/score.ts:56`), which returns only side and unit count. `entry_price` is `trade.initial_price` — that is the reference the ladder's unrealized-R calculation uses.

- [ ] **Step 1: Write the failing test**

Add to `src/db/repo/trade.test.ts`:

```ts
test("openTradeForAsset returns null when flat", () => {
  const db = fresh();
  assert.equal(openTradeForAsset(db, requireAssetBySymbol(db, "BTC").id), null);
  db.close();
});

test("openTradeForAsset returns the trade with its units", () => {
  const db = fresh();
  const assetId = requireAssetBySymbol(db, "BTC").id;
  const id = openTrade(db, { ...input, asset_id: assetId }, NOW);
  addUnit(db, id, { entry_on: DATE, price: 110, stop: 100, risk: 100, notional: 1100 });

  const state = openTradeForAsset(db, assetId)!;
  assert.equal(state.direction, "long");
  assert.equal(state.entry_price, 100, "entry_price is the trade's initial_price");
  assert.equal(state.initial_risk, 100);
  assert.equal(state.opened_on, DATE);
  assert.equal(state.units.length, 2);
  db.close();
});

test("openTradeForAsset includes closed units, so the ladder can see prior exits", () => {
  const db = fresh();
  const assetId = requireAssetBySymbol(db, "BTC").id;
  const id = openTrade(db, { ...input, asset_id: assetId }, NOW);
  partialExitUnit(db, id, 1, 120, DATE, 0.5);
  const state = openTradeForAsset(db, assetId)!;
  assert.equal(state.units.length, 2);
  assert.equal(state.units.filter((u) => u.status === "closed").length, 1);
  assert.equal(state.units.find((u) => u.seq === 1)?.partial_exited, 1);
  db.close();
});

test("openTradeForAsset returns null once the trade closes", () => {
  const db = fresh();
  const assetId = requireAssetBySymbol(db, "BTC").id;
  const id = openTrade(db, { ...input, asset_id: assetId }, NOW);
  exitUnits(db, id, 120, DATE);
  assert.equal(openTradeForAsset(db, assetId), null);
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/db/repo/trade.test.ts`
Expected: FAIL — `openTradeForAsset` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `src/db/repo/trade.ts` beside `getTrade` (line 153):

```ts
/**
 * The open trade for an asset with every unit, for the stop ladder. The
 * trade-level counterpart to positionOf, which reports only side and count.
 * Closed units come along: the ladder reads prior exits to decide which rung
 * it is on.
 */
export function openTradeForAsset(db: DatabaseSync, assetId: number): OpenTradeState | null {
  const row = db
    .prepare(
      `SELECT id, direction, initial_price, initial_risk, opened_on
       FROM trade WHERE asset_id = ? AND status = 'open'`,
    )
    .get(assetId) as
      | { id: number; direction: "long" | "short"; initial_price: number; initial_risk: number; opened_on: string }
      | undefined;
  if (row === undefined) return null;
  return {
    direction: row.direction,
    units: unitsOf(db, row.id),
    entry_price: row.initial_price,
    initial_risk: row.initial_risk,
    opened_on: row.opened_on,
  };
}
```

And the exported type near the other types at the top of the file:

```ts
export type OpenTradeState = {
  direction: "long" | "short";
  units: UnitRow[];
  entry_price: number;
  initial_risk: number;
  opened_on: string;
};
```

In `src/domain/score.ts`, add to `ScoreContext` after `previous_score`:

```ts
  /** The open trade for this asset, if any, for the stop ladder. */
  open_trade?: import("../db/repo/trade.ts").OpenTradeState | null;
```

In `src/cli/score.ts`, add to the `context` object literal (after `previous_score: previous,`):

```ts
      open_trade: openTradeForAsset(db, asset.id),
```

and add `openTradeForAsset` to the existing import from `../db/repo/trade.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/db/repo/trade.test.ts`
Expected: PASS

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/repo/trade.ts src/domain/score.ts src/cli/score.ts src/db/repo/trade.test.ts
git commit -m "feat: load the open trade into ScoreContext for the ladder"
```

---

### Task 8: Wire the ladder into `derivePlan`

**Files:**
- Modify: `src/domain/score.ts` — imports, inside `derivePlan` (starts line 306), and the final `return { plan, sizingPlan };`
- Test: `src/domain/score.test.ts`

**Interfaces:**
- Consumes: `deriveLadderPlan` and `LadderPlan` (`src/domain/ladder.ts`), `decayGate` (Task 4), `ScoreContext.open_trade` (Task 7), `stop_plan.event` / `.trim_fraction` (Task 6).
- Produces: `stop_plan` sourced from the ladder; `time_stop` and `decay_exit` escalate the directive to `EXIT`.

**Context:** This is the task the other seven exist for. `derivePlan` has many early returns but a **single final `return { plan, sizingPlan };`**, with `plan` declared `let` — so the overlay goes in at exactly one place, after the persistence rule has finished. Precedence, per the spec:

- `EXIT` / `STAND_ASIDE` keep their existing literal.
- Any other directive with an open trade takes the ladder's `stop_plan`.
- `time_stop` or `decay_exit` escalates the directive to `EXIT` and appends `(ladder: <rationale>)` to `reason`.
- No open trade leaves everything unchanged.

Inside `derivePlan`, `position` is the `PositionState` parameter, `trend` comes from the `runGates` destructure, and `conviction` is the rounded integer.

- [ ] **Step 1: Write the failing test**

Add to `src/domain/score.test.ts`. That file already defines `flat` (a `ScoreContext` that concludes nothing), `ctx(macroRegime, clusterRegime)`, and the metrics factory `m(catalyst, trend, secular, crowding, capitulation, divergence, confidence?)`, and imports `DEFAULT_PARAMS`.

First the helpers. `CoverageValues` is a wide flat record, so build it once:

```ts
import type { CoverageValues } from "./coverage.ts";

function coverage(mark: number, atr14: number): CoverageValues {
  return {
    open: mark, high: mark, low: mark, close: mark, volume: 0,
    mark_price: mark, index_price: mark, open_interest: null, daily_change_pct: null,
    sma20: null, sma50: null, sma200: null, ema12: null, ema26: null, atr14,
    px_vs_sma20: null, px_vs_sma50: null, px_vs_sma200: null,
    cross_50_200: null, cross_50_200_age: null, cross_px_50: null, cross_px_50_age: null,
    bars_available: 200, fetched_at: "2026-07-31T00:00:00Z",
  };
}

/**
 * BTC long, one open unit: entry 100, notional 1000 (size 10), risk 100.
 *
 * `stop` matters more than it looks. The ladder checks the breakeven rung
 * (ladder.ts:118) before partial or runner, and it fires whenever the oldest
 * unit's stop is still below entry. A fixture left at stop 90 therefore returns
 * `breakeven` no matter how far price has run. Pass stop 100 — already at
 * breakeven — to let a test reach the later rungs.
 */
function contextWithOpenTrade(opts: {
  mark: number;
  atr14: number;
  stop?: number;
  partialExited?: boolean;
  openedOn?: string;
}): ScoreContext {
  return {
    ...ctx(0, null),
    positions: [{ symbol: "BTC", side: "long", units: 1 }],
    asset: { ...flat.asset, coverage: coverage(opts.mark, opts.atr14) },
    open_trade: {
      direction: "long",
      units: [{
        seq: 1, entry_price: 100, notional: 1000, risk: 100, stop: opts.stop ?? 90,
        status: "open", exit_price: null, funding: 0, tag: null,
        partial_exited: opts.partialExited === true ? 1 : 0,
      }],
      entry_price: 100,
      initial_risk: 100,
      opened_on: opts.openedOn ?? "2026-07-01",
    },
  };
}

function contextFlat(): ScoreContext {
  return { ...ctx(0, null), open_trade: null };
}

// Starting points for the factor inputs. Each test asserts the directive it
// expects; if the weights land elsewhere, adjust these FIXTURE INPUTS until
// the asserted directive comes out. Never weaken an assertion to match what
// the code produced — the assertions encode the spec's precedence rules.
const holdMetrics = m(0, 1, 0, 50, false, false);
const exitMetrics = m(-2, -2, -2, 50, false, false);
const initiateMetrics = m(2, 2, 1, 50, false, false);
const PARAMS = DEFAULT_PARAMS;
```

Then the cases:

```ts
test("a HOLD takes its stop_plan from the ladder", () => {
  // stop 100 = already at breakeven, mark 130 = +3R with a partial banked,
  // so the ladder lands on the runner rung.
  const c = contextWithOpenTrade({ mark: 130, atr14: 5, stop: 100, partialExited: true });
  const { plan } = deriveScore(holdMetrics, c, PARAMS);
  assert.equal(plan.directive, "HOLD");
  assert.equal(plan.stop_plan?.event, "runner");
  assert.equal(plan.stop_plan?.action, "trail");
  // mark 130 - 2 * atr 5 = 120, floored at entry 100
  assert.equal(plan.stop_plan?.new_stop, 120);
  assert.notEqual(plan.stop_plan?.rationale, "review stop/exit plan, no change today");
});

test("a stop still below entry puts the ladder on the breakeven rung", () => {
  const c = contextWithOpenTrade({ mark: 130, atr14: 5, stop: 90 });
  const { plan } = deriveScore(holdMetrics, c, PARAMS);
  assert.equal(plan.stop_plan?.event, "breakeven");
  assert.equal(plan.stop_plan?.action, "move_to_breakeven");
  assert.equal(plan.stop_plan?.new_stop, 100);
});

test("a ladder time_stop escalates a HOLD to EXIT", () => {
  // opened 2026-01-01 against session_date 2026-07-31 is well past 42 days
  const c = contextWithOpenTrade({ mark: 105, atr14: 5, stop: 100, openedOn: "2026-01-01" });
  const { plan } = deriveScore(holdMetrics, c, PARAMS);
  assert.equal(plan.directive, "EXIT");
  assert.equal(plan.stop_plan?.event, "time_stop");
  assert.match(plan.reason, /\(ladder: position open \d+ days, time stop reached\)/);
});

test("an EXIT directive keeps its own stop_plan", () => {
  const c = contextWithOpenTrade({ mark: 130, atr14: 5, stop: 100, partialExited: true });
  const { plan } = deriveScore(exitMetrics, c, PARAMS);
  assert.equal(plan.directive, "EXIT");
  assert.equal(plan.stop_plan?.rationale, "exit entire position");
  assert.equal(plan.stop_plan?.event, undefined, "the ladder must not overwrite an EXIT");
});

test("with no open trade the entry plan is unchanged", () => {
  const { plan } = deriveScore(initiateMetrics, contextFlat(), PARAMS);
  assert.equal(plan.stop_plan?.rationale, "initial stop set at entry");
  assert.equal(plan.stop_plan?.event, undefined);
});

test("a banked partial moves the ladder off the partial rung", () => {
  const noPartial = contextWithOpenTrade({ mark: 130, atr14: 5, stop: 100, partialExited: false });
  assert.equal(deriveScore(holdMetrics, noPartial, PARAMS).plan.stop_plan?.event, "partial");
  const banked = contextWithOpenTrade({ mark: 130, atr14: 5, stop: 100, partialExited: true });
  assert.equal(deriveScore(holdMetrics, banked, PARAMS).plan.stop_plan?.event, "runner");
});

test("the partial rung passes the trim fraction through", () => {
  const c = contextWithOpenTrade({ mark: 130, atr14: 5, stop: 100, partialExited: false });
  const { plan } = deriveScore(holdMetrics, c, PARAMS);
  assert.equal(plan.stop_plan?.trim_fraction, 0.5);
  assert.equal(plan.stop_plan?.affected_units, "newest");
});
```

Note on the fixture arithmetic: at mark 130 the unit's size is 10, so unrealized P&L is `(130 - 100) * 10 = 300` against `initial_risk` 100 — +3R, past both the +1R breakeven rung and the +1.5R partial rung. Which rung actually fires is then decided by `stop`, per the helper's docstring above.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/domain/score.test.ts`
Expected: FAIL — `stop_plan.event` is `undefined` everywhere; `rationale` still reads `"review stop/exit plan, no change today"`.

- [ ] **Step 3: Write minimal implementation**

Add imports to `src/domain/score.ts`:

```ts
import { deriveLadderPlan, type LadderPlan } from "./ladder.ts";
import { decayGate } from "./gates.ts";
```

(`gates.ts` is already imported for `runGates` — extend that import rather than adding a second one.)

Inside `derivePlan`, after the `runGates` destructure (which ends line 334) so `trend` is in scope:

```ts
  // The stop ladder, for an asset we actually hold. It owns stop management;
  // the directive branches below own the exit decision.
  const openTrade = context.open_trade ?? null;
  const ladder: LadderPlan | null = openTrade === null ? null : deriveLadderPlan({
    direction: openTrade.direction,
    units: openTrade.units,
    entryPrice: openTrade.entry_price,
    initialRisk: openTrade.initial_risk,
    coverage: context.asset.coverage,
    openedOn: openTrade.opened_on,
    today: context.session_date,
    addWindowOpen: openTrade.units.some((u) => u.partial_exited === 1),
    lateTrend: trend === "late_trend",
    decaySignal: decayGate(conviction, position.side, context.recent_scores ?? [], params),
    params,
  });
```

Add the overlay helper at module level in `score.ts`:

```ts
/**
 * Overlay the stop ladder on a directive plan. The directive owns whether we
 * are getting out; the ladder owns how the stop is managed while we are in.
 * The two exceptions are time_stop and decay_exit, which are unconditional
 * risk rules — they escalate rather than sit quietly under a HOLD.
 */
function applyLadder(plan: ScorePlan, ladder: LadderPlan | null): ScorePlan {
  if (ladder === null) return plan;
  if (plan.directive === "EXIT" || plan.directive === "STAND_ASIDE") return plan;

  const next: ScorePlan = {
    ...plan,
    stop_plan: {
      action: ladder.action,
      affected_units: ladder.affected_units,
      rationale: ladder.rationale,
      event: ladder.event,
      ...(ladder.new_stop === undefined ? {} : { new_stop: ladder.new_stop }),
      ...(ladder.trim_fraction === undefined ? {} : { trim_fraction: ladder.trim_fraction }),
    },
  };

  if (ladder.event === "time_stop" || ladder.event === "decay_exit") {
    return {
      ...next,
      directive: "EXIT",
      reason: `${next.reason} (ladder: ${ladder.rationale})`,
    };
  }
  return next;
}
```

Change the final line of `derivePlan` from `return { plan, sizingPlan };` to:

```ts
  return { plan: applyLadder(plan, ladder), sizingPlan };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/domain/score.test.ts`
Expected: PASS

Run: `npm test`
Expected: PASS. Existing `score.test.ts` cases that assert the old hardcoded `stop_plan` rationales for assets **with** an open trade will now legitimately fail — update them to the ladder's rationale. Cases with no open trade must be unchanged; if one changes, the precedence logic is wrong.

- [ ] **Step 5: Commit**

```bash
git add src/domain/score.ts src/domain/score.test.ts
git commit -m "feat: wire the stop ladder into deriveScore's stop_plan"
```

---

## Verification

- [ ] `npm test` passes.
- [ ] `npm run build` (`tsc -p .`) reports no type errors.
- [ ] `node src/cli.ts init` against a scratch `JANUS_DB` reports `schema_version: 2`.
- [ ] Manual smoke, against a scratch database only:

```bash
export JANUS_DB=/tmp/janus-smoke.db
node src/cli.ts init
# open a trade, then bank half a unit
node src/cli.ts trade exit 1 --unit 1 --price 120 --fraction 0.5
node src/cli.ts trade show 1   # open_units 1, closed_units 1, avg_entry unchanged
```

## Out of Scope

- `trade_event` audit logging. The table stays, unused.
- A standalone `trade ladder <id>` command.
- Undoing a trade exit (no `unexit` verb).
