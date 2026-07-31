import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../connect.ts";
import { migrate } from "../migrate.ts";
import { ensureSession } from "./session.ts";
import { addCluster } from "./cluster.ts";
import { recordRegime, getRegime, recordClusterRead, listClusterReads } from "./phase.ts";

const NOW = "2026-07-31T12:00:00Z";
const DATE = "2026-07-31";

function fresh() {
  const db = openDb(":memory:");
  migrate(db);
  ensureSession(db, DATE, NOW);
  return db;
}

const regime = {
  state: "RISK_ON", score: 1.5, confidence: 0.5,
  summary: "breadth improving", metrics: { vix: 14.2, dxy: 99.1 },
};

test("recordRegime stores the read and its metrics", () => {
  const db = fresh();
  recordRegime(db, DATE, regime, NOW);
  const got = getRegime(db, DATE) as { read: { score: number }; metrics: Record<string, number> };
  assert.equal(got.read.score, 1.5);
  assert.deepEqual(got.metrics, { vix: 14.2, dxy: 99.1 });
  db.close();
});

test("re-recording a regime replaces the previous slice entirely", () => {
  const db = fresh();
  recordRegime(db, DATE, regime, NOW);
  recordRegime(db, DATE, { ...regime, score: -1, metrics: { vix: 30 } }, NOW);
  const got = getRegime(db, DATE) as { read: { score: number }; metrics: Record<string, number> };
  assert.equal(got.read.score, -1);
  assert.deepEqual(got.metrics, { vix: 30 }, "stale metrics must not survive");
  db.close();
});

test("the database rejects an out-of-range confidence", () => {
  const db = fresh();
  assert.throws(() => recordRegime(db, DATE, { ...regime, confidence: -0.5 }, NOW), /CHECK/i);
  db.close();
});

test("recordClusterRead is keyed per cluster and overwrites on re-run", () => {
  const db = fresh();
  const c = addCluster(db, "majors", "Majors", null, NOW);
  recordClusterRead(db, DATE, c.id, 1.0, "constructive", NOW);
  recordClusterRead(db, DATE, c.id, -1.0, "rolling over", NOW);
  const reads = listClusterReads(db, DATE) as { bias: number; cluster_key: string }[];
  assert.equal(reads.length, 1);
  assert.equal(reads[0]!.bias, -1.0);
  assert.equal(reads[0]!.cluster_key, "majors");
  db.close();
});
