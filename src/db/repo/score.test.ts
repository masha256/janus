import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../connect.ts";
import { migrate } from "../migrate.ts";
import { ensureSession } from "./session.ts";
import { upsertMarkets } from "./market.ts";
import { addAsset, requireAssetBySymbol } from "./asset.ts";
import { recordScreen } from "./screen.ts";
import { scoreQueue, positionOf, recordScore, listScores } from "./score.ts";

const NOW = "2026-07-31T12:00:00Z";
const DATE = "2026-07-31";

function fresh() {
  const db = openDb(":memory:");
  migrate(db);
  ensureSession(db, DATE, NOW);
  upsertMarkets(db, [
    { symbol: "BTC", market_id: 1, market_type: "perp", status: "active", price_decimals: 1, size_decimals: 5, listed_at: "2025-01-01" },
    { symbol: "ETH", market_id: 2, market_type: "perp", status: "active", price_decimals: 2, size_decimals: 4, listed_at: "2025-01-01" },
    { symbol: "SOL", market_id: 3, market_type: "perp", status: "active", price_decimals: 3, size_decimals: 3, listed_at: "2025-01-01" },
  ], NOW);
  for (const s of ["BTC", "ETH", "SOL"]) addAsset(db, s, "crypto", null, null, NOW);
  return db;
}

function openTrade(db: ReturnType<typeof fresh>, symbol: string, units: number) {
  const id = requireAssetBySymbol(db, symbol).id;
  db.prepare(
    `INSERT INTO trade (asset_id,direction,status,opened_on,initial_price,initial_stop,initial_risk,created_at)
     VALUES (?,'long','open',?,100,90,10,?)`,
  ).run(id, DATE, NOW);
  const tradeId = (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
  for (let i = 1; i <= units; i++) {
    db.prepare(
      `INSERT INTO trade_unit (trade_id,seq,entry_on,entry_price,notional,risk,stop,status)
       VALUES (?,?,?,100,1000,100,90,'open')`,
    ).run(tradeId, i, DATE);
  }
  return tradeId;
}

test("the queue is the union of flagged assets and open positions", () => {
  const db = fresh();
  recordScreen(db, DATE, requireAssetBySymbol(db, "BTC").id,
    { score: 1.5, confidence: 0, threshold: 1, flagged: true, rationale: null }, NOW);
  recordScreen(db, DATE, requireAssetBySymbol(db, "ETH").id,
    { score: 0.1, confidence: 0, threshold: 1, flagged: false, rationale: null }, NOW);
  openTrade(db, "SOL", 1);

  const queue = scoreQueue(db, DATE);
  assert.deepEqual(
    queue.map((q) => [q.symbol, q.queue_reason]).sort(),
    [["BTC", "flagged"], ["SOL", "open_trade"]],
  );
  db.close();
});

test("an asset both flagged and held reports reason both", () => {
  const db = fresh();
  recordScreen(db, DATE, requireAssetBySymbol(db, "BTC").id,
    { score: 1.5, confidence: 0, threshold: 1, flagged: true, rationale: null }, NOW);
  openTrade(db, "BTC", 2);
  assert.equal(scoreQueue(db, DATE)[0]!.queue_reason, "both");
  db.close();
});

test("positionOf reports side and open unit count", () => {
  const db = fresh();
  assert.deepEqual(positionOf(db, requireAssetBySymbol(db, "BTC").id), { side: null, units: 0 });
  openTrade(db, "BTC", 3);
  assert.deepEqual(positionOf(db, requireAssetBySymbol(db, "BTC").id), { side: "long", units: 3 });
  db.close();
});

test("positionOf never reports a side with zero open units", () => {
  // An open trade row whose every unit has already closed (status not yet
  // flipped to 'closed' at the trade level) must read as flat, not as a
  // phantom long/short position — deriveDirective treats any non-null side
  // as "in a position" and would wrongly unlock HOLD/TRIM/EXIT off of it.
  const db = fresh();
  const id = requireAssetBySymbol(db, "BTC").id;
  const tradeId = openTrade(db, "BTC", 1);
  db.prepare("UPDATE trade_unit SET status = 'closed' WHERE trade_id = ?").run(tradeId);
  assert.deepEqual(positionOf(db, id), { side: null, units: 0 });
  db.close();
});

test("recordScore writes the score and its factors together", () => {
  const db = fresh();
  const id = requireAssetBySymbol(db, "BTC").id;
  recordScore(db, DATE, id, {
    d: 1.5, conv: 8, directive: "INITIATE", queue_reason: "flagged",
    position_state: "flat", params_json: "{}", rationale: "breakout",
  }, { catalyst: 2, crowding: -1 }, { catalyst: 1, crowding: -1 }, NOW);

  const rows = listScores(db, DATE) as { symbol: string; directive: string; factors: Record<string, unknown> }[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.directive, "INITIATE");
  assert.deepEqual(rows[0]!.factors, { catalyst: { value: 2, weight: 1 }, crowding: { value: -1, weight: -1 } });
  db.close();
});

test("re-scoring replaces the previous factors rather than merging them", () => {
  const db = fresh();
  const id = requireAssetBySymbol(db, "BTC").id;
  const row = {
    d: 1.5, conv: 8, directive: "INITIATE", queue_reason: "flagged",
    position_state: "flat", params_json: "{}", rationale: null,
  };
  recordScore(db, DATE, id, row, { catalyst: 2, vibes: 1 }, { catalyst: 1, vibes: 0 }, NOW);
  recordScore(db, DATE, id, row, { catalyst: 1 }, { catalyst: 1 }, NOW);
  const rows = listScores(db, DATE) as { factors: Record<string, unknown> }[];
  assert.deepEqual(Object.keys(rows[0]!.factors), ["catalyst"], "stale factors must not survive");
  db.close();
});
