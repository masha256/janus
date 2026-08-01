import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../db/connect.ts";
import { migrate } from "../db/migrate.ts";
import { ensureSession, getSession, stampPhase } from "../db/repo/session.ts";
import { upsertMarkets } from "../db/repo/market.ts";
import { addAsset, requireAssetBySymbol } from "../db/repo/asset.ts";
import { recordScreen } from "../db/repo/screen.ts";
import { nextPhase } from "../domain/session.ts";
import { resolveParams } from "../domain/params.ts";
import { deriveScore } from "../domain/score.ts";
import { deriveDirective } from "../domain/directive.ts";
import { handle } from "./score.ts";

const NOW = "2026-07-31T12:00:00Z";
const DATE = "2026-07-31";

// score record opens its own db via JANUS_DB, so a real temp file (not
// :memory:) is needed to observe what it wrote. Phase order requires regime,
// cluster_read, coverage, and screen to already be stamped before score can run.
function freshDbFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "janus-score-test-"));
  const file = join(dir, "janus.db");
  const db = openDb(file);
  migrate(db);
  ensureSession(db, DATE, NOW);
  stampPhase(db, DATE, "regime", NOW);
  stampPhase(db, DATE, "cluster_read", NOW);
  stampPhase(db, DATE, "coverage", NOW);
  stampPhase(db, DATE, "screen", NOW);
  upsertMarkets(db, [
    { symbol: "BTC", market_id: 1, market_type: "perp", status: "active", price_decimals: 1, size_decimals: 5, listed_at: "2025-01-01" },
    { symbol: "ETH", market_id: 2, market_type: "perp", status: "active", price_decimals: 2, size_decimals: 4, listed_at: "2025-01-01" },
    { symbol: "SOL", market_id: 3, market_type: "perp", status: "active", price_decimals: 3, size_decimals: 3, listed_at: "2025-01-01" },
  ], NOW);
  for (const s of ["BTC", "ETH", "SOL"]) addAsset(db, s, "crypto", null, null, NOW);
  db.close();
  return file;
}

/** Open, mutate/inspect, close — a short-lived side channel onto the same file `handle()` writes to. */
function withDb(file: string, run: (db: DatabaseSync) => void): void {
  const db = openDb(file);
  try {
    run(db);
  } finally {
    db.close();
  }
}

function openTrade(db: DatabaseSync, symbol: string, units: number): void {
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
}

async function withHarness(run: (file: string) => Promise<void>): Promise<void> {
  const file = freshDbFile();
  process.env["JANUS_DB"] = file;
  try {
    await run(file);
  } finally {
    delete process.env["JANUS_DB"];
    rmSync(file, { force: true });
  }
}

test("a flagged asset scores, and d/conv/directive match what deriveScore/deriveDirective produce", async () => {
  await withHarness(async (file) => {
    withDb(file, (db) => {
      recordScreen(db, DATE, requireAssetBySymbol(db, "BTC").id,
        { score: 1.5, confidence: 0, threshold: 1, flagged: true, rationale: null }, NOW);
    });

    const result = (await handle("record", ["BTC", "--factor", "catalyst=1.5", "--factor", "crowding=-0.5"])) as {
      d: number; conv: number; directive: string;
    };

    const params = resolveParams({}, {});
    const { d, conv } = deriveScore({ catalyst: 1.5, crowding: -0.5 }, params);
    const directive = deriveDirective(d, conv, { side: null, units: 0 }, params);

    assert.equal(result.d, d);
    assert.equal(result.conv, conv);
    assert.equal(result.directive, directive);
  });
});

test("an asset outside the queue fails with NOT_FLAGGED", async () => {
  await withHarness(async () => {
    await assert.rejects(
      () => handle("record", ["ETH", "--factor", "catalyst=1"]),
      (e: Error & { code?: string }) => e.code === "NOT_FLAGGED",
    );
  });
});

test("an asset with an open trade but no flag is in the queue as open_trade", async () => {
  await withHarness(async (file) => {
    withDb(file, (db) => openTrade(db, "SOL", 2));

    const queueResult = (await handle("queue", [])) as {
      queue: { symbol: string; queue_reason: string }[];
    };
    assert.deepEqual(
      queueResult.queue.map((q) => [q.symbol, q.queue_reason]),
      [["SOL", "open_trade"]],
    );

    const result = (await handle("record", ["SOL", "--factor", "catalyst=-1"])) as {
      queue_reason: string; position: string;
    };
    assert.equal(result.queue_reason, "open_trade");
    assert.equal(result.position, "long:2");
  });
});

test("re-scoring replaces the previous factor rows rather than merging them", async () => {
  await withHarness(async (file) => {
    withDb(file, (db) => {
      recordScreen(db, DATE, requireAssetBySymbol(db, "BTC").id,
        { score: 1.5, confidence: 0, threshold: 1, flagged: true, rationale: null }, NOW);
    });

    await handle("record", ["BTC", "--factor", "catalyst=2", "--factor", "vibes=1"]);
    await handle("record", ["BTC", "--factor", "catalyst=1"]);

    withDb(file, (db) => {
      const rows = db
        .prepare("SELECT key FROM score_factor WHERE session_date = ? AND asset_id = ?")
        .all(DATE, requireAssetBySymbol(db, "BTC").id) as { key: string }[];
      assert.deepEqual(rows.map((r) => r.key), ["catalyst"], "stale factors must not survive");
    });
  });
});

test("score_at stamps only once every queued asset has been scored", async () => {
  await withHarness(async (file) => {
    withDb(file, (db) => {
      recordScreen(db, DATE, requireAssetBySymbol(db, "BTC").id,
        { score: 1.5, confidence: 0, threshold: 1, flagged: true, rationale: null }, NOW);
      openTrade(db, "SOL", 1);
    });

    const first = (await handle("record", ["BTC", "--factor", "catalyst=1"])) as { phase_complete: boolean };
    assert.equal(first.phase_complete, false);
    withDb(file, (db) => {
      const session = getSession(db, DATE)!;
      assert.equal(session.score_at, null, "one of two scored must not stamp the phase");
      assert.equal(nextPhase(session), "score");
    });

    const second = (await handle("record", ["SOL", "--factor", "trend=1"])) as { phase_complete: boolean };
    assert.equal(second.phase_complete, true);
    withDb(file, (db) => {
      const session = getSession(db, DATE)!;
      assert.notEqual(session.score_at, null, "two of two scored must stamp the phase");
    });
  });
});
