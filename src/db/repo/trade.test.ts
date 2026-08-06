import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../connect.ts";
import { migrate } from "../migrate.ts";
import { upsertMarkets } from "./market.ts";
import { addAsset, requireAssetBySymbol } from "./asset.ts";
import { openTrade, addUnit, setStop, exitUnits, getTrade, listTrades, partialExitUnit } from "./trade.ts";
import { positionOf } from "./score.ts";

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

// Carry-forward from Task 16: exitUnits closes the trade in the same
// transaction as closing the last unit, so the {side, units: 0} window
// positionOf guards against should never persist. Confirm it reports flat.
test("positionOf reports flat once a trade's units are all exited", () => {
  const db = fresh();
  const asset_id = requireAssetBySymbol(db, "BTC").id;
  const id = openTrade(db, { ...input, asset_id }, NOW);
  assert.deepEqual(positionOf(db, asset_id), { side: "long", units: 1 });
  exitUnits(db, id, 130, DATE);
  assert.deepEqual(positionOf(db, asset_id), { side: null, units: 0 });
  db.close();
});

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
