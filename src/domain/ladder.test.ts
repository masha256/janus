import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveLadderPlan, isStopWidening, proposeTrailingStop } from "./ladder.ts";
import type { UnitRow } from "./trade-math.ts";
import type { CoverageValues } from "./coverage.ts";

const unit = (over: Partial<UnitRow> = {}): UnitRow => ({
  seq: 1, entry_price: 100, notional: 1000, risk: 100, stop: 90,
  status: "open", exit_price: null, funding: 0, tag: null, ...over,
});

const coverage = (mark: number, atr: number): CoverageValues => ({
  open: 100, high: 110, low: 90, close: 100, volume: 1000,
  mark_price: mark,
  index_price: mark, open_interest: 0, daily_change_pct: 0,
  ema12: 100, ema26: 100,
  sma20: 100, sma50: 100, sma200: 100,
  px_vs_sma20: 0, px_vs_sma50: 0, px_vs_sma200: 0,
  cross_50_200: null, cross_50_200_age: null,
  cross_px_50: null, cross_px_50_age: null,
  atr14: atr,
  funding_rate: null, funding_ref: null,
  bars_available: 250,
  fetched_at: "",
});

  const runnerUnit = (over: Partial<UnitRow> = {}): UnitRow =>
    unit({ seq: 1, entry_price: 100, stop: 100, partial_exited: 1, ...over });

  const daysBetween = (a: string, b: string): number =>
    Math.round((Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / 86_400_000);

  const baseInputs = {
    direction: "long" as const,
    entryPrice: 100,
    initialRisk: 100,
    openedOn: "2026-08-01",
    today: "2026-08-01",
    addWindowOpen: false,
    lateTrend: false,
    decaySignal: false,
    params: {
      breakeven_trigger_r: 1,
      partial_trigger_r: 1.5,
      partial_exit_fraction: 0.5,
      trailing_atr_multiple: 2,
      max_time_stop_days: 42,
    },
  };

test("entry phase returns hold", () => {
  const plan = deriveLadderPlan({
    ...baseInputs,
    units: [unit()],
    coverage: coverage(100, 5),
  });
  assert.equal(plan.event, "entry");
  assert.equal(plan.action, "hold");
});

test("+1R moves oldest unit to breakeven", () => {
  // initialRisk 100 with size 10, stop 90: distance 10, so +1R PnL = 100 -> mark 110
  const plan = deriveLadderPlan({
    ...baseInputs,
    units: [unit({ stop: 90 })],
    coverage: coverage(110, 5),
  });
  assert.equal(plan.event, "breakeven");
  assert.equal(plan.action, "move_to_breakeven");
  assert.equal(plan.new_stop, 100);
});

test("entry remains entry when stop is still behind price", () => {
  const plan = deriveLadderPlan({
    ...baseInputs,
    units: [unit({ stop: 90 })],
    coverage: coverage(100, 5),
  });
  assert.equal(plan.event, "entry");
});

test("+1.5R recommends partial on newest unit", () => {
  const plan = deriveLadderPlan({
    ...baseInputs,
    units: [unit({ seq: 1, entry_price: 100, stop: 100 }), unit({ seq: 2, entry_price: 110, stop: 105 })],
    coverage: coverage(115, 5),
  });
  assert.equal(plan.event, "partial");
  assert.equal(plan.action, "trail");
  assert.equal(plan.affected_units, "newest");
  assert.equal(plan.trim_fraction, 0.5);
});

test("runner phase trails stop", () => {
  const plan = deriveLadderPlan({
    ...baseInputs,
    units: [runnerUnit()],
    coverage: coverage(120, 5),
    addWindowOpen: true,
  });
  assert.equal(plan.event, "runner");
  assert.equal(plan.action, "trail");
  assert.equal(plan.new_stop, 110); // 120 - 2*5
});

test("late trend tightens stop", () => {
  const plan = deriveLadderPlan({
    ...baseInputs,
    units: [runnerUnit()],
    coverage: coverage(120, 5),
    addWindowOpen: true,
    lateTrend: true,
  });
  assert.equal(plan.event, "tighten");
  assert.equal(plan.action, "tighten");
});

test("time stop exits a position still fully at risk", () => {
  const opened = "2026-07-01";
  const today = "2026-08-12"; // 42 days later
  assert.equal(daysBetween(today, opened), 42);
  const plan = deriveLadderPlan({
    ...baseInputs,
    units: [unit({ stop: 90 })],
    coverage: coverage(100, 5),
    openedOn: opened,
    today,
  });
  assert.equal(plan.event, "time_stop");
  assert.equal(plan.action, "time_exit");
});

test("time stop spares a position that earned breakeven", () => {
  const opened = "2026-07-01";
  const today = "2026-08-12"; // 42 days later
  const plan = deriveLadderPlan({
    ...baseInputs,
    units: [runnerUnit()], // stop at entry: breakeven or better
    coverage: coverage(100, 5),
    openedOn: opened,
    today,
  });
  assert.notEqual(plan.event, "time_stop");
});

test("time stop spares a trade past +1R even if the stop lags below entry", () => {
  const opened = "2026-07-01";
  const today = "2026-08-12"; // 42 days later
  const plan = deriveLadderPlan({
    ...baseInputs,
    units: [unit({ stop: 90 })],
    coverage: coverage(115, 5), // +1.5R on initialRisk 100
    openedOn: opened,
    today,
  });
  assert.equal(plan.event, "breakeven"); // the milestone rung, not the clock
});

test("pre-breakeven decay exits full position", () => {
  const plan = deriveLadderPlan({
    ...baseInputs,
    units: [unit({ stop: 90 })],
    coverage: coverage(95, 5),
    decaySignal: true,
  });
  assert.equal(plan.event, "decay_exit");
  assert.equal(plan.action, "decay_exit");
});

test("unrealized R uses each unit's own cost basis, not the trade's entry", () => {
  // unit 1: size 10 from 100, unit 2: size 10 from 120, mark 130, initialRisk 100.
  // True PnL = 10*(130-100) + 10*(130-120) = 400, so 4.00R — not 20*(130-100)/100 = 6.00R.
  const plan = deriveLadderPlan({
    ...baseInputs,
    units: [
      unit({ seq: 1, entry_price: 100, notional: 1000, stop: 100 }),
      unit({ seq: 2, entry_price: 120, notional: 1200, stop: 120 }),
    ],
    coverage: coverage(130, 5),
  });
  assert.equal(plan.event, "partial");
  assert.match(plan.rationale, /unrealized R 4\.00 /);
});

test("the runner rung never proposes a stop wider than the current one", () => {
  // Pullback: stop already trailed to 120, mark back down to 122 with ATR 8.
  // Raw trail is 122 - 2*8 = 106, which would add 14 points of risk per unit,
  // so the rung advises nothing rather than proposing a move.
  const plan = deriveLadderPlan({
    ...baseInputs,
    units: [runnerUnit({ stop: 120 })],
    coverage: coverage(122, 8),
    addWindowOpen: true,
  });
  assert.equal(plan.event, "runner");
  assert.equal(plan.action, "hold");
  assert.equal(plan.new_stop, undefined);
});

test("isStopWidening guards long and short stops", () => {
  assert.equal(isStopWidening("long", 90, 85), true);
  assert.equal(isStopWidening("long", 90, 95), false);
  assert.equal(isStopWidening("short", 110, 115), true);
  assert.equal(isStopWidening("short", 110, 105), false);
});

test("proposeTrailingStop never widens", () => {
  assert.equal(proposeTrailingStop("long", 120, 5, 110, 2), 110);
  assert.equal(proposeTrailingStop("long", 120, 5, 108, 2), 110);
  assert.equal(proposeTrailingStop("short", 80, 5, 90, 2), 90);
  assert.equal(proposeTrailingStop("short", 80, 5, 92, 2), 90);
});

test("the runner rung holds rather than over-tightening a looser unit", () => {
  // An older unit trailed to 118 and a fresh add still at 90. The raw trail is
  // 122 - 2*8 = 106, which would widen the 118 unit — so nothing moves. The old
  // behaviour clamped to 118 and yanked the 90 unit up 28 points.
  const plan = deriveLadderPlan({
    ...baseInputs,
    units: [runnerUnit({ seq: 1, stop: 118 }), runnerUnit({ seq: 2, stop: 90 })],
    coverage: coverage(122, 8),
    addWindowOpen: true,
  });
  assert.equal(plan.action, "hold");
  assert.equal(plan.new_stop, undefined, "no unit is asked to move");
});

test("the runner rung trails every unit when the trail tightens all of them", () => {
  const plan = deriveLadderPlan({
    ...baseInputs,
    units: [runnerUnit({ seq: 1, stop: 100 }), runnerUnit({ seq: 2, stop: 100 })],
    coverage: coverage(130, 5),
    addWindowOpen: true,
  });
  assert.equal(plan.action, "trail");
  assert.equal(plan.affected_units, "all");
  assert.equal(plan.new_stop, 120); // 130 - 2*5, above both current stops
});

test("the runner rung never proposes a stop above the mark", () => {
  // Degenerate: a unit already stopped at 130 with price back at 122.
  const plan = deriveLadderPlan({
    ...baseInputs,
    units: [runnerUnit({ stop: 130 })],
    coverage: coverage(122, 8),
    addWindowOpen: true,
  });
  assert.equal(plan.action, "hold");
  assert.equal(plan.new_stop, undefined);
});

test("the runner rung ratchets correctly for shorts", () => {
  const short = { ...baseInputs, direction: "short" as const };
  // Pullback against a short: raw trail 78 + 2*4 = 86 would widen the 80 stop.
  const held = deriveLadderPlan({
    ...short,
    units: [runnerUnit({ seq: 1, stop: 80 }), runnerUnit({ seq: 2, stop: 82 })],
    coverage: coverage(78, 4),
    addWindowOpen: true,
  });
  assert.equal(held.action, "hold");
  assert.equal(held.new_stop, undefined);

  // Price falls further: raw trail 70 + 2*4 = 78 tightens both stops.
  const trailed = deriveLadderPlan({
    ...short,
    units: [runnerUnit({ seq: 1, stop: 80 }), runnerUnit({ seq: 2, stop: 82 })],
    coverage: coverage(70, 4),
    addWindowOpen: true,
  });
  assert.equal(trailed.action, "trail");
  assert.equal(trailed.new_stop, 78);
  assert.equal(isStopWidening("short", 80, trailed.new_stop!), false);
});
