import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../connect.ts";
import { migrate } from "../migrate.ts";
import { ensureSession } from "./session.ts";
import { addCluster } from "./cluster.ts";
import { recordMacro, getMacro, recordClusterRead, listClusterReads } from "./phase.ts";

const NOW = "2026-07-31T12:00:00Z";
const DATE = "2026-07-31";

function fresh() {
  const db = openDb(":memory:");
  migrate(db);
  ensureSession(db, DATE, NOW);
  return db;
}

const macro = {
  state: "RISK_ON",
  summary: "breadth improving",
  metrics: { score: 1.5, confidence: 0.5, vix: 14.2, dxy: 99.1 },
  results: { tilt: 0.375, risk_budget: 0.59 },
};

type Metrics = Record<string, number | string>;

test("recordMacro stores the read, its metrics, and its results", () => {
  const db = fresh();
  recordMacro(db, DATE, macro, NOW);
  const got = getMacro(db, DATE);
  assert.equal(got.read!.state, "RISK_ON");
  assert.deepEqual(got.metrics, { score: 1.5, confidence: 0.5, vix: 14.2, dxy: 99.1 });
  assert.deepEqual(got.results, { tilt: 0.375, risk_budget: 0.59 });
  db.close();
});

test("re-recording a macro replaces the previous slice entirely", () => {
  const db = fresh();
  recordMacro(db, DATE, macro, NOW);
  recordMacro(db, DATE, { ...macro, metrics: { score: -1, vix: 30 }, results: { tilt: -1 } }, NOW);
  const got = getMacro(db, DATE);
  assert.deepEqual(got.metrics, { score: -1, vix: 30 }, "stale metrics must not survive");
  assert.deepEqual(got.results, { tilt: -1 }, "stale results must not survive either");
  db.close();
});

test("recordClusterRead is keyed per cluster and overwrites on re-run", () => {
  const db = fresh();
  const c = addCluster(db, "majors", "Majors", null, NOW);
  recordClusterRead(db, DATE, c.id,
    { metrics: { bias: 1.0, judgement: "constructive" }, results: { tilt: 1.0, aligned: 1 } }, NOW);
  recordClusterRead(db, DATE, c.id,
    { metrics: { bias: -1.0, judgement: "rolling over" }, results: { tilt: -1.0, aligned: 0 } }, NOW);
  const reads = listClusterReads(db, DATE) as
    { cluster_key: string; metrics: Metrics; results: Metrics }[];
  assert.equal(reads.length, 1);
  assert.deepEqual(
    reads[0]!.metrics, { bias: -1.0, judgement: "rolling over" },
    "text and numeric metrics both round-trip, and stale ones do not survive",
  );
  assert.deepEqual(reads[0]!.results, { tilt: -1.0, aligned: 0 });
  assert.equal(reads[0]!.cluster_key, "majors");
  db.close();
});

test("metrics and results cascade away with the read they belong to", () => {
  const db = fresh();
  const c = addCluster(db, "majors", "Majors", null, NOW);
  recordMacro(db, DATE, macro, NOW);
  recordClusterRead(db, DATE, c.id,
    { metrics: { bias: 1, judgement: "constructive" }, results: { tilt: 1, aligned: 1 } }, NOW);
  db.prepare("DELETE FROM session WHERE session_date = ?").run(DATE);
  for (const t of [
    "macro_read_metric", "macro_read_result", "cluster_read_metric", "cluster_read_result",
  ]) {
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    assert.equal(n, 0, `${t} should cascade`);
  }
  db.close();
});
