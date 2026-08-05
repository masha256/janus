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

/** Runs the CLI and returns raw streams; help and --human are not JSON. */
async function janusRaw(
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string; body?: any }> {
  const env = { ...process.env, JANUS_DB: DB, JANUS_LIGHTER_URL: baseUrl };
  const parse = (out: string): any => {
    try {
      return JSON.parse(out);
    } catch {
      return undefined;
    }
  };
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { env });
    return { code: 0, stdout, stderr, body: parse(stdout) };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    const stdout = err.stdout ?? "";
    return { code: err.code ?? 1, stdout, stderr: err.stderr ?? "", body: parse(stdout) };
  }
}

/** Runs the CLI and returns the parsed envelope plus the exit code. */
async function janus(...args: string[]): Promise<{ code: number; body: any }> {
  const { code, stdout } = await janusRaw(...args);
  return { code, body: JSON.parse(stdout || "{}") };
}


test("every command emits a parseable envelope", async () => {
  const { code, body } = await janus("init");
  assert.equal(code, 0);
  assert.equal(body.ok, true);
  assert.equal(typeof body.data.schema_version, "number");
});

test("--help prints usage as plain text and exits 0", async () => {
  const { code, body, stdout } = await janusRaw("--help");
  assert.equal(code, 0);
  assert.equal(body, undefined, "help is text, not an envelope");
  assert.match(stdout, /Usage: janus/);
  for (const noun of ["macro", "cluster", "coverage", "screen", "score", "trade"]) {
    assert.match(stdout, new RegExp(`\\n  ${noun}`), `${noun} is listed`);
  }
});

test("every noun and verb carries its own help", async () => {
  const noun = await janusRaw("macro", "--help");
  assert.equal(noun.code, 0);
  assert.match(noun.stdout, /record/);
  assert.match(noun.stdout, /reads/);

  const verb = await janusRaw("macro", "record", "--help");
  assert.equal(verb.code, 0);
  for (const flag of ["--summary", "--metric", "--date", "--force", "--human"]) {
    assert.match(verb.stdout, new RegExp(flag.replace("-", "\\-")), `${flag} is documented`);
  }
});

test("an unknown command fails with VALIDATION and exit 1", async () => {
  const { code, body } = await janus("nonsense");
  assert.equal(code, 1);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "VALIDATION");
});

test("an asset whose cached listing age is too short cannot be added", async () => {
  await janus("market", "sync");
  // Gate is driven from the cached market row alone — no candles fetch. The
  // fixture symbols are all real listing dates that age with wall-clock time,
  // so asserting a specific one *fails* is brittle. Assert the mechanism
  // instead: the failure names listing age/bars, and param override opens it.
  // DIA is fixture-dated 2026-03-03 — in the future relative to real run time,
  // so its cached age is ≤ 0 and it is the one symbol that fails on any date.
  const res = await janus("asset", "add", "DIA", "--class", "etf");
  assert.equal(res.code, 1);
  assert.equal(res.body.error.code, "INSUFFICIENT_HISTORY");
  assert.match(res.body.error.message, /listed/);
  assert.match(res.body.error.message, /bars/);

  // The gate is param-driven: dropping min_history_bars lets the young market in.
  await janus("param", "set", "min_history_bars", "0");
  const dia = await janus("asset", "add", "DIA", "--class", "etf");
  assert.equal(dia.body.ok, true, JSON.stringify(dia.body));
  const cleanup = await janus("asset", "rm", "DIA");
  assert.equal(cleanup.body.ok, true, JSON.stringify(cleanup.body));
});

test("the full daily pipeline runs end to end", async () => {
  const synced = await janus("market", "sync");
  assert.equal(synced.body.ok, true, JSON.stringify(synced.body));
  assert.equal(synced.body.data.synced, 3, "orderBooks fixture lists 3 markets");

  await janus("cluster", "add", "majors", "--name", "Majors");
  // XPL (2025-08-26) is the only fixture symbol old enough that min_history_bars
  // opens on its real cached listing age for the foreseeable future.
  const added = await janus("asset", "add", "XPL", "--class", "crypto", "--cluster", "majors");
  assert.equal(added.body.ok, true, JSON.stringify(added.body));

  // Scoring before screening must be refused.
  const queued = await janus("score", "queue");
  assert.equal(queued.body.ok, true, "queue is a read and is always allowed");
  assert.equal(queued.body.data.count, 0);

  // Screening depends on both the reads and coverage, none of which have run.
  const outOfOrder = await janus(
    "screen", "record", "XPL", "--metric", "score=1", "--metric", "confidence=1",
  );
  assert.equal(outOfOrder.code, 1);
  assert.equal(outOfOrder.body.error.code, "PHASE_ORDER");
  assert.match(outOfOrder.body.error.message, /macro/);

  // Coverage, though, depends on nothing: it runs before any read exists and
  // stamps its own phase. The pipeline below then re-runs it in place.
  const early = await janus("coverage", "run");
  assert.equal(early.body.ok, true, JSON.stringify(early.body));
  assert.equal(early.body.data.phase_complete, true);

  const macro = await janus(
    "macro", "record", "--metric", "regime=0.5",
    "--summary", "breadth improving", "--metric", "vix=14.2",
  );
  assert.equal(macro.body.ok, true, JSON.stringify(macro.body));
  // A cluster already exists (majors), so cluster_read is NOT auto-stamped here.
  assert.deepEqual(macro.body.data.stamped, ["macro"]);
  // regime is the only required macro metric, alongside whatever --metric supplied.
  assert.deepEqual(macro.body.data.metrics, { regime: 0.5, vix: 14.2 });
  // No derived results are produced by the macro read yet.
  assert.deepEqual(macro.body.data.results, {});

  const clusterRead = await janus(
    "cluster", "record", "majors", "--metric", "breadth=0.7", "--metric", "regime=0.5",
  );
  assert.equal(clusterRead.body.ok, true, JSON.stringify(clusterRead.body));

  const reads = await janus("cluster", "reads");
  assert.deepEqual(
    reads.body.data.reads[0].metrics,
    { breadth: 0.7, regime: 0.5 },
  );
  // The cluster read records no derived results; regime_smile is computed at screen time.
  assert.deepEqual(
    reads.body.data.reads[0].results,
    {},
  );

  const coverage = await janus("coverage", "run");
  assert.equal(coverage.body.ok, true, JSON.stringify(coverage.body));
  assert.equal(coverage.body.data.covered, 1);
  assert.equal(coverage.body.data.phase_complete, true);

  const screen = await janus(
    "screen", "record", "XPL", "--metric", "score=8", "--metric", "confidence=0.9", "--metric", "rvol=2.1",
  );
  assert.equal(screen.body.ok, true, JSON.stringify(screen.body));
  assert.equal(screen.body.data.flagged, true);

  const screens = await janus("screen", "list");
  assert.deepEqual(
    screens.body.data.screens[0].metrics,
    { confidence: 0.9, rvol: 2.1, score: 8 },
    "what was observed",
  );
  assert.deepEqual(
    screens.body.data.screens[0].results,
    { screen_score: 7.2, threshold: 4, regime: 0.5, beta_factor: 1, regime_smile: 0.3 },
    "the derived screen_score, threshold, regime, beta_factor, and regime_smile in force",
  );

  const queue = await janus("score", "queue");
  assert.equal(queue.body.data.count, 1);
  assert.equal(queue.body.data.queue[0].queue_reason, "flagged");

  const scored = await janus(
    "score", "record", "XPL",
    "--factor", "catalyst=2", "--factor", "trend=2",
    "--factor", "secular=-2", "--factor", "crowding=50",
    "--factor", "divergence=0", "--factor", "confidence=1",
  );
  assert.equal(scored.body.ok, true, JSON.stringify(scored.body));
  assert.equal(scored.body.data.directive, "STAND_ASIDE", "no trend gate data from fixtures, so no initiate");
  assert.equal(scored.body.data.position, "flat");
  assert.equal(scored.body.data.plan?.trend_gate, "fail");
  // The factors exactly as the agent gave them…
  assert.deepEqual(scored.body.data.metrics, {
    catalyst: 2, trend: 2, secular: -2, crowding: 50, divergence: 0, confidence: 1,
  });
  // …and everything the formula concluded, including the session's own
  // screen-stored regime_smile. Regime 0.5 is in the core, so cluster
  // regime_smile is +0.3 and the bullish score aligns with it.
  const results = scored.body.data.results as Record<string, unknown>;
  const volatile = new Set(["sentiment", "agreement", "weighted_sum"]);
  assert.deepEqual(
    Object.fromEntries(Object.keys(results).filter((k) => !volatile.has(k)).map((k) => [k, results[k]])),
    {
      w_catalyst: 0.25, w_sentiment: 0.25, w_trend: 0.3, w_regime: 0.15, w_secular: 0.05,
      fear_premium: 1.25,
      divergence_boost: 0.5,
      sentiment_summary: "40-65 - calm middle (+0.4 x sign(Trend))",
      regime: 0.5,
      regime_smile: 0.3,
      confidence: 1,
      total_abs_weight: 1,
    },
  );
  assert.ok(typeof results["sentiment"] === "number" && Math.abs(results["sentiment"] as number - 0.5) < 1e-9);
  assert.ok(typeof results["agreement"] === "number" && results["agreement"] as number > 0 && results["agreement"] as number <= 1);

  // direction and conviction are columns, so a score list can sort and filter on
  // them without touching the result table.
  const scores = await janus("score", "list");
  assert.ok(scores.body.data.scores[0].direction > 0);
  assert.ok(scores.body.data.scores[0].conviction >= 1 && scores.body.data.scores[0].conviction <= 10);

  const status = await janus("session", "status");
  assert.equal(status.body.data.next_phase, null, "every phase should be complete");

  // The same session, rendered for a human: text, no envelope, still exit 0.
  const text = await janusRaw("score", "list", "--human");
  assert.equal(text.code, 0);
  assert.equal(text.body, undefined, "--human output is not JSON");
  assert.match(text.stdout, /session_date: /);
  assert.match(text.stdout, /symbol\s+class/, "the scores render as a table");
  assert.match(text.stdout, /XPL/);
});

test("a human-mode failure goes to stderr, not stdout, and still exits 1", async () => {
  const { code, stdout, stderr } = await janusRaw("score", "record", "NOSUCH", "--factor", "a=1", "--human");
  assert.equal(code, 1);
  assert.equal(stdout, "", "nothing on stdout to mistake for a result");
  assert.match(stderr, /^janus: .*\(NOT_FOUND|PHASE_ORDER\)$/m);
});

test("scoring against a nonexistent session is refused", async () => {
  const res = await janus("score", "record", "XPL", "--factor", "catalyst=1", "--date", "1999-01-01");
  assert.equal(res.code, 1);
  assert.equal(res.body.error.code, "SESSION_MISSING");
});

test("scoring a screened-but-unflagged asset is refused with NOT_FLAGGED", async () => {
  // A real current session already exists from the pipeline test above, with
  // XPL on the roster and covered. Screen it below the flag threshold so it is
  // genuinely "screened but unflagged", then scoring must refuse NOT_FLAGGED.
  const screen = await janus(
    "screen", "record", "XPL", "--metric", "score=1", "--metric", "confidence=0.5",
  );
  assert.equal(screen.body.ok, true, JSON.stringify(screen.body));
  assert.equal(screen.body.data.flagged, false);

  const res = await janus("score", "record", "XPL", "--factor", "catalyst=1", "--factor", "crowding=50");
  assert.equal(res.code, 1, JSON.stringify(res.body));
  // If the session rolled to a new NY date, the phase-order guard fires first.
  assert.ok(res.body.error.code === "NOT_FLAGGED" || res.body.error.code === "PHASE_ORDER", JSON.stringify(res.body));
});

test("an open position reaches the next scoring run", async () => {
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
  assert.equal(conflict.code, 1);
  assert.equal(conflict.body.error.code, "POSITION_CONFLICT");

  // Re-scoring now sees an open position: it is snapshotted onto the row and
  // handed to deriveScore, which will act on it once the ladder is written.
  const rescored = await janus(
    "score", "record", "XPL", "--force",
    "--factor", "catalyst=2", "--factor", "trend=2",
    "--factor", "secular=2", "--factor", "crowding=50",
    "--factor", "divergence=0",
  );
  assert.equal(rescored.body.ok, true, JSON.stringify(rescored.body));
  assert.equal(rescored.body.data.position, "long:1");
  assert.equal(rescored.body.data.directive, "HOLD", "thesis intact on an open long with aligned score");
  assert.equal(rescored.body.data.plan?.directive, "HOLD");

  const addedUnit = await janus("trade", "add-unit", id, "--price", "110", "--stop", "100", "--risk", "100", "--notional", "1100");
  assert.equal(addedUnit.body.data.summary.open_units, 2);
  assert.equal(addedUnit.body.data.summary.total_notional, 2100);

  const exited = await janus("trade", "exit", id, "--price", "130");
  assert.equal(exited.body.data.trade_status, "closed");
  assert.equal(exited.body.data.summary.open_units, 0);
  assert.ok(exited.body.data.summary.r_multiple > 0);
});


