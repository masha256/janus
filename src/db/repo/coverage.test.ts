import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../connect.ts";
import { migrate } from "../migrate.ts";
import { ensureSession } from "./session.ts";
import { upsertMarkets } from "./market.ts";
import { addAsset, requireAssetBySymbol } from "./asset.ts";
import { upsertCoverage, listCoverage, latestCoverage } from "./coverage.ts";
import type { CoverageValues } from "../../domain/coverage.ts";

const NOW = "2026-07-31T12:00:00Z";
const DATE = "2026-07-31";

const values = (close: number): CoverageValues => ({
  open: close, high: close, low: close, close, volume: 1,
  mark_price: close, index_price: close, open_interest: 1, daily_change_pct: 0,
  sma20: null, sma50: null, sma200: null, ema12: null, ema26: null, atr14: null,
  px_vs_sma20: null, px_vs_sma50: null, px_vs_sma200: null,
  cross_50_200: null, cross_50_200_age: null, cross_px_50: null, cross_px_50_age: null,
  funding_rate: null, funding_ref: null,
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

test("latestCoverage bounded by a date never returns a later row", () => {
  const db = fresh();
  const btc = requireAssetBySymbol(db, "BTC").id;
  for (const [date, close] of [["2026-07-29", 100], ["2026-07-30", 200], ["2026-07-31", 300]] as const) {
    ensureSession(db, date, NOW);
    upsertCoverage(db, date, [{ asset_id: btc, values: values(close) }]);
  }

  // Unbounded: the newest row, whatever its date.
  assert.equal(latestCoverage(db, btc)!.session_date, "2026-07-31");

  // Bounded: the row for that day when one exists...
  assert.equal(latestCoverage(db, btc, "2026-07-30")!.values.close, 200);
  // ...and the most recent earlier row when it does not. Never a later one —
  // that would mark a past date with data that did not exist yet.
  assert.equal(latestCoverage(db, btc, "2026-07-30")!.session_date, "2026-07-30");
  ensureSession(db, "2026-08-01", NOW);
  assert.equal(latestCoverage(db, btc, "2026-08-01")!.session_date, "2026-07-31");

  // Bounded before any coverage exists: nothing, rather than the newest row.
  assert.equal(latestCoverage(db, btc, "2026-07-28"), null);
  db.close();
});
