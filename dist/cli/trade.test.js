import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db/connect.js";
import { migrate } from "../db/migrate.js";
import { upsertMarkets } from "../db/repo/market.js";
import { addAsset, requireAssetBySymbol } from "../db/repo/asset.js";
import { upsertCoverage } from "../db/repo/coverage.js";
import { ensureSession } from "../db/repo/session.js";
import { handle } from "./trade.js";
const NOW = "2026-07-31T12:00:00Z";
const DATE = "2026-07-31";
function freshDbFile() {
    const dir = mkdtempSync(join(tmpdir(), "janus-trade-test-"));
    const file = join(dir, "janus.db");
    const db = openDb(file);
    migrate(db);
    upsertMarkets(db, [
        { symbol: "BTC", market_id: 1, market_type: "perp", status: "active", price_decimals: 1, size_decimals: 5, listed_at: "2025-01-01" },
    ], NOW);
    addAsset(db, "BTC", "crypto", null, null, NOW);
    db.close();
    return file;
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
function withDb(file, run) {
    const db = openDb(file);
    try {
        run(db);
    }
    finally {
        db.close();
    }
}
const OPEN_ARGS = ["BTC", "--direction", "long", "--price", "100", "--stop", "90", "--risk", "100", "--notional", "1000", "--date", DATE];
test("--price 0 is rejected with VALIDATION", async () => {
    await withHarness(async () => {
        await assert.rejects(() => handle("open", ["BTC", "--direction", "long", "--price", "0", "--stop", "90", "--risk", "100", "--notional", "1000"]), (e) => e.code === "VALIDATION");
    });
});
test("--stop 0 on open is rejected with VALIDATION", async () => {
    await withHarness(async () => {
        await assert.rejects(() => handle("open", ["BTC", "--direction", "long", "--price", "100", "--stop", "0", "--risk", "100", "--notional", "1000"]), (e) => e.code === "VALIDATION");
    });
});
test("--notional 0 on open is rejected with VALIDATION", async () => {
    await withHarness(async () => {
        await assert.rejects(() => handle("open", ["BTC", "--direction", "long", "--price", "100", "--stop", "90", "--risk", "100", "--notional", "0"]), (e) => e.code === "VALIDATION");
    });
});
test("--risk 0 on open is accepted (free carry)", async () => {
    await withHarness(async () => {
        const opened = (await handle("open", ["BTC", "--direction", "long", "--price", "100", "--stop", "90", "--risk", "0", "--notional", "1000"]));
        assert.equal(opened.trade.initial_risk, 0);
    });
});
test("--price 0 on add-unit is rejected with VALIDATION", async () => {
    await withHarness(async (file) => {
        const opened = (await handle("open", OPEN_ARGS));
        const id = String(opened.trade.id);
        await assert.rejects(() => handle("add-unit", [id, "--price", "0", "--stop", "100", "--risk", "100", "--notional", "1100"]), (e) => e.code === "VALIDATION");
    });
});
test("--stop 0 on set-stop is rejected with VALIDATION", async () => {
    await withHarness(async (file) => {
        const opened = (await handle("open", OPEN_ARGS));
        const id = String(opened.trade.id);
        await assert.rejects(() => handle("set-stop", [id, "--stop", "0"]), (e) => e.code === "VALIDATION");
    });
});
test("--price 0 on exit is rejected with VALIDATION", async () => {
    await withHarness(async (file) => {
        const opened = (await handle("open", OPEN_ARGS));
        const id = String(opened.trade.id);
        await assert.rejects(() => handle("exit", [id, "--price", "0", "--date", DATE]), (e) => e.code === "VALIDATION");
    });
});
test("a second open on the same asset fails with POSITION_CONFLICT", async () => {
    await withHarness(async () => {
        await handle("open", OPEN_ARGS);
        await assert.rejects(() => handle("open", OPEN_ARGS), (e) => e.code === "POSITION_CONFLICT");
    });
});
test("a full exit closes the trade and frees the asset for a new open", async () => {
    await withHarness(async (file) => {
        const opened = (await handle("open", OPEN_ARGS));
        const id = String(opened.trade.id);
        const exited = (await handle("exit", [id, "--price", "130", "--date", DATE]));
        assert.equal(exited.closed, 1);
        assert.equal(exited.trade_status, "closed");
        assert.equal(exited.trade.status, "closed");
        const reopened = (await handle("open", OPEN_ARGS));
        assert.ok(reopened.trade.id > opened.trade.id);
    });
});
test("--unit scopes set-stop to a single unit", async () => {
    await withHarness(async (file) => {
        const opened = (await handle("open", OPEN_ARGS));
        const id = String(opened.trade.id);
        await handle("add-unit", [id, "--price", "110", "--stop", "100", "--risk", "100", "--notional", "1100", "--date", DATE]);
        const moved = (await handle("set-stop", [id, "--stop", "108", "--unit", "2"]));
        assert.equal(moved.units_moved, 1);
        assert.deepEqual(moved.units.map((u) => u.stop), [90, 108]);
    });
});
test("--unit scopes exit to a single unit, leaving the trade open", async () => {
    await withHarness(async (file) => {
        const opened = (await handle("open", OPEN_ARGS));
        const id = String(opened.trade.id);
        await handle("add-unit", [id, "--price", "110", "--stop", "100", "--risk", "100", "--notional", "1100", "--date", DATE]);
        const exited = (await handle("exit", [id, "--price", "130", "--date", DATE, "--unit", "1"]));
        assert.equal(exited.closed, 1);
        assert.equal(exited.trade_status, "open");
        assert.equal(exited.summary.open_units, 1);
    });
});
test("--direction sideways is rejected with VALIDATION", async () => {
    await withHarness(async () => {
        await assert.rejects(() => handle("open", ["BTC", "--direction", "sideways", "--price", "100", "--stop", "90", "--risk", "100", "--notional", "1000"]), (e) => e.code === "VALIDATION" && /direction/.test(e.message));
    });
});
test("omitting --direction is rejected rather than silently recording a long", async () => {
    await withHarness(async () => {
        await assert.rejects(() => handle("open", ["BTC", "--price", "100", "--stop", "90", "--risk", "100", "--notional", "1000"]), (e) => e.code === "VALIDATION" && /direction/.test(e.message));
    });
});
test("--direction short records a short", async () => {
    await withHarness(async () => {
        const opened = (await handle("open", ["BTC", "--direction", "short", "--price", "100", "--stop", "110", "--risk", "100", "--notional", "1000"]));
        assert.equal(opened.trade.direction, "short");
    });
});
test("trade list --asset rejects an unknown symbol instead of returning empty", async () => {
    await withHarness(async (file) => {
        await handle("open", OPEN_ARGS);
        await assert.rejects(() => handle("list", ["--asset", "NOSUCH"]), (e) => e.code === "VALIDATION" && /NOSUCH/.test(e.message));
    });
});
test("trade list --asset uppercases the symbol", async () => {
    await withHarness(async (file) => {
        await handle("open", OPEN_ARGS);
        const result = (await handle("list", ["--asset", "btc"]));
        assert.equal(result.count, 1);
    });
});
test("trade show warns when no coverage exists", async () => {
    await withHarness(async () => {
        const opened = (await handle("open", OPEN_ARGS));
        const id = String(opened.trade.id);
        const shown = (await handle("show", [id]));
        assert.deepEqual(shown.warnings, ["no coverage data found for this asset; run coverage first"]);
        assert.equal(shown.coverage, null);
    });
});
test("trade show enriches open units with mark-price progress", async () => {
    await withHarness(async (file) => {
        const opened = (await handle("open", OPEN_ARGS));
        const id = String(opened.trade.id);
        withDb(file, (db) => {
            const assetId = requireAssetBySymbol(db, "BTC").id;
            ensureSession(db, DATE, NOW);
            upsertCoverage(db, DATE, [{
                    asset_id: assetId,
                    values: {
                        open: 0, high: 0, low: 0, close: 130, volume: 0,
                        mark_price: 130, index_price: 130, open_interest: 0, daily_change_pct: 0,
                        sma20: 120, sma50: 115, sma200: 110, ema12: 125, ema26: 122, atr14: 5,
                        px_vs_sma20: 8, px_vs_sma50: 13, px_vs_sma200: 18,
                        cross_50_200: "golden", cross_50_200_age: 10, cross_px_50: "above", cross_px_50_age: 10,
                        bars_available: 250, fetched_at: "2026-07-31T12:00:00Z",
                    },
                }]);
        });
        const shown = (await handle("show", [id, "--date", DATE]));
        assert.equal(shown.coverage.mark_price, 130);
        assert.equal(shown.units[0].mark_price, 130);
        assert.equal(shown.units[0].unrealized_pnl, 300); // size 10 x (130 - 100)
        assert.equal(shown.units[0].unrealized_r, 3); // 300 / 100 initial_risk
        assert.equal(shown.units[0].distance_to_stop, 40); // (130 - 90) for long
        assert.equal(shown.progress.unrealized_pnl, 300);
        assert.equal(shown.progress.unrealized_r, 3);
        assert.equal(shown.warnings, undefined);
    });
});
test("trade show warns when coverage is older than today", async () => {
    await withHarness(async (file) => {
        const opened = (await handle("open", OPEN_ARGS));
        const id = String(opened.trade.id);
        withDb(file, (db) => {
            const assetId = requireAssetBySymbol(db, "BTC").id;
            ensureSession(db, "2026-07-30", NOW);
            upsertCoverage(db, "2026-07-30", [{
                    asset_id: assetId,
                    values: {
                        open: 0, high: 0, low: 0, close: 130, volume: 0,
                        mark_price: 130, index_price: 130, open_interest: 0, daily_change_pct: 0,
                        sma20: 120, sma50: 115, sma200: 110, ema12: 125, ema26: 122, atr14: 5,
                        px_vs_sma20: 8, px_vs_sma50: 13, px_vs_sma200: 18,
                        cross_50_200: "golden", cross_50_200_age: 10, cross_px_50: "above", cross_px_50_age: 10,
                        bars_available: 250, fetched_at: "2026-07-30T12:00:00Z",
                    },
                }]);
        });
        const shown = (await handle("show", [id]));
        assert.ok(shown.warnings !== undefined && shown.warnings[0].startsWith("coverage is stale"));
    });
});
test("trade with no verb names the verbs instead of quoting undefined", async () => {
    await withHarness(async () => {
        await assert.rejects(() => handle(undefined, []), (e) => e.code === "VALIDATION" && e.message === "trade requires a verb; try: open, add-unit, set-stop, exit, list, show");
    });
});
