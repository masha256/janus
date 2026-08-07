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
import { nextPhase, todayNY } from "../domain/session.ts";
import { handle } from "./coverage.ts";

const NOW = "2026-07-31T12:00:00Z";
// resolveSession (see coverage.ts's handle) resolves an omitted --date via
// todayNY() against the real clock, not this file's NOW. Fixtures must be
// seeded under the same date the handler will actually resolve, or a day
// rollover makes assertPhaseOrder see a brand-new, unstamped session.
const DATE = todayNY();

const fixture = (name: string): Buffer =>
  readFileSync(new URL(`../../test/fixtures/${name}.json`, import.meta.url));

/**
 * A tiny stub of the two Lighter endpoints coverage run hits, serving the
 * recorded fixtures regardless of the requested market. Coverage run picks it
 * up via JANUS_LIGHTER_URL (see src/cli/coverage.ts) instead of the real API —
 * no fetch mocking library, no network. Task 18 will want the same shape of
 * stub for its own live-data replay, so this is written to be easy to lift out.
 */
function startFakeLighter(noBarsFor: number[] = []): { url: string; close: () => Promise<void> } {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    // A market in noBarsFor answers candles with an empty series, which is how
    // a delisted or brand-new market behaves; computeCoverage then raises
    // INSUFFICIENT_HISTORY and coverage run puts it in `skipped`.
    const noBars = noBarsFor.includes(Number(url.searchParams.get("market_id")));
    const body =
      path === "/api/v1/candles"
        ? (noBars ? Buffer.from(JSON.stringify({ code: 200, r: "1d", c: [] })) : fixture("candles"))
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

// macro/coverage record open their own db via JANUS_DB, so a real temp file
// (not :memory:) is needed to observe what they wrote.
function freshDbFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "janus-coverage-test-"));
  const file = join(dir, "janus.db");
  const db = openDb(file);
  migrate(db);
  ensureSession(db, DATE, NOW);
  // Skip past macro/cluster_read so assertPhaseOrder lets coverage run.
  stampPhase(db, DATE, "macro", NOW);
  stampPhase(db, DATE, "cluster", NOW);
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
  noBarsFor: number[] = [],
): Promise<void> {
  const fake = startFakeLighter(noBarsFor);
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

// CC is market_id 101 in freshDbFile.
const CC_MARKET_ID = 101;

test("a zero-bar asset is skipped but no longer blocks the phase", async () => {
  await withHarness(async (file) => {
    const result = (await handle("run", [])) as {
      covered: number;
      skipped: { symbol: string }[];
      phase_complete: boolean;
    };
    assert.equal(result.covered, 1, "only XPL had bars");
    assert.deepEqual(result.skipped.map((s) => s.symbol), ["CC"], "the skip is reported to the agent");
    assert.equal(result.phase_complete, true);

    const db = openDb(file);
    const session = getSession(db, DATE)!;
    db.close();
    assert.notEqual(session.coverage_at, null, "one dead market must not deadlock coverage forever");
    // The real point: screening is reachable without --force.
    assert.equal(nextPhase(session), "screen");
  }, [CC_MARKET_ID]);
});

test("a scoped run still leaves the phase incomplete even with nothing skipped", async () => {
  await withHarness(async () => {
    const result = (await handle("run", ["--asset", "XPL"])) as { phase_complete: boolean };
    assert.equal(result.phase_complete, false);
  });
});

test("coverage list --asset uppercases the symbol", async () => {
  await withHarness(async () => {
    await handle("run", []);
    const result = (await handle("list", ["--asset", "xpl"])) as { count: number };
    assert.equal(result.count, 1, "a lowercase symbol must not read as no coverage");
  });
});

test("coverage list --asset rejects an unknown symbol", async () => {
  await withHarness(async () => {
    await handle("run", []);
    await assert.rejects(
      () => handle("list", ["--asset", "NOSUCH,XPL"]),
      (e: Error & { code?: string }) => e.code === "VALIDATION" && /NOSUCH/.test(e.message),
    );
  });
});

test("coverage with no verb names the verbs instead of quoting undefined", async () => {
  await withHarness(async () => {
    await assert.rejects(
      () => handle(undefined, []),
      (e: Error & { code?: string }) =>
        e.code === "VALIDATION" && e.message === "coverage requires a verb; try: run, set, list",
    );
  });
});
