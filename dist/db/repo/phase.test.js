import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../connect.js";
import { migrate } from "../migrate.js";
import { ensureSession } from "./session.js";
import { addCluster } from "./cluster.js";
import { recordMacro, getMacro, recordClusterRead, listClusterReads } from "./phase.js";
const NOW = "2026-07-31T12:00:00Z";
const DATE = "2026-07-31";
function fresh() {
    const db = openDb(":memory:");
    migrate(db);
    ensureSession(db, DATE, NOW);
    return db;
}
const macro = {
    summary: "breadth improving",
    metrics: { regime: 1.5, vix: 14.2, dxy: 99.1 },
    results: {},
};
test("recordMacro stores the read, its metrics, and its results", () => {
    const db = fresh();
    recordMacro(db, DATE, macro, NOW);
    const got = getMacro(db, DATE);
    assert.equal(got.read.state, "NEUTRAL");
    assert.deepEqual(got.metrics, { regime: 1.5, vix: 14.2, dxy: 99.1 });
    assert.deepEqual(got.results, {});
    db.close();
});
test("re-recording a macro replaces the previous slice entirely", () => {
    const db = fresh();
    recordMacro(db, DATE, macro, NOW);
    recordMacro(db, DATE, { ...macro, metrics: { regime: -1, vix: 30 }, results: {} }, NOW);
    const got = getMacro(db, DATE);
    assert.deepEqual(got.metrics, { regime: -1, vix: 30 }, "stale metrics must not survive");
    assert.deepEqual(got.results, {}, "stale results must not survive either");
    db.close();
});
test("recordClusterRead is keyed per cluster and overwrites on re-run", () => {
    const db = fresh();
    const c = addCluster(db, "majors", "Majors", null, NOW);
    recordClusterRead(db, DATE, c.id, { metrics: { breadth: 0.7 }, results: { regime_smile: 0.9 } }, NOW);
    recordClusterRead(db, DATE, c.id, { metrics: { breadth: 0.2 }, results: { regime_smile: -0.2 } }, NOW);
    const reads = listClusterReads(db, DATE);
    assert.equal(reads.length, 1);
    assert.deepEqual(reads[0].metrics, { breadth: 0.2 }, "numeric metrics round-trip, and stale ones do not survive");
    assert.deepEqual(reads[0].results, { regime_smile: -0.2 });
    assert.equal(reads[0].cluster_key, "majors");
    db.close();
});
test("metrics and results cascade away with the read they belong to", () => {
    const db = fresh();
    const c = addCluster(db, "majors", "Majors", null, NOW);
    recordMacro(db, DATE, macro, NOW);
    recordClusterRead(db, DATE, c.id, { metrics: { breadth: 0.7 }, results: { regime_smile: 0.9 } }, NOW);
    db.prepare("DELETE FROM session WHERE session_date = ?").run(DATE);
    for (const t of [
        "macro_read_metric", "macro_read_result", "cluster_read_metric", "cluster_read_result",
    ]) {
        const n = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
        assert.equal(n, 0, `${t} should cascade`);
    }
    db.close();
});
