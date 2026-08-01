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

test("recordScreen stores what was observed, what was concluded, and the flag", () => {
  const db = fresh();
  const id = requireAssetBySymbol(db, "BTC").id;
  recordScreen(db, DATE, id, { flagged: true, rationale: "breakout", metrics: { score: 5, confidence: 0.5 }, results: { screen_score: 2.5, threshold: 1.0 } }, NOW);
  const rows = listScreen(db, DATE, {}) as
    { symbol: string; flagged: number; metrics: Record<string, number>;
      results: Record<string, number> }[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.symbol, "BTC");
  assert.equal(rows[0]!.flagged, 1);
  assert.deepEqual(rows[0]!.metrics, { score: 5, confidence: 0.5 });
  assert.deepEqual(rows[0]!.results, { screen_score: 2.5, threshold: 1.0 });
  db.close();
});

test("re-recording a screen overwrites it", () => {
  const db = fresh();
  const id = requireAssetBySymbol(db, "BTC").id;
  recordScreen(db, DATE, id, { flagged: true, rationale: null, metrics: { score: 5, confidence: 0.5 }, results: { screen_score: 2.5, threshold: 1.0 } }, NOW);
  recordScreen(db, DATE, id, { flagged: false, rationale: null, metrics: { score: 1, confidence: 0.5 }, results: { screen_score: 0.5, threshold: 1.0 } }, NOW);
  const rows = listScreen(db, DATE, {}) as { metrics: Record<string, number>; flagged: number }[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.metrics["score"], 1);
  assert.equal(rows[0]!.flagged, 0);
  db.close();
});

test("listScreen can return only the flagged rows", () => {
  const db = fresh();
  recordScreen(db, DATE, requireAssetBySymbol(db, "BTC").id,
    { flagged: true, rationale: null, metrics: { score: 5, confidence: 0.5 }, results: { screen_score: 2.5, threshold: 1 } }, NOW);
  recordScreen(db, DATE, requireAssetBySymbol(db, "ETH").id,
    { flagged: false, rationale: null, metrics: { score: 1, confidence: 0.5 }, results: { screen_score: 0.5, threshold: 1 } }, NOW);
  assert.equal(countScreened(db, DATE), 2);
  const flagged = listScreen(db, DATE, { flaggedOnly: true }) as { symbol: string }[];
  assert.deepEqual(flagged.map((r) => r.symbol), ["BTC"]);
  db.close();
});
