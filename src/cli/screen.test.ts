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
import { addAsset } from "../db/repo/asset.ts";
import { addCluster, setClusterParam } from "../db/repo/cluster.ts";
import { upsertCoverage } from "../db/repo/coverage.ts";
import { listScreen } from "../db/repo/screen.ts";
import { nextPhase, todayNY } from "../domain/session.ts";
import type { CoverageValues } from "../domain/coverage.ts";
import { handle } from "./screen.ts";

const NOW = "2026-07-31T12:00:00Z";
// screen.ts's resolveSession resolves an omitted --date via todayNY() against
// the real clock, so fixtures must be seeded under that same date or a day
// rollover leaves assertPhaseOrder looking at an unstamped session.
const DATE = todayNY();

/** A minimal coverage row: only `close` matters to screening, everything else is filler. */
const stubCoverage = (close: number): CoverageValues => ({
  open: close, high: close, low: close, close, volume: 100,
  mark_price: null, index_price: null, open_interest: null, daily_change_pct: null,
  sma20: null, sma50: null, sma200: null, ema12: null, ema26: null, atr14: null,
  px_vs_sma20: null, px_vs_sma50: null, px_vs_sma200: null,
  cross_50_200: null, cross_50_200_age: null, cross_px_50: null, cross_px_50_age: null,
  bars_available: 60, fetched_at: NOW,
});

// screen record opens its own db via JANUS_DB, so a real temp file (not
// :memory:) is needed to observe what it wrote. Phase order requires macro,
// cluster_read, and coverage to already be stamped before screen can run.
function freshDbFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "janus-screen-test-"));
  const file = join(dir, "janus.db");
  const db = openDb(file);
  migrate(db);
  ensureSession(db, DATE, NOW);
  stampPhase(db, DATE, "macro", NOW);
  stampPhase(db, DATE, "cluster", NOW);
  stampPhase(db, DATE, "coverage", NOW);
  upsertMarkets(db, [
    { symbol: "BTC", market_id: 1, market_type: "perp", status: "active", price_decimals: 1, size_decimals: 5, listed_at: "2025-01-01" },
    { symbol: "ETH", market_id: 2, market_type: "perp", status: "active", price_decimals: 2, size_decimals: 4, listed_at: "2025-01-01" },
  ], NOW);
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

test("screening snapshots the threshold: a later retune does not rewrite history", async () => {
  await withHarness(async (file) => {
    withDb(file, (db) => {
      const asset = addAsset(db, "BTC", "crypto", null, null, NOW);
      upsertCoverage(db, DATE, [{ asset_id: asset.id, values: stubCoverage(100) }]);
    });

    const first = (await handle("record", ["BTC", "--metric", "score=5", "--metric", "confidence=0.5"])) as {
      results: Record<string, number>;
      flagged: boolean;
    };
    assert.equal(first.results["screen_score"], 2.5);
    assert.equal(first.results["threshold"], 1.0);
    assert.equal(first.flagged, true);

    // Retune the global default upward past the already-recorded screen_score.
    withDb(file, (db) => setClusterParam(db, null, "screen_threshold", 5));

    // The stored row must still carry the OLD threshold and OLD flag.
    withDb(file, (db) => {
      const rows = listScreen(db, DATE, {}) as
        { results: Record<string, number>; flagged: number }[];
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.results["threshold"], 1.0, "retuning must not rewrite the snapshotted threshold");
      assert.equal(rows[0]!.flagged, 1, "retuning must not rewrite the snapshotted flag");
    });

    // Re-screening the same asset picks up the new threshold.
    const second = (await handle("record", ["BTC", "--metric", "score=5", "--metric", "confidence=0.5"])) as {
      results: Record<string, number>;
      flagged: boolean;
    };
    assert.equal(second.results["threshold"], 5);
    assert.equal(second.flagged, false, "2.5 no longer clears the retuned 5.0 threshold");
  });
});

test("cluster override reaches the flag decision", async () => {
  await withHarness(async (file) => {
    withDb(file, (db) => {
      const cluster = addCluster(db, "majors", "Majors", null, NOW);
      setClusterParam(db, cluster.id, "screen_threshold", 5);
      const btc = addAsset(db, "BTC", "crypto", "majors", null, NOW);
      const eth = addAsset(db, "ETH", "crypto", null, null, NOW);
      upsertCoverage(db, DATE, [
        { asset_id: btc.id, values: stubCoverage(100) },
        { asset_id: eth.id, values: stubCoverage(200) },
      ]);
    });

    const btc = (await handle("record", ["BTC", "--metric", "score=5", "--metric", "confidence=0.5"])) as {
      results: Record<string, number>;
      flagged: boolean;
    };
    assert.equal(btc.results["threshold"], 5);
    assert.equal(btc.results["screen_score"], 2.5);
    assert.equal(btc.flagged, false, "2.5 is below the cluster's 5.0 threshold");

    const eth = (await handle("record", ["ETH", "--metric", "score=5", "--metric", "confidence=0.5"])) as {
      results: Record<string, number>;
      flagged: boolean;
    };
    assert.equal(eth.results["threshold"], 1.0);
    assert.equal(eth.results["screen_score"], 2.5);
    assert.equal(eth.flagged, true, "2.5 clears the default 1.0 threshold for an unclustered asset");
  });
});

test("screen_score equal to the threshold flags (inclusive boundary)", async () => {
  await withHarness(async (file) => {
    withDb(file, (db) => {
      const asset = addAsset(db, "BTC", "crypto", null, null, NOW);
      upsertCoverage(db, DATE, [{ asset_id: asset.id, values: stubCoverage(100) }]);
    });

    const result = (await handle("record", ["BTC", "--metric", "score=2", "--metric", "confidence=0.5"])) as {
      results: Record<string, number>;
      flagged: boolean;
    };
    assert.equal(result.results["screen_score"], 1.0);
    assert.equal(result.flagged, true, "screen_score === threshold must flag, not require strictly greater");
  });
});

test("screen_at stamps only once every covered asset has been screened", async () => {
  await withHarness(async (file) => {
    withDb(file, (db) => {
      const btc = addAsset(db, "BTC", "crypto", null, null, NOW);
      const eth = addAsset(db, "ETH", "crypto", null, null, NOW);
      upsertCoverage(db, DATE, [
        { asset_id: btc.id, values: stubCoverage(100) },
        { asset_id: eth.id, values: stubCoverage(200) },
      ]);
    });

    const first = (await handle("record", ["BTC", "--metric", "score=1", "--metric", "confidence=0.5"])) as {
      phase_complete: boolean;
    };
    assert.equal(first.phase_complete, false);
    withDb(file, (db) => {
      const session = getSession(db, DATE)!;
      assert.equal(session.screen_at, null, "one of two screened must not stamp the phase");
      assert.equal(nextPhase(session), "screen");
    });

    const second = (await handle("record", ["ETH", "--metric", "score=1", "--metric", "confidence=0.5"])) as {
      phase_complete: boolean;
    };
    assert.equal(second.phase_complete, true);
    withDb(file, (db) => {
      const session = getSession(db, DATE)!;
      assert.notEqual(session.screen_at, null, "two of two screened must stamp the phase");
    });
  });
});

test("NO_COVERAGE for a rostered asset with no coverage row this session", async () => {
  await withHarness(async (file) => {
    withDb(file, (db) => {
      addAsset(db, "BTC", "crypto", null, null, NOW);
      // deliberately no coverage row for BTC this session
    });
    await assert.rejects(
      () => handle("record", ["BTC", "--metric", "score=5", "--metric", "confidence=0.5"]),
      (e: Error & { code?: string }) => e.code === "NO_COVERAGE",
    );
  });
});

test("NOT_FOUND for a symbol not on the roster", async () => {
  await withHarness(async () => {
    await assert.rejects(
      () => handle("record", ["NOSUCH", "--metric", "score=5", "--metric", "confidence=0.5"]),
      (e: Error & { code?: string }) => e.code === "NOT_FOUND",
    );
  });
});

test("screen with no verb names the verbs instead of quoting undefined", async () => {
  await withHarness(async () => {
    await assert.rejects(
      () => handle(undefined, []),
      (e: Error & { code?: string }) =>
        e.code === "VALIDATION" && e.message === "screen requires a verb; try: record, list",
    );
  });
});
