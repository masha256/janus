import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db/connect.ts";
import { migrate } from "../db/migrate.ts";
import { upsertMarkets } from "../db/repo/market.ts";
import { addAsset } from "../db/repo/asset.ts";
import { handle } from "./trade.ts";

const NOW = "2026-07-31T12:00:00Z";
const DATE = "2026-07-31";

function freshDbFile(): string {
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

async function withHarness(run: () => Promise<void>): Promise<void> {
  const file = freshDbFile();
  process.env["JANUS_DB"] = file;
  try {
    await run();
  } finally {
    delete process.env["JANUS_DB"];
    rmSync(file, { force: true });
  }
}

const OPEN_ARGS = ["BTC", "--price", "100", "--stop", "90", "--risk", "100", "--notional", "1000", "--date", DATE];

test("--price 0 is rejected with VALIDATION", async () => {
  await withHarness(async () => {
    await assert.rejects(
      () => handle("open", ["BTC", "--price", "0", "--stop", "90", "--risk", "100", "--notional", "1000"]),
      (e: Error & { code?: string }) => e.code === "VALIDATION",
    );
  });
});

test("a second open on the same asset fails with POSITION_CONFLICT", async () => {
  await withHarness(async () => {
    await handle("open", OPEN_ARGS);
    await assert.rejects(
      () => handle("open", OPEN_ARGS),
      (e: Error & { code?: string }) => e.code === "POSITION_CONFLICT",
    );
  });
});

test("a full exit closes the trade and frees the asset for a new open", async () => {
  await withHarness(async () => {
    const opened = (await handle("open", OPEN_ARGS)) as { trade: { id: number } };
    const id = String(opened.trade.id);

    const exited = (await handle("exit", [id, "--price", "130", "--date", DATE])) as {
      closed: number; trade_status: string; trade: { status: string };
    };
    assert.equal(exited.closed, 1);
    assert.equal(exited.trade_status, "closed");
    assert.equal(exited.trade.status, "closed");

    const reopened = (await handle("open", OPEN_ARGS)) as { trade: { id: number } };
    assert.ok(reopened.trade.id > opened.trade.id);
  });
});

test("--unit scopes set-stop to a single unit", async () => {
  await withHarness(async () => {
    const opened = (await handle("open", OPEN_ARGS)) as { trade: { id: number } };
    const id = String(opened.trade.id);
    await handle("add-unit", [id, "--price", "110", "--stop", "100", "--risk", "100", "--notional", "1100", "--date", DATE]);

    const moved = (await handle("set-stop", [id, "--stop", "108", "--unit", "2"])) as {
      units_moved: number; units: { seq: number; stop: number }[];
    };
    assert.equal(moved.units_moved, 1);
    assert.deepEqual(moved.units.map((u) => u.stop), [90, 108]);
  });
});

test("--unit scopes exit to a single unit, leaving the trade open", async () => {
  await withHarness(async () => {
    const opened = (await handle("open", OPEN_ARGS)) as { trade: { id: number } };
    const id = String(opened.trade.id);
    await handle("add-unit", [id, "--price", "110", "--stop", "100", "--risk", "100", "--notional", "1100", "--date", DATE]);

    const exited = (await handle("exit", [id, "--price", "130", "--date", DATE, "--unit", "1"])) as {
      closed: number; trade_status: string; summary: { open_units: number };
    };
    assert.equal(exited.closed, 1);
    assert.equal(exited.trade_status, "open");
    assert.equal(exited.summary.open_units, 1);
  });
});
