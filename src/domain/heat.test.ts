import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveHeatReport, type BookPosition } from "./heat.ts";

const TODAY = "2026-08-12";
const PARAMS = { account_capital: 100000, max_heat_pct: 10, per_asset_max_notional_pct: 20 };

function pos(over: Partial<BookPosition> = {}): BookPosition {
  return {
    symbol: "BTC", cluster_key: "crypto", direction: "long",
    open_units: 1, notional: 10000, heat: 2000, first_entry_on: "2026-07-01", ...over,
  };
}

test("book heat is measured against max_heat_pct of capital", () => {
  const r = deriveHeatReport([pos({ heat: 2000 }), pos({ symbol: "ETH", heat: 1500 })], PARAMS, TODAY);
  assert.equal(r.book.heat, 3500);
  assert.equal(r.book.limit, 10000);
  assert.equal(r.book.used_pct, 35);
  assert.equal(r.book.headroom, 6500);
  assert.equal(r.book.within_limit, true);
  assert.deepEqual(r.breaches, []);
});

test("a breached guard is named, not just flagged", () => {
  const r = deriveHeatReport([pos({ heat: 12000 })], PARAMS, TODAY);
  assert.equal(r.book.within_limit, false);
  assert.equal(r.book.headroom, -2000);
  assert.equal(r.breaches.length, 1);
  assert.match(r.breaches[0]!, /book heat/);
});

test("per-asset notional is measured against its own cap", () => {
  const r = deriveHeatReport([pos({ notional: 25000 }), pos({ symbol: "ETH", notional: 5000 })], PARAMS, TODAY);
  const [btc, eth] = r.assets;
  assert.equal(btc!.notional_cap, 20000);
  assert.equal(btc!.within_notional_cap, false);
  assert.equal(btc!.notional_used_pct, 125);
  assert.equal(eth!.within_notional_cap, true);
  assert.equal(r.breaches.length, 1);
  assert.match(r.breaches[0]!, /BTC notional/);
});

// unitHeat floors at zero once a stop is at breakeven, which is what frees
// capacity. A position at zero heat is still live notional, so say so.
test("a position at zero heat is reported as free carry, not as absent", () => {
  const r = deriveHeatReport([pos({ heat: 0, notional: 10000 })], PARAMS, TODAY);
  assert.equal(r.assets[0]!.free_carry, true);
  assert.equal(r.book.heat, 0);
  assert.equal(r.book.notional, 10000, "notional is still on the book");
});

test("clusters aggregate and rank by heat, with their share of the book", () => {
  const r = deriveHeatReport([
    pos({ symbol: "BTC", cluster_key: "crypto", heat: 1000 }),
    pos({ symbol: "ETH", cluster_key: "crypto", heat: 2000 }),
    pos({ symbol: "SPY", cluster_key: "equity", heat: 1000 }),
  ], PARAMS, TODAY);
  assert.deepEqual(r.clusters.map((c) => [c.cluster_key, c.heat, c.positions]), [
    ["crypto", 3000, 2],
    ["equity", 1000, 1],
  ]);
  assert.equal(r.clusters[0]!.share_of_book_pct, 75);
});

// The longest-held unit sets the clock, matching what the time stop reads.
test("days in trade counts from the oldest open unit", () => {
  const r = deriveHeatReport([pos({ first_entry_on: "2026-07-01" })], PARAMS, TODAY);
  assert.equal(r.assets[0]!.days_in_trade, 42);
  const none = deriveHeatReport([pos({ first_entry_on: null })], PARAMS, TODAY);
  assert.equal(none.assets[0]!.days_in_trade, null);
});

test("an unclustered asset still lands in the split", () => {
  const r = deriveHeatReport([pos({ cluster_key: null })], PARAMS, TODAY);
  assert.equal(r.clusters[0]!.cluster_key, null);
});

// heatGate passes when capital is 0 ("warn but do not block"). The report has
// to take the same stance or it would read stricter than what actually blocks.
test("no declared capital means no limits, and nothing reads as breached", () => {
  const r = deriveHeatReport([pos({ heat: 999999 })], { max_heat_pct: 10 }, TODAY);
  assert.equal(r.capital_declared, false);
  assert.equal(r.book.limit, null);
  assert.equal(r.book.used_pct, null);
  assert.equal(r.book.within_limit, true);
  assert.equal(r.assets[0]!.notional_cap, null);
  assert.deepEqual(r.breaches, []);
});

test("a flat book reports zero rather than dividing by it", () => {
  const r = deriveHeatReport([], PARAMS, TODAY);
  assert.equal(r.book.heat, 0);
  assert.equal(r.book.used_pct, 0);
  assert.deepEqual(r.clusters, []);
  assert.deepEqual(r.breaches, []);
});
