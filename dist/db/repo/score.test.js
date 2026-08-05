import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../connect.js";
import { migrate } from "../migrate.js";
import { ensureSession } from "./session.js";
import { upsertMarkets } from "./market.js";
import { addAsset, requireAssetBySymbol } from "./asset.js";
import { recordScreen } from "./screen.js";
import { scoreQueue, positionOf, openPositions, recordScore, listScores } from "./score.js";
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
    for (const s of ["BTC", "ETH", "SOL"])
        addAsset(db, s, "crypto", null, null, NOW);
    return db;
}
function openTrade(db, symbol, units) {
    const id = requireAssetBySymbol(db, symbol).id;
    db.prepare(`INSERT INTO trade (asset_id,direction,status,opened_on,initial_price,initial_stop,initial_risk,created_at)
     VALUES (?,'long','open',?,100,90,10,?)`).run(id, DATE, NOW);
    const tradeId = db.prepare("SELECT last_insert_rowid() AS id").get().id;
    for (let i = 1; i <= units; i++) {
        db.prepare(`INSERT INTO trade_unit (trade_id,seq,entry_on,entry_price,notional,risk,stop,status)
       VALUES (?,?,?,100,1000,100,90,'open')`).run(tradeId, i, DATE);
    }
    return tradeId;
}
test("the queue is the union of flagged assets and open positions", () => {
    const db = fresh();
    recordScreen(db, DATE, requireAssetBySymbol(db, "BTC").id, { flagged: true, rationale: null, metrics: { score: 5, confidence: 0 }, results: { screen_score: 0, threshold: 4 } }, NOW);
    recordScreen(db, DATE, requireAssetBySymbol(db, "ETH").id, { flagged: false, rationale: null, metrics: { score: 1, confidence: 0 }, results: { screen_score: 0, threshold: 4 } }, NOW);
    openTrade(db, "SOL", 1);
    const queue = scoreQueue(db, DATE);
    assert.deepEqual(queue.map((q) => [q.symbol, q.queue_reason]).sort(), [["BTC", "flagged"], ["SOL", "open_trade"]]);
    db.close();
});
test("an asset both flagged and held reports reason both", () => {
    const db = fresh();
    recordScreen(db, DATE, requireAssetBySymbol(db, "BTC").id, { flagged: true, rationale: null, metrics: { score: 5, confidence: 0 }, results: { screen_score: 0, threshold: 4 } }, NOW);
    openTrade(db, "BTC", 2);
    assert.equal(scoreQueue(db, DATE)[0].queue_reason, "both");
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
test("openPositions reports the whole book, and nothing with zero open units", () => {
    const db = fresh();
    openTrade(db, "BTC", 2);
    const emptied = openTrade(db, "ETH", 1);
    db.prepare("UPDATE trade_unit SET status = 'closed' WHERE trade_id = ?").run(emptied);
    assert.deepEqual(openPositions(db).map((p) => ({ ...p })), [{ asset_id: requireAssetBySymbol(db, "BTC").id, symbol: "BTC", side: "long", units: 2 }], "a trade whose units have all closed is not a live position");
    db.close();
});
const scoreRow = {
    direction: 1.5, conviction: 8, directive: "INITIATE", queue_reason: "flagged",
    position_state: "flat", rationale: null,
};
test("recordScore writes the row and its metrics together", () => {
    const db = fresh();
    const id = requireAssetBySymbol(db, "BTC").id;
    recordScore(db, DATE, id, {
        ...scoreRow, rationale: "breakout",
        metrics: { catalyst: 2, sentiment: -1 },
        results: { w_catalyst: 1, w_sentiment: -1 },
    }, NOW);
    const rows = listScores(db, DATE);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].directive, "INITIATE");
    assert.equal(rows[0].direction, 1.5, "direction is a column, not a result");
    assert.equal(rows[0].conviction, 8);
    assert.deepEqual(rows[0].metrics, { catalyst: 2, sentiment: -1 }, "the factors as given");
    assert.deepEqual(rows[0].results, { w_catalyst: 1, w_sentiment: -1 }, "what was derived");
    db.close();
});
test("re-scoring replaces the previous metrics and results rather than merging them", () => {
    const db = fresh();
    const id = requireAssetBySymbol(db, "BTC").id;
    recordScore(db, DATE, id, {
        ...scoreRow,
        metrics: { catalyst: 2, vibes: 1 },
        results: { w_catalyst: 1, w_vibes: 0 },
    }, NOW);
    recordScore(db, DATE, id, {
        ...scoreRow, metrics: { catalyst: 1 }, results: { w_catalyst: 1 },
    }, NOW);
    const rows = listScores(db, DATE);
    assert.deepEqual(Object.keys(rows[0].metrics), ["catalyst"], "stale factors must not survive");
    assert.deepEqual(Object.keys(rows[0].results), ["w_catalyst"], "and neither must stale results");
    db.close();
});
test("listScores orders by |direction| descending", () => {
    const db = fresh();
    for (const [symbol, direction] of [["BTC", 0.5], ["ETH", -1.9], ["SOL", 1.2]]) {
        recordScore(db, DATE, requireAssetBySymbol(db, symbol).id, { ...scoreRow, direction, metrics: {}, results: {} }, NOW);
    }
    const rows = listScores(db, DATE);
    assert.deepEqual(rows.map((r) => r.symbol), ["ETH", "SOL", "BTC"]);
    db.close();
});
