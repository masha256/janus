import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db/connect.js";
import { migrate } from "../db/migrate.js";
import { ensureSession, stampPhase } from "../db/repo/session.js";
import { upsertMarkets } from "../db/repo/market.js";
import { addAsset, requireAssetBySymbol } from "../db/repo/asset.js";
import { recordScreen } from "../db/repo/screen.js";
import { DEFAULT_PARAMS } from "../domain/params.js";
import { todayNY } from "../domain/session.js";
import { handle } from "./param.js";
import { handle as score } from "./score.js";
const NOW = "2026-07-31T12:00:00Z";
// score.ts's resolveSession resolves an omitted --date via todayNY() against
// the real clock, so fixtures must be seeded under that same date or a day
// rollover leaves assertPhaseOrder looking at an unstamped session.
const DATE = todayNY();
function freshDbFile() {
    const dir = mkdtempSync(join(tmpdir(), "janus-param-test-"));
    const file = join(dir, "janus.db");
    const db = openDb(file);
    migrate(db);
    ensureSession(db, DATE, NOW);
    for (const p of ["macro", "cluster", "coverage", "screen"])
        stampPhase(db, DATE, p, NOW);
    upsertMarkets(db, [
        { symbol: "BTC", market_id: 1, market_type: "perp", status: "active", price_decimals: 1, size_decimals: 5, listed_at: "2025-01-01" },
    ], NOW);
    // Deliberately unclustered: this is the asset that was stuck on DEFAULT_PARAMS
    // forever while global_param was unwritable.
    const asset = addAsset(db, "BTC", "crypto", null, null, NOW);
    recordScreen(db, DATE, asset.id, { flagged: true, rationale: null, metrics: { score: 1.5, confidence: 0 }, results: { threshold: 1 } }, NOW);
    db.close();
    return file;
}
async function withHarness(run) {
    const file = freshDbFile();
    process.env["JANUS_DB"] = file;
    try {
        await run();
    }
    finally {
        delete process.env["JANUS_DB"];
        rmSync(file, { force: true });
    }
}
test("param list shows defaults until a global param overrides one", async () => {
    await withHarness(async () => {
        const before = (await handle("list", []));
        assert.deepEqual(before.global, {}, "a fresh database has no global overrides");
        assert.deepEqual(before.resolved, DEFAULT_PARAMS);
        await handle("set", ["screen_flag_threshold", "1.8"]);
        const after = (await handle("list", []));
        assert.deepEqual(after.global, { screen_flag_threshold: 1.8 });
        assert.equal(after.resolved["screen_flag_threshold"], 1.8, "the global rung wins over the default");
        assert.equal(after.resolved["conv_initiate"], DEFAULT_PARAMS["conv_initiate"], "untouched keys keep their default");
    });
});
test("param set rejects a non-numeric value", async () => {
    await withHarness(async () => {
        // A NaN weight would slip past deriveScore's `w !== 0` filter and poison
        // d and conv with NaN, so this guard is load-bearing, not cosmetic.
        await assert.rejects(() => handle("set", ["w_catalyst", "NaN"]), (e) => e.code === "VALIDATION" && /must be a number/.test(e.message));
        await assert.rejects(() => handle("set", ["w_catalyst", "abc"]), (e) => e.code === "VALIDATION");
        const after = (await handle("list", []));
        assert.deepEqual(after.global, {}, "a rejected value must not reach the database");
    });
});
// Commander reads a leading `-` as an option, so `param set` and
// `cluster set-param` turn positional passthrough on. Without it the whole
// negative half of every weight is unreachable.
test("param set accepts a negative weight passed positionally", async () => {
    await withHarness(async () => {
        await handle("set", ["w_crowding", "-2"]);
        const after = (await handle("list", []));
        assert.equal(after.global["w_crowding"], -2);
    });
});
test("a global param reaches the scoring decision for an unclustered asset", async () => {
    await withHarness(async () => {
        // d is a weight-normalised mean, so the override has to change the *shape*
        // of the weighting to move it: trend contributes 0, so raising its weight
        // dilutes catalyst. Defaults: (1*2 + 1*0)/2 = 1.
        const args = ["BTC", "--factor", "catalyst=2", "--factor", "trend=0"];
        const before = (await score("record", args));
        assert.equal(before.results["w_trend"], 1.0, "default w_trend");
        assert.equal(before.strength, 1.0);
        await handle("set", ["w_trend", "3"]);
        // (1*2 + 3*0)/4 = 0.5
        const after = (await score("record", args));
        assert.equal(after.results["w_trend"], 3, "the global rung now feeds deriveScore");
        assert.equal(after.strength, 0.5, "an unclustered asset is no longer stuck on DEFAULT_PARAMS");
    });
});
test("param with no verb names the verbs instead of quoting undefined", async () => {
    await withHarness(async () => {
        await assert.rejects(() => handle(undefined, []), (e) => e.code === "VALIDATION" && e.message === "param requires a verb; try: set, list");
    });
});
