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
