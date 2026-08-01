import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db/connect.js";
import { migrate } from "../db/migrate.js";
import { upsertMarkets } from "../db/repo/market.js";
import { addAsset } from "../db/repo/asset.js";
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
        await run();
    }
    finally {
        delete process.env["JANUS_DB"];
        rmSync(file, { force: true });
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
    await withHarness(async () => {
        const opened = (await handle("open", OPEN_ARGS));
        const id = String(opened.trade.id);
        await assert.rejects(() => handle("add-unit", [id, "--price", "0", "--stop", "100", "--risk", "100", "--notional", "1100"]), (e) => e.code === "VALIDATION");
    });
});
test("--stop 0 on set-stop is rejected with VALIDATION", async () => {
    await withHarness(async () => {
        const opened = (await handle("open", OPEN_ARGS));
        const id = String(opened.trade.id);
        await assert.rejects(() => handle("set-stop", [id, "--stop", "0"]), (e) => e.code === "VALIDATION");
    });
});
test("--price 0 on exit is rejected with VALIDATION", async () => {
    await withHarness(async () => {
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
    await withHarness(async () => {
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
    await withHarness(async () => {
        const opened = (await handle("open", OPEN_ARGS));
        const id = String(opened.trade.id);
        await handle("add-unit", [id, "--price", "110", "--stop", "100", "--risk", "100", "--notional", "1100", "--date", DATE]);
        const moved = (await handle("set-stop", [id, "--stop", "108", "--unit", "2"]));
        assert.equal(moved.units_moved, 1);
        assert.deepEqual(moved.units.map((u) => u.stop), [90, 108]);
    });
});
test("--unit scopes exit to a single unit, leaving the trade open", async () => {
    await withHarness(async () => {
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
    await withHarness(async () => {
        await handle("open", OPEN_ARGS);
        await assert.rejects(() => handle("list", ["--asset", "NOSUCH"]), (e) => e.code === "VALIDATION" && /NOSUCH/.test(e.message));
    });
});
test("trade list --asset uppercases the symbol", async () => {
    await withHarness(async () => {
        await handle("open", OPEN_ARGS);
        const result = (await handle("list", ["--asset", "btc"]));
        assert.equal(result.count, 1);
    });
});
test("trade with no verb names the verbs instead of quoting undefined", async () => {
    await withHarness(async () => {
        await assert.rejects(() => handle(undefined, []), (e) => e.code === "VALIDATION" && e.message === "trade requires a verb; try: open, add-unit, set-stop, exit, list, show");
    });
});
