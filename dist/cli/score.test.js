import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db/connect.js";
import { migrate } from "../db/migrate.js";
import { ensureSession, getSession, stampPhase } from "../db/repo/session.js";
import { upsertMarkets } from "../db/repo/market.js";
import { addAsset, requireAssetBySymbol } from "../db/repo/asset.js";
import { recordScreen } from "../db/repo/screen.js";
import { recordMacro } from "../db/repo/phase.js";
import { nextPhase, todayNY } from "../domain/session.js";
import { resolveParams } from "../domain/params.js";
import { deriveScore } from "../domain/score.js";
import { handle } from "./score.js";
const NOW = "2026-07-31T12:00:00Z";
// score.ts's resolveSession resolves an omitted --date via todayNY() against
// the real clock, so fixtures must be seeded under that same date or a day
// rollover leaves assertPhaseOrder looking at an unstamped session.
const DATE = todayNY();
// score record opens its own db via JANUS_DB, so a real temp file (not
// :memory:) is needed to observe what it wrote. Phase order requires macro,
// cluster_read, coverage, and screen to already be stamped before score can run.
function freshDbFile() {
    const dir = mkdtempSync(join(tmpdir(), "janus-score-test-"));
    const file = join(dir, "janus.db");
    const db = openDb(file);
    migrate(db);
    ensureSession(db, DATE, NOW);
    stampPhase(db, DATE, "macro", NOW);
    stampPhase(db, DATE, "cluster", NOW);
    stampPhase(db, DATE, "coverage", NOW);
    stampPhase(db, DATE, "screen", NOW);
    upsertMarkets(db, [
        { symbol: "BTC", market_id: 1, market_type: "perp", status: "active", price_decimals: 1, size_decimals: 5, listed_at: "2025-01-01" },
        { symbol: "ETH", market_id: 2, market_type: "perp", status: "active", price_decimals: 2, size_decimals: 4, listed_at: "2025-01-01" },
        { symbol: "SOL", market_id: 3, market_type: "perp", status: "active", price_decimals: 3, size_decimals: 3, listed_at: "2025-01-01" },
    ], NOW);
    for (const s of ["BTC", "ETH", "SOL"])
        addAsset(db, s, "crypto", null, null, NOW);
    db.close();
    return file;
}
/** Open, mutate/inspect, close — a short-lived side channel onto the same file `handle()` writes to. */
function withDb(file, run) {
    const db = openDb(file);
    try {
        run(db);
    }
    finally {
        db.close();
    }
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
}
async function withHarness(run) {
    const file = freshDbFile();
    process.env["JANUS_DB"] = file;
    try {
        await run(file);
    }
    finally {
        delete process.env["JANUS_DB"];
        rmSync(file, { force: true });
    }
}
test("a flagged asset scores, and direction/conviction/directive match the domain formulas", async () => {
    await withHarness(async (file) => {
        withDb(file, (db) => {
            recordMacro(db, DATE, { metrics: { regime: 1.5 }, results: {}, summary: "bullish" }, NOW);
            recordScreen(db, DATE, requireAssetBySymbol(db, "BTC").id, { flagged: true, rationale: null, metrics: { score: 5, confidence: 1 }, results: { screen_score: 5, threshold: 4, regime: 1.5, regime_smile: 0.9 } }, NOW);
        });
        const result = (await handle("record", ["BTC", "--factor", "catalyst=2", "--factor", "trend=2", "--factor", "secular=2", "--factor", "crowding=50", "--factor", "divergence=0"]));
        assert.equal(result.directive, "STAND_ASIDE");
        assert.equal(typeof result.direction, "number");
        assert.equal(typeof result.conviction, "number");
        assert.equal(result.results["direction"], undefined);
        assert.equal(result.results["conviction"], undefined);
        const typed = result;
        assert.equal(typed.plan?.directive, "STAND_ASIDE");
        assert.equal(typed.plan?.trend_gate, "fail");
    });
});
test("an asset outside the queue fails with NOT_FLAGGED", async () => {
    await withHarness(async () => {
        await assert.rejects(() => handle("record", ["ETH", "--factor", "catalyst=1", "--factor", "crowding=50", "--factor", "trend=0", "--factor", "secular=0"]), (e) => e.code === "NOT_FLAGGED");
    });
});
test("an asset with an open trade but no flag is in the queue as open_trade", async () => {
    await withHarness(async (file) => {
        withDb(file, (db) => {
            recordMacro(db, DATE, { metrics: { regime: 1.5 }, results: {}, summary: "bullish" }, NOW);
            recordScreen(db, DATE, requireAssetBySymbol(db, "SOL").id, { flagged: false, rationale: null, metrics: { score: 5, confidence: 1 }, results: { screen_score: 5, threshold: 4, regime: 1.5, regime_smile: 0.9 } }, NOW);
            openTrade(db, "SOL", 2);
        });
        const queueResult = (await handle("queue", []));
        assert.deepEqual(queueResult.queue.map((q) => [q.symbol, q.queue_reason]), [["SOL", "open_trade"]]);
        const result = (await handle("record", ["SOL", "--factor", "catalyst=-1", "--factor", "crowding=50", "--factor", "trend=0", "--factor", "secular=0"]));
        assert.equal(result.queue_reason, "open_trade");
        assert.equal(result.position, "long:2");
    });
});
test("re-scoring replaces the previous metric rows rather than merging them", async () => {
    await withHarness(async (file) => {
        withDb(file, (db) => {
            recordMacro(db, DATE, { metrics: { regime: 1.5 }, results: {}, summary: "bullish" }, NOW);
            recordScreen(db, DATE, requireAssetBySymbol(db, "BTC").id, { flagged: true, rationale: null, metrics: { score: 5, confidence: 1 }, results: { screen_score: 5, threshold: 4, regime: 1.5, regime_smile: 0.9 } }, NOW);
        });
        await handle("record", ["BTC", "--factor", "catalyst=2", "--factor", "trend=0", "--factor", "secular=0", "--factor", "crowding=50", "--factor", "divergence=1"]);
        await handle("record", ["BTC", "--factor", "catalyst=1", "--factor", "trend=0", "--factor", "secular=0", "--factor", "crowding=50", "--factor", "divergence=0"]);
        withDb(file, (db) => {
            const id = requireAssetBySymbol(db, "BTC").id;
            const keys = (table) => db
                .prepare(`SELECT key FROM ${table} WHERE session_date = ? AND asset_id = ? ORDER BY key`)
                .all(DATE, id).map((r) => r.key);
            assert.deepEqual(keys("score_metric"), ["catalyst", "crowding", "divergence", "secular", "trend"], "stale factors must not survive");
            assert.deepEqual(keys("score_result"), [
                "agreement", "binary_gate", "confidence", "directive_reason", "divergence_boost", "fear_premium",
                "flipflop_gate", "heat_gate", "persistence_gate", "persistence_rule", "plan_directive", "regime",
                "regime_smile", "sentiment", "sentiment_summary", "signal_gate", "size_tier", "total_abs_weight",
                "trend_gate", "w_catalyst", "w_regime", "w_secular", "w_sentiment", "w_trend", "weighted_sum",
            ], "nor stale results");
        });
    });
});
test("score_at stamps only once every queued asset has been scored", async () => {
    await withHarness(async (file) => {
        withDb(file, (db) => {
            recordMacro(db, DATE, { metrics: { regime: 1.5 }, results: {}, summary: "bullish" }, NOW);
            recordScreen(db, DATE, requireAssetBySymbol(db, "BTC").id, { flagged: true, rationale: null, metrics: { score: 5, confidence: 1 }, results: { screen_score: 5, threshold: 4, regime: 1.5, regime_smile: 0.9 } }, NOW);
            recordScreen(db, DATE, requireAssetBySymbol(db, "SOL").id, { flagged: false, rationale: null, metrics: { score: 5, confidence: 1 }, results: { screen_score: 5, threshold: 4, regime: 1.5, regime_smile: 0.9 } }, NOW);
            openTrade(db, "SOL", 1);
        });
        const first = (await handle("record", ["BTC", "--factor", "catalyst=1", "--factor", "crowding=50", "--factor", "trend=0", "--factor", "secular=0"]));
        assert.equal(first.phase_complete, false);
        withDb(file, (db) => {
            const session = getSession(db, DATE);
            assert.equal(session.score_at, null, "one of two scored must not stamp the phase");
            assert.equal(nextPhase(session), "score");
        });
        const second = (await handle("record", ["SOL", "--factor", "trend=1", "--factor", "crowding=50", "--factor", "catalyst=0", "--factor", "secular=0"]));
        assert.equal(second.phase_complete, true);
        withDb(file, (db) => {
            const session = getSession(db, DATE);
            assert.notEqual(session.score_at, null, "two of two scored must stamp the phase");
        });
    });
});
test("score list on a fresh database reports empty without opening a session", async () => {
    await withHarness(async () => {
        const result = (await handle("list", []));
        assert.equal(result.count, 0);
        assert.deepEqual(result.scores, []);
    });
});
test("score show reprints a stored score without requiring factors", async () => {
    await withHarness(async (file) => {
        withDb(file, (db) => {
            recordMacro(db, DATE, { metrics: { regime: 1.5 }, results: {}, summary: "bullish" }, NOW);
            recordScreen(db, DATE, requireAssetBySymbol(db, "BTC").id, { flagged: true, rationale: null, metrics: { score: 5, confidence: 1 }, results: { screen_score: 5, threshold: 4, regime: 1.5, regime_smile: 0.9 } }, NOW);
        });
        const recorded = (await handle("record", ["BTC", "--factor", "catalyst=2", "--factor", "trend=0", "--factor", "secular=0", "--factor", "crowding=50", "--factor", "divergence=0"]));
        const shown = (await handle("show", ["BTC"]));
        assert.equal(shown.directive, recorded.directive);
        assert.equal(shown.plan?.directive, recorded.plan?.directive);
        assert.equal(typeof shown.metrics["catalyst"], "number");
    });
});
test("score show fails for an asset not in the queue", async () => {
    await withHarness(async () => {
        await assert.rejects(() => handle("show", ["ETH"]), (e) => e.code === "NOT_FLAGGED");
    });
});
test("score show fails if the asset was not scored today", async () => {
    await withHarness(async (file) => {
        withDb(file, (db) => {
            recordMacro(db, DATE, { metrics: { regime: 1.5 }, results: {}, summary: "bullish" }, NOW);
            recordScreen(db, DATE, requireAssetBySymbol(db, "BTC").id, { flagged: true, rationale: null, metrics: { score: 5, confidence: 1 }, results: { screen_score: 5, threshold: 4, regime: 1.5, regime_smile: 0.9 } }, NOW);
        });
        await assert.rejects(() => handle("show", ["BTC"]), (e) => e.code === "NOT_FOUND");
    });
});
test("score with no verb names the verbs instead of quoting undefined", async () => {
    await withHarness(async () => {
        await assert.rejects(() => handle(undefined, []), (e) => e.code === "VALIDATION" && e.message === "score requires a verb; try: queue, record, show, list");
    });
});
