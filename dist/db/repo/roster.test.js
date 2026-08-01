import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../connect.js";
import { migrate } from "../migrate.js";
import { upsertMarkets, listMarkets } from "./market.js";
import { addCluster, setClusterParam, getClusterParams, getGlobalParams, removeCluster } from "./cluster.js";
import { addAsset, listAssets, updateAsset, setAssetActive, eligibleAssets, requireAssetBySymbol, removeAsset, requireSymbols } from "./asset.js";
const NOW = "2026-07-31T12:00:00Z";
const market = (symbol, id, status = "active") => ({
    symbol, market_id: id, market_type: "perp", status,
    price_decimals: 2, size_decimals: 4, listed_at: "2025-01-01",
});
function fresh() {
    const db = openDb(":memory:");
    migrate(db);
    upsertMarkets(db, [market("BTC", 1), market("ETH", 2), market("OLDCOIN", 3, "inactive")], NOW);
    return db;
}
test("upsertMarkets inserts then updates without duplicating", () => {
    const db = fresh();
    assert.equal(listMarkets(db, {}).length, 3);
    upsertMarkets(db, [market("BTC", 1, "inactive")], NOW);
    assert.equal(listMarkets(db, {}).length, 3, "same market_id must not duplicate");
    assert.equal(listMarkets(db, { search: "BTC" })[0].status, "inactive", "status must update");
    db.close();
});
test("listMarkets filters by search and status", () => {
    const db = fresh();
    assert.equal(listMarkets(db, { status: "active" }).length, 2);
    assert.equal(listMarkets(db, { search: "eth" }).length, 1, "search is case-insensitive");
    db.close();
});
test("addAsset requires a known market", () => {
    const db = fresh();
    assert.throws(() => addAsset(db, "NOPE", "crypto", null, null, NOW), (e) => e.code === "NOT_FOUND");
    db.close();
});
test("addAsset rejects a duplicate symbol", () => {
    const db = fresh();
    addAsset(db, "BTC", "crypto", null, null, NOW);
    assert.throws(() => addAsset(db, "BTC", "crypto", null, null, NOW), (e) => e.code === "ALREADY_EXISTS");
    db.close();
});
test("an asset joins at most one cluster and reports its key", () => {
    const db = fresh();
    addCluster(db, "majors", "Majors", null, NOW);
    const a = addAsset(db, "BTC", "crypto", "majors", null, NOW);
    assert.equal(a.cluster_key, "majors");
    addCluster(db, "alts", "Alts", null, NOW);
    assert.equal(updateAsset(db, "BTC", { clusterKey: "alts" }).cluster_key, "alts");
    db.close();
});
test("removing a cluster detaches its assets rather than deleting them", () => {
    const db = fresh();
    addCluster(db, "majors", "Majors", null, NOW);
    addAsset(db, "BTC", "crypto", "majors", null, NOW);
    removeCluster(db, "majors");
    assert.equal(requireAssetBySymbol(db, "BTC").cluster_id, null);
    db.close();
});
test("cluster params fall back to global", () => {
    const db = fresh();
    const c = addCluster(db, "majors", "Majors", null, NOW);
    setClusterParam(db, c.id, "conv_add", 9);
    setClusterParam(db, null, "conv_hold", 5);
    assert.deepEqual(getClusterParams(db, c.id), { conv_add: 9 });
    assert.deepEqual(getGlobalParams(db), { conv_hold: 5 });
    assert.deepEqual(getClusterParams(db, null), {}, "no cluster means no cluster params");
    db.close();
});
test("setClusterParam overwrites an existing value", () => {
    const db = fresh();
    const c = addCluster(db, "majors", "Majors", null, NOW);
    setClusterParam(db, c.id, "conv_add", 9);
    setClusterParam(db, c.id, "conv_add", 8);
    assert.deepEqual(getClusterParams(db, c.id), { conv_add: 8 });
    db.close();
});
test("eligibleAssets excludes inactive roster entries and delisted markets", () => {
    const db = fresh();
    addAsset(db, "BTC", "crypto", null, null, NOW);
    addAsset(db, "ETH", "crypto", null, null, NOW);
    addAsset(db, "OLDCOIN", "crypto", null, null, NOW);
    assert.deepEqual(eligibleAssets(db).map((a) => a.symbol).sort(), ["BTC", "ETH"]);
    setAssetActive(db, "ETH", false);
    assert.deepEqual(eligibleAssets(db).map((a) => a.symbol), ["BTC"]);
    db.close();
});
test("eligibleAssets still includes an ineligible asset that holds an open trade", () => {
    const db = fresh();
    addAsset(db, "OLDCOIN", "crypto", null, null, NOW);
    const a = requireAssetBySymbol(db, "OLDCOIN");
    db.prepare(`INSERT INTO trade (asset_id,direction,status,opened_on,initial_price,initial_stop,initial_risk,created_at)
     VALUES (?,'long','open','2026-07-31',100,90,10,?)`).run(a.id, NOW);
    assert.deepEqual(eligibleAssets(db).map((s) => s.symbol), ["OLDCOIN"]);
    db.close();
});
test("listAssets filters by active, class, and cluster", () => {
    const db = fresh();
    addCluster(db, "majors", "Majors", null, NOW);
    addAsset(db, "BTC", "crypto", "majors", null, NOW);
    addAsset(db, "ETH", "crypto", null, null, NOW);
    setAssetActive(db, "ETH", false);
    assert.equal(listAssets(db, { active: true }).length, 1);
    assert.equal(listAssets(db, { active: false }).length, 1);
    assert.equal(listAssets(db, { clusterKey: "majors" }).length, 1);
    assert.equal(listAssets(db, { cls: "crypto" }).length, 2);
    db.close();
});
test("removeAsset on an asset with trades fails with VALIDATION, not a raw FK error", () => {
    const db = fresh();
    addAsset(db, "BTC", "crypto", null, null, NOW);
    const a = requireAssetBySymbol(db, "BTC");
    const insert = db.prepare(`INSERT INTO trade (asset_id,direction,status,opened_on,initial_price,initial_stop,initial_risk,created_at)
     VALUES (?,'long','closed','2026-07-31',100,90,10,?)`);
    insert.run(a.id, NOW);
    insert.run(a.id, NOW);
    assert.throws(() => removeAsset(db, "BTC"), (e) => e.code === "VALIDATION" && e.message === "BTC has 2 trades; deactivate it instead of removing it");
    assert.equal(listAssets(db, {}).length, 1, "the asset must survive the refusal");
    db.close();
});
test("removeAsset still deletes an asset that never traded", () => {
    const db = fresh();
    addAsset(db, "BTC", "crypto", null, null, NOW);
    removeAsset(db, "BTC");
    assert.equal(listAssets(db, {}).length, 0);
    db.close();
});
test("requireSymbols uppercases and rejects unknown symbols naming them all", () => {
    const db = fresh();
    addAsset(db, "BTC", "crypto", null, null, NOW);
    assert.deepEqual(requireSymbols(db, ["btc", "BTC"]), ["BTC"], "uppercased and deduped");
    assert.equal(requireSymbols(db, undefined), undefined, "absent means all");
    assert.throws(() => requireSymbols(db, ["btc", "nosuch"]), (e) => e.code === "VALIDATION" && /NOSUCH/.test(e.message));
    db.close();
});
