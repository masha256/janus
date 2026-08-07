import { test } from "node:test";
import assert from "node:assert/strict";
import { backfillInputs, computeCoverage } from "./coverage.ts";
import { JanusError } from "../output.ts";
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

// A past session date must not inherit today's prices. `run --date` used to
// stamp the newest bar and a live snapshot under whatever date it was given.
const bar = (date: string, close: number): Bar => ({
  t: Date.parse(`${date}T00:00:00Z`), o: close, h: close + 1, l: close - 1, c: close, v: 10, i: 0,
});

test("backfillInputs cuts the bar window at the session date", () => {
  const bars = [
    bar("2026-03-01", 100), bar("2026-03-02", 110), bar("2026-03-03", 120),
  ];
  const got = backfillInputs(bars, "2026-03-02");
  assert.equal(got.bars.length, 2, "the 03-03 bar is in the future for this session");
  assert.equal(got.bars.at(-1)!.c, 110);
});

test("backfillInputs reconstructs the snapshot from the bar, not from today", () => {
  const bars = [bar("2026-03-01", 100), bar("2026-03-02", 110)];
  const { snapshot } = backfillInputs(bars, "2026-03-02");
  assert.equal(snapshot.mark_price, 110, "the close stands in as the mark");
  assert.equal(snapshot.index_price, 110);
  // (110 - 100) / 100 = +10%
  assert.ok(Math.abs(snapshot.daily_price_change! - 10) < 1e-9, `got ${snapshot.daily_price_change}`);
  // No bar equivalent, so it stays absent rather than borrowing today's.
  assert.equal(snapshot.open_interest, null);
});

test("backfillInputs refuses a date earlier than every bar", () => {
  assert.throws(
    () => backfillInputs([bar("2026-03-02", 110)], "2026-03-01"),
    (e: unknown) => e instanceof JanusError && e.code === "INSUFFICIENT_HISTORY",
    "falling back to a later bar would invent the history it cannot find",
  );
});

test("a backfilled window still computes indicators off the truncated bars", () => {
  const bars = Array.from({ length: 30 }, (_, i) =>
    bar(`2026-03-${String(i + 1).padStart(2, "0")}`, 100 + i));
  const cut = backfillInputs(bars, "2026-03-20");
  const values = computeCoverage(cut.bars, cut.snapshot, "2026-03-20T00:00:00Z");
  assert.equal(values.close, 119, "the 03-20 close, not the 03-30 one");
  assert.equal(values.mark_price, 119);
  assert.equal(values.bars_available, 20);
  assert.ok(values.sma20 !== null, "20 bars is exactly enough for the 20-day");
});
