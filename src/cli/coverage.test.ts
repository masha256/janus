import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { openDb } from "../db/connect.ts";
import { migrate } from "../db/migrate.ts";
import { ensureSession, getSession, stampPhase } from "../db/repo/session.ts";
import { upsertMarkets } from "../db/repo/market.ts";
import { addAsset } from "../db/repo/asset.ts";
import { listCoverage } from "../db/repo/coverage.ts";
import { nextPhase } from "../domain/session.ts";
import { handle } from "./coverage.ts";

const NOW = "2026-07-31T12:00:00Z";
const DATE = "2026-07-31";

const fixture = (name: string): Buffer =>
  readFileSync(new URL(`../../test/fixtures/${name}.json`, import.meta.url));

/**
 * A tiny stub of the two Lighter endpoints coverage run hits, serving the
 * recorded fixtures regardless of the requested market. Coverage run picks it
 * up via JANUS_LIGHTER_URL (see src/cli/coverage.ts) instead of the real API —
 * no fetch mocking library, no network. Task 18 will want the same shape of
 * stub for its own live-data replay, so this is written to be easy to lift out.
 */
function startFakeLighter(): { url: string; close: () => Promise<void> } {
  const server = http.createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const body =
      path === "/api/v1/candles" ? fixture("candles")
      : path === "/api/v1/orderBookDetails" ? fixture("orderBookDetails")
      : null;
    if (body === null) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(body);
  });
  server.listen(0);
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// regime/coverage record open their own db via JANUS_DB, so a real temp file
// (not :memory:) is needed to observe what they wrote.
function freshDbFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "janus-coverage-test-"));
  const file = join(dir, "janus.db");
  const db = openDb(file);
  migrate(db);
  ensureSession(db, DATE, NOW);
  // Skip past regime/cluster_read so assertPhaseOrder lets coverage run.
  stampPhase(db, DATE, "regime", NOW);
  stampPhase(db, DATE, "cluster_read", NOW);
  upsertMarkets(db, [
    { symbol: "XPL", market_id: 71, market_type: "perp", status: "active", price_decimals: 5, size_decimals: 1, listed_at: "2025-01-01" },
    { symbol: "CC", market_id: 101, market_type: "perp", status: "active", price_decimals: 2, size_decimals: 1, listed_at: "2025-01-01" },
  ], NOW);
  addAsset(db, "XPL", "crypto", null, null, NOW);
  addAsset(db, "CC", "crypto", null, null, NOW);
  db.close();
  return file;
}

async function withHarness(
  run: (file: string) => Promise<void>,
): Promise<void> {
  const fake = startFakeLighter();
  const file = freshDbFile();
  process.env["JANUS_DB"] = file;
  process.env["JANUS_LIGHTER_URL"] = fake.url;
  try {
    await run(file);
  } finally {
    delete process.env["JANUS_DB"];
    delete process.env["JANUS_LIGHTER_URL"];
    rmSync(file, { force: true });
    await fake.close();
  }
}

test("a full run on a 2-asset roster stamps coverage_at and completes the phase", async () => {
  await withHarness(async (file) => {
    const result = (await handle("run", [])) as { covered: number; phase_complete: boolean };
    assert.equal(result.covered, 2);
    assert.equal(result.phase_complete, true);

    const db = openDb(file);
    const session = getSession(db, DATE)!;
    db.close();
    assert.notEqual(session.coverage_at, null);
  });
});

test("a scoped run writes its row but leaves the phase incomplete", async () => {
  await withHarness(async (file) => {
    const result = (await handle("run", ["--asset", "XPL"])) as {
      covered: number;
      phase_complete: boolean;
    };
    assert.equal(result.covered, 1);
    assert.equal(result.phase_complete, false);

    const db = openDb(file);
    const session = getSession(db, DATE)!;
    const rows = listCoverage(db, DATE);
    db.close();
    assert.equal(session.coverage_at, null, "a one-asset retry must not stamp the phase");
    assert.equal(rows.length, 1, "the scoped asset's row is still written");

    // The real point of the guard: screening must still see coverage as unfinished.
    assert.equal(nextPhase(session), "coverage");
  });
});

test("an unknown symbol fails the whole call and writes nothing", async () => {
  await withHarness(async (file) => {
    await assert.rejects(
      () => handle("run", ["--asset", "NOSUCH,XPL"]),
      (e: Error & { code?: string }) => e.code === "VALIDATION" && /NOSUCH/.test(e.message),
    );
    const db = openDb(file);
    const rows = listCoverage(db, DATE);
    db.close();
    assert.equal(rows.length, 0, "a rejected call must not partially cover the list");
  });
});

test("--asset BTC,BTC-style duplicates are deduped to a single covered row", async () => {
  await withHarness(async () => {
    const result = (await handle("run", ["--asset", "XPL,XPL"])) as { covered: number };
    assert.equal(result.covered, 1);
  });
});
