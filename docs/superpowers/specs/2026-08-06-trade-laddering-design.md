# Trade laddering: wiring `deriveLadderPlan` into the scoring pipeline

Date: 2026-08-06
Status: approved, ready for implementation planning

## Problem

`deriveLadderPlan` (`src/domain/ladder.ts:36`) is fully implemented and tested but has
no production caller. `src/cli/trade.ts` imports only `isStopWidening` from that module;
the plan function is exercised solely by `ladder.test.ts`.

Meanwhile `ScorePlan.stop_plan` (`src/domain/directive.ts:61`) carries the same shape as
`LadderPlan` minus `event` and `trim_fraction`, and `deriveScore` fills it with hardcoded
literals per directive branch — `score.ts:425`, `:450`, `:478`, `:495`, `:511`, `:540`
(`"lower conviction, protect downside"` and similar). `deriveLadderPlan` is the R-aware,
ATR-aware version of exactly that computation.

The ladder is therefore not a new feature. It is a replacement for string literals that
were placeholders, plus the recording primitive its `partial` rung depends on.

Supporting state already exists and is entirely unused today: `trade.add_window_open`,
`trade.target_price`, `trade_unit.partial_exited`, `trade_unit.breakeven_moved_at`,
`trade_unit.time_stop_date`, and the whole `trade_event` table. This change puts
`partial_exited` to work, drops the four dead columns, and keeps `trade_event` — see
Schema below. All five ladder
params already have defaults in `params.ts:70-74`.

## Decisions

| Question | Decision |
| --- | --- |
| Where the ladder plugs in | Into `deriveScore`'s `stop_plan`. No new CLI verb. |
| How a partial trim is recorded | `trade exit --unit N --fraction f`, splitting the unit. |
| Where `decaySignal` comes from | A new `decayGate`: conviction below a floor for N consecutive days. |
| Directive vs ladder conflicts | Ladder fills; directive wins on EXIT/STAND_ASIDE; hard exits escalate. |
| Staging | One plan, all pieces. |
| `add_window_open` | Derived from `partial_exited`, not stored. |
| Dead columns | Dropped in `MIGRATIONS[1]`, schema to version 2. |

## Architecture

### Ladder inputs reach the domain layer through `ScoreContext`

`deriveScore` is pure — it takes a `ScoreContext` and returns a plan, with no database
access. The ladder needs trade state that context does not carry, so it arrives as one
new optional field rather than a query inside the domain layer:

```ts
// src/domain/score.ts — ScoreContext
/** The open trade for this asset, if any, for the stop ladder. */
open_trade?: {
  direction: "long" | "short";
  units: UnitRow[];
  entry_price: number;   // trade.initial_price
  initial_risk: number;
  opened_on: string;
} | null;
```

Populated in `src/cli/score.ts` alongside the existing context assembly (~lines 105-121),
via a new `openTradeForAsset(db, assetId)` in `src/db/repo/trade.ts`, next to `getTrade`.
It is the trade-level counterpart to `positionOf` (`repo/score.ts:56`), which returns only
side and open-unit count. The ladder's remaining inputs are already present: `coverage` is
`context.asset.coverage`, `today` is `context.session_date`.

### The call site

One call in `deriveScore`, before the directive branches:

```ts
const ladder = context.open_trade === null || context.open_trade === undefined
  ? null
  : deriveLadderPlan({
      direction: context.open_trade.direction,
      units: context.open_trade.units,
      entryPrice: context.open_trade.entry_price,
      initialRisk: context.open_trade.initial_risk,
      coverage: context.asset.coverage,
      openedOn: context.open_trade.opened_on,
      today: context.session_date,
      addWindowOpen: context.open_trade.units.some((u) => u.partial_exited === 1),
      lateTrend: trend === "late_trend",
      decaySignal: decayGate(conviction, position.side, context.recent_scores ?? [], params),
      params,
    });
```

`lateTrend` maps to the existing trend gate, which already returns `"late_trend"`
(`gates.ts:96`).

### Precedence

Applied after a directive branch has chosen its plan:

- Directive is `EXIT` or `STAND_ASIDE` → keep the existing literal, discard ladder output.
- Any other directive with an open trade → `stop_plan` becomes the ladder's output.
- Ladder `event` is `time_stop` or `decay_exit` → escalate the directive to `EXIT` and
  append `(ladder: <rationale>)` to `plan.reason`. Both rungs are unconditional risk
  rules and must not sit silently underneath a `HOLD`.
- No open trade → behavior unchanged; the entry literal at `score.ts:425` stays, since
  the ladder has nothing to reason about.

### `stop_plan` gains two optional fields

```ts
stop_plan?: {
  action: "move_to_breakeven" | "trail" | "tighten" | "time_exit" | "decay_exit" | "hold";
  affected_units: "all" | "oldest" | "newest" | "partial_target" | string;
  new_stop?: number;
  event?: LadderEvent;       // which rung fired
  trim_fraction?: number;    // what fraction to bank, for the partial rung
  rationale: string;
};
```

Both round-trip through `planToResults` / `scorePlanFromResults` as `stop_event` and
`stop_trim_fraction`, following the existing key naming in `directive.ts:138-143`.

## Partial exits

Chosen approach: **split the unit into a closed sibling plus a reduced open row.**

The rationale is stated in the codebase itself, at `trade-math.ts:51`:

> Everything here is computed on read. Nothing is stored denormalized, so correcting a
> unit can never leave a stale total behind.

Storing a `realized_pnl` column on a partially-closed unit would violate that rule. A
split does not.

### Command

```
janus trade exit <trade_id> --unit N --price P --fraction f [--funding X] [--date D]
```

### Behavior, in one transaction

1. Insert a **closed sibling** row at `MAX(seq)+1` (the same allocation `addUnit` uses,
   `trade.ts:90-93`), carrying `notional * f` and `risk * f`, the **original
   `entry_price`**, `exit_price = P`, `exit_on`, `status = 'closed'`, any `--funding`,
   and the parent's `tag`.
2. Reduce the open row to `notional - closed_notional` and `risk - closed_risk`. Use
   subtraction rather than a second multiplication so the two halves sum exactly under
   floating-point rounding.
3. Set `partial_exited = 1` on the open remainder. This is the flag the ladder reads.

### Why `tradeSummary` needs no changes

- `realized_pnl` sums closed units, so it picks up the sibling automatically.
- `avg_entry` is `total_notional / openSize` over open units. Both halves share
  `entry_price`, so `notional / entry_price` stays proportional and the average is
  preserved exactly.
- `open_risk` falls by precisely the trimmed share.
- The trade stays open because an open row remains, so the existing "close the trade when
  no open units remain" check in `exitUnits` (`trade.ts:138-144`) is untouched.

`closed_units` in the summary will count the sibling. This is accepted: the sibling is a
genuinely closed slice of the position.

### Validation

- `--fraction` requires `--unit`. Without it, "partially exit every open unit" is
  ambiguous; reject rather than guess.
- `f` must be strictly between 0 and 1.
- `--fraction 1` is rejected with a message pointing at plain `exit`.
- A partial on an already-partial unit is allowed; `f` applies to the unit's *current*
  notional.

## The decay gate

New function in `src/domain/gates.ts`, mirroring the structure of `persistenceGate`
(`gates.ts:40-68`), which already walks `recentScores` newest-first counting consecutive
qualifying days and breaking at the first miss.

```ts
// Decay is a sustained conviction collapse, not one bad day.
export function decayGate(
  conviction: number,
  side: "long" | "short" | null,
  recentScores: ScoreResult[],
  params: Record<string, number>,
): boolean {
  const floor = params["decay_conviction_floor"] ?? 4;
  const required = Math.max(1, Math.round(params["decay_persist_days"] ?? 2));
  if (conviction >= floor) return false;       // today is fine -> no decay
  let count = 1;                               // today counts
  for (const s of recentScores) {
    const sameSide = side !== null &&
      ((side === "long" && s.direction > 0) || (side === "short" && s.direction < 0));
    if (sameSide && s.conviction < floor) count++;
    else break;
  }
  return count >= required;
}
```

New entries in `DEFAULT_PARAMS` (`params.ts`): `decay_conviction_floor: 4`,
`decay_persist_days: 2`.

A direction flip against an open trade is deliberately **not** a decay condition. That
case is already handled by the existing EXIT directive branch (`score.ts:450`).

This closes a loop the ladder already assumed: its post-breakeven rationale reads
`"post-breakeven signal decay confirmed over two run-days"` (`ladder.ts:101`), but nothing
upstream had ever confirmed anything.

## Two pre-existing defects to fix in the same change

Both would silently corrupt ladder output, so they are in scope.

### `stop_new_stop` is written but never read back

`planToResults` persists it (`directive.ts:142`) and `scorePlanFromResults` restores it
(`directive.ts:190`). But `repo/score.ts:242-249` is a **near-duplicate reader that omits
`new_stop`**. `new_stop` is the ladder's primary output — every trailing stop it computes
would vanish on reload.

Fix: delete the duplicate reader in `repo/score.ts` and call `scorePlanFromResults`.

### `recentScores` is fetched too shallow for the decay gate

`cli/score.ts:105` fetches with `LIMIT = params["signal_persist_days"] ?? 2`. If
`decay_persist_days` exceeds `signal_persist_days`, `decayGate` cannot see enough history
and can never fire — silently, with no error.

Fix: `LIMIT = max(signal_persist_days, decay_persist_days)`.

## Schema

### Nothing needs to be added

Verified against the production database: `PRAGMA user_version` reports `1`, and
`trade_unit.partial_exited`, `trade.add_window_open`, and the `trade_event` table are all
present. A version-1 database is one produced by `MIGRATIONS[0]`, which already contains
every column this design touches (`migrate.ts:215-216, 237-239, 244`).

Checking each piece of the design against that:

- Partial exits reuse existing columns only.
- `add_window_open` is derived, never written.
- The two decay params are rows in `global_param`, a key/value table (`migrate.ts:21`),
  with fallbacks in `DEFAULT_PARAMS`.
- `stop_event` and `stop_trim_fraction` are rows in `score_result`, also key/value.

### Four dead columns get dropped

After this change, `trade_unit.partial_exited` is live and four columns are provably
unused. `target_price` and `add_window_open` have zero references anywhere outside
`migrate.ts`. `breakeven_moved_at` and `time_stop_date` are referenced once each, and only
as optional field declarations on `UnitRow` (`trade-math.ts:13-14`) — no logic reads or
writes them.

`MIGRATIONS[1]`, taking the schema to version 2:

```sql
ALTER TABLE trade DROP COLUMN target_price;
ALTER TABLE trade DROP COLUMN add_window_open;
ALTER TABLE trade_unit DROP COLUMN breakeven_moved_at;
ALTER TABLE trade_unit DROP COLUMN time_stop_date;
```

`DROP COLUMN` requires SQLite 3.35+; `node:sqlite` bundles 3.53.1, verified. None of the
four participates in a primary key, unique constraint, or index — the only partial index
on these tables is `trade_one_open_per_asset`, over `trade(asset_id) WHERE status='open'`
(`migrate.ts:220`), which is unaffected.

`MIGRATIONS[0]` is **not** edited. An already-applied migration stays frozen; a fresh
database creates the four columns and then drops them, landing in exactly the same state
as the production database. The migration loop handles both: production at version 1 runs
`MIGRATIONS[1]` since `1 < 2`.

The matching `UnitRow` fields `breakeven_moved_at` and `time_stop_date`
(`trade-math.ts:13-14`) are removed. `partial_exited` stays and stays **optional** — it is
`NOT NULL DEFAULT 0` in the database so a real row always carries it, but typing it as
required would force every existing test fixture to be updated for no behavioral gain.
The `u.partial_exited === 1` comparison the ladder already uses is undefined-safe.

`trade_event` is **kept**. It is the natural home for the cross-session ladder audit log
listed under Out of Scope below, and an empty unused table costs nothing to leave in place.

## Testing

Node's built-in test runner, matching the existing `*.test.ts` layout.

`src/db/repo/trade.test.ts`
- A partial exit halves notional and risk, preserves `avg_entry`, and leaves the trade
  open.
- Realized P&L on the closed sibling is correct for both long and short.
- A partial on an already-partial unit compounds against current notional.
- The two halves sum to the original notional exactly.

`src/cli/trade.test.ts`
- `--fraction` without `--unit` rejects.
- `--fraction 1` rejects, pointing at plain `exit`.
- `--fraction 0` and negative fractions reject.

`src/domain/gates.test.ts`
- `decayGate` fires at exactly N consecutive sub-floor days.
- One good day resets the count.
- Returns false when today's conviction is at or above the floor, regardless of history.
- Opposite-side scores break the run.

`src/domain/score.test.ts`
- Precedence matrix: `EXIT` keeps its literal; `HOLD` takes the ladder's `stop_plan`;
  `HOLD` plus a `time_stop` event escalates to `EXIT` with the rationale appended; no open
  trade leaves entry behavior unchanged.
- `addWindowOpen` derivation: a trade with a `partial_exited` unit reaches the runner
  branch rather than re-firing `partial`.

`src/db/repo/score.test.ts`
- `new_stop` survives a record/read round-trip.

`src/db/migrate.test.ts`
- A fresh database ends at `user_version` 2 with the four columns absent and
  `partial_exited` present.
- Running `migrate` twice is a no-op the second time.
- A database seeded at version 1 with trades and units migrates without data loss: row
  counts and every surviving column value are unchanged.

## Out of scope

- **`trade_event` audit logging.** The table exists but nothing needs it yet; ladder
  history is reconstructable from `score_result` rows per session date. Add it when a
  query needs to span sessions.
- **A standalone `trade ladder <id>` command.** The scoring pipeline is the single
  consumer for now.
- **Undoing a trade exit.** Related but independent; no `unexit` verb is added here.
