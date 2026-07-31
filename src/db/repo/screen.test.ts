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
