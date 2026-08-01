import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db/connect.ts";
import { migrate } from "../db/migrate.ts";
import { ensureSession, getSession } from "../db/repo/session.ts";
import { addCluster } from "../db/repo/cluster.ts";
import { nextPhase } from "../domain/session.ts";
import { handle } from "./macro.ts";

const NOW = "2026-07-31T12:00:00Z";
const DATE = "2026-07-31";

// macro record opens its own db via JANUS_DB, so a real temp file (not
// :memory:) is needed to observe what it wrote.
function freshDbFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "janus-macro-test-"));
  const file = join(dir, "janus.db");
  const db = openDb(file);
  migrate(db);
  ensureSession(db, DATE, NOW);
  db.close();
  return file;
}

test("zero clusters: a macro record vacuously completes cluster_read too", async () => {
  const file = freshDbFile();
  process.env["JANUS_DB"] = file;
  try {
    await handle("record", [
      "--date", DATE, "--state", "RISK_ON", "--metric", "score=1.5",
      "--metric", "confidence=0.5", "--summary", "x",
    ]);
    const db = openDb(file);
    const session = getSession(db, DATE)!;
    db.close();
    assert.notEqual(session.cluster_read_at, null);
    assert.equal(nextPhase(session), "coverage");
  } finally {
    delete process.env["JANUS_DB"];
    rmSync(file, { force: true });
  }
});

test("with a cluster present, a macro record does NOT stamp cluster_read", async () => {
  const file = freshDbFile();
  const db0 = openDb(file);
  addCluster(db0, "majors", "Majors", null, NOW);
  db0.close();
  process.env["JANUS_DB"] = file;
  try {
    await handle("record", [
      "--date", DATE, "--state", "RISK_ON", "--metric", "score=1.5",
      "--metric", "confidence=0.5", "--summary", "x",
    ]);
    const db = openDb(file);
    const session = getSession(db, DATE)!;
    db.close();
    assert.equal(session.cluster_read_at, null, "vacuous stamp must not fire when there is real work to do");
    assert.equal(nextPhase(session), "cluster_read");
  } finally {
    delete process.env["JANUS_DB"];
    rmSync(file, { force: true });
  }
});

// parseArgs reads a bare leading `-` as the next option, which is why the old
// `--score -2` was rejected as ambiguous. `--metric score=-2` has no such
// problem: the value is one token that starts with `s`, so the whole bearish
// half of the scale is reachable in the plain space-separated form.
test("--metric score=-2 records a bearish macro", async () => {
  const file = freshDbFile();
  process.env["JANUS_DB"] = file;
  try {
    const result = (await handle("record", [
      "--date", DATE, "--state", "RISK_OFF", "--metric", "score=-2",
      "--metric", "confidence=0.5", "--summary", "risk off",
    ])) as { read: { state: string }; metrics: Record<string, number> };
    assert.equal(result.metrics["score"], -2);
    assert.equal(result.read.state, "RISK_OFF");
  } finally {
    delete process.env["JANUS_DB"];
    rmSync(file, { force: true });
  }
});

test("a missing or out-of-range required metric is a VALIDATION error", async () => {
  const file = freshDbFile();
  process.env["JANUS_DB"] = file;
  const args = (...metric: string[]): string[] => [
    "--date", DATE, "--state", "RISK_ON", "--summary", "x",
    ...metric.flatMap((m) => ["--metric", m]),
  ];
  try {
    for (const [why, metrics] of [
      ["no score at all", ["confidence=0.5"]],
      ["no confidence at all", ["score=1"]],
      ["score out of range", ["score=3", "confidence=0.5"]],
      ["confidence out of range", ["score=1", "confidence=-1"]],
      ["score is text", ["score=high", "confidence=0.5"]],
    ] as const) {
      await assert.rejects(
        () => handle("record", args(...metrics)),
        (e: Error & { code?: string }) => e.code === "VALIDATION",
        why,
      );
    }
  } finally {
    delete process.env["JANUS_DB"];
    rmSync(file, { force: true });
  }
});

test("macro with no verb names the verbs instead of quoting undefined", async () => {
  await assert.rejects(
    () => handle(undefined, []),
    (e: Error & { code?: string }) =>
      e.code === "VALIDATION" && e.message === "macro requires a verb; try: record, reads",
  );
});
