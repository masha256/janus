import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = promisify(execFile);
const dir = mkdtempSync(join(tmpdir(), "janus-e2e-"));
const DB = join(dir, "test.db");
const CLI = new URL("./cli.ts", import.meta.url).pathname;

let server: Server;
let baseUrl: string;

/**
 * Serves the recorded fixtures so nothing in the daily pipeline touches the
 * network. The fixtures only cover one asset's worth of data: `orderBooks`
 * (the market catalog `market sync` reads) lists XPL/CC/DIA, while
 * `orderBookDetails` and `candles` carry BTC's numbers. The stub — like the
 * one in cli/coverage.test.ts — matches on path only, so whichever symbol we
 * add to the roster (XPL, since that's what `market sync` will actually
 * find) gets served BTC's snapshot and candles regardless of market_id. That
 * asymmetry is in the fixtures as recorded; it doesn't matter here because
 * neither parseSnapshot nor parseBars checks the requested market_id.
 */
before(async () => {
  const fixture = (name: string): string =>
    readFileSync(new URL(`../test/fixtures/${name}.json`, import.meta.url), "utf8");

  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    res.setHeader("content-type", "application/json");
    if (path === "/api/v1/orderBooks") return void res.end(fixture("orderBooks"));
    if (path === "/api/v1/orderBookDetails") return void res.end(fixture("orderBookDetails"));
    if (path === "/api/v1/candles") return void res.end(fixture("candles"));
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr !== null ? addr.port : 0}`;
});

after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Runs the CLI and returns the parsed envelope plus the exit code. */
async function janus(...args: string[]): Promise<{ code: number; body: any }> {
  const env = { ...process.env, JANUS_DB: DB, JANUS_LIGHTER_URL: baseUrl };
  try {
    const { stdout } = await run(process.execPath, [CLI, ...args], { env });
    return { code: 0, body: JSON.parse(stdout) };
  } catch (e) {
    const err = e as { code?: number; stdout?: string };
    return { code: err.code ?? 1, body: JSON.parse(err.stdout ?? "{}") };
  }
}

test("every command emits a parseable envelope", async () => {
  const { code, body } = await janus("init");
  assert.equal(code, 0);
  assert.equal(body.ok, true);
  assert.equal(body.data.schema_version, 1);
});

test("an unknown command fails with VALIDATION and exit 1", async () => {
  const { code, body } = await janus("nonsense");
  assert.equal(code, 1);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "VALIDATION");
});

test("the full daily pipeline runs end to end", async () => {
  const synced = await janus("market", "sync");
  assert.equal(synced.body.ok, true, JSON.stringify(synced.body));
  assert.equal(synced.body.data.synced, 3, "orderBooks fixture lists 3 markets");

  await janus("cluster", "add", "majors", "--name", "Majors");
  // orderBooks only carries XPL/CC/DIA (no BTC), so the roster addition has
  // to target a symbol market sync actually populated.
  const added = await janus("asset", "add", "XPL", "--class", "crypto", "--cluster", "majors");
  assert.equal(added.body.ok, true, JSON.stringify(added.body));

  // Scoring before screening must be refused.
  const early = await janus("score", "queue");
  assert.equal(early.body.ok, true, "queue is a read and is always allowed");
  assert.equal(early.body.data.count, 0);

  const outOfOrder = await janus("coverage", "run");
  assert.equal(outOfOrder.code, 1);
  assert.equal(outOfOrder.body.error.code, "PHASE_ORDER");
  assert.match(outOfOrder.body.error.message, /regime/);

  const regime = await janus(
    "regime", "record", "--state", "RISK_ON", "--score", "1.5",
    "--confidence", "0.5", "--summary", "breadth improving", "--metric", "vix=14.2",
  );
  assert.equal(regime.body.ok, true, JSON.stringify(regime.body));
  // A cluster already exists (majors), so cluster_read is NOT auto-stamped here.
  assert.deepEqual(regime.body.data.stamped, ["regime"]);

  const clusterRead = await janus("cluster-read", "record", "majors", "--bias", "1.0", "--judgement", "intact");
  assert.equal(clusterRead.body.ok, true);

  const coverage = await janus("coverage", "run");
  assert.equal(coverage.body.ok, true, JSON.stringify(coverage.body));
  assert.equal(coverage.body.data.covered, 1);
  assert.equal(coverage.body.data.phase_complete, true);

  const screen = await janus("screen", "record", "XPL", "--score", "1.5", "--confidence", "0.5");
  assert.equal(screen.body.ok, true, JSON.stringify(screen.body));
  assert.equal(screen.body.data.flagged, true);

  const queue = await janus("score", "queue");
  assert.equal(queue.body.data.count, 1);
  assert.equal(queue.body.data.queue[0].queue_reason, "flagged");

  const scored = await janus(
    "score", "record", "XPL",
    "--factor", "catalyst=2", "--factor", "trend=2",
    "--factor", "secular=2", "--factor", "crowding=-2",
  );
  assert.equal(scored.body.ok, true, JSON.stringify(scored.body));
  assert.equal(scored.body.data.d, 2);
  assert.equal(scored.body.data.conv, 10);
  assert.equal(scored.body.data.directive, "INITIATE");
  assert.equal(scored.body.data.position, "flat");

  const status = await janus("session", "status");
  assert.equal(status.body.data.next_phase, null, "every phase should be complete");
});

test("scoring an asset outside the queue is refused", async () => {
  const res = await janus("score", "record", "XPL", "--factor", "catalyst=1", "--date", "1999-01-01");
  assert.equal(res.code, 1);
  assert.equal(res.body.error.code, "SESSION_MISSING");
});

test("a trade changes the directive on the next scoring run", async () => {
  const opened = await janus(
    "trade", "open", "XPL", "--direction", "long",
    "--price", "100", "--stop", "90", "--risk", "100", "--notional", "1000",
  );
  assert.equal(opened.body.ok, true, JSON.stringify(opened.body));
  const id = String(opened.body.data.trade.id);

  const conflict = await janus(
    "trade", "open", "XPL", "--direction", "long",
    "--price", "100", "--stop", "90", "--risk", "100", "--notional", "1000",
  );
  assert.equal(conflict.body.error.code, "POSITION_CONFLICT");

  // Re-scoring now sees an open position, so the directive is position-aware.
  const rescored = await janus(
    "score", "record", "XPL", "--force",
    "--factor", "catalyst=2", "--factor", "trend=2",
    "--factor", "secular=2", "--factor", "crowding=-2",
  );
  assert.equal(rescored.body.data.position, "long:1");
  assert.equal(rescored.body.data.directive, "ADD");

  const addedUnit = await janus("trade", "add-unit", id, "--price", "110", "--stop", "100", "--risk", "100", "--notional", "1100");
  assert.equal(addedUnit.body.data.summary.open_units, 2);
  assert.equal(addedUnit.body.data.summary.total_notional, 2100);

  const exited = await janus("trade", "exit", id, "--price", "130");
  assert.equal(exited.body.data.trade_status, "closed");
  assert.equal(exited.body.data.summary.open_units, 0);
  assert.ok(exited.body.data.summary.r_multiple > 0);
});
