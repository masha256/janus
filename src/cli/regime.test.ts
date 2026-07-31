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
import { handle } from "./regime.ts";

const NOW = "2026-07-31T12:00:00Z";
const DATE = "2026-07-31";

// regime record opens its own db via JANUS_DB, so a real temp file (not
// :memory:) is needed to observe what it wrote.
function freshDbFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "janus-regime-test-"));
  const file = join(dir, "janus.db");
  const db = openDb(file);
  migrate(db);
  ensureSession(db, DATE, NOW);
  db.close();
  return file;
}

test("zero clusters: a regime record vacuously completes cluster_read too", async () => {
  const file = freshDbFile();
  process.env["JANUS_DB"] = file;
  try {
    await handle("record", [
      "--date", DATE, "--state", "RISK_ON", "--score", "1.5",
      "--confidence", "0.5", "--summary", "x",
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

test("with a cluster present, a regime record does NOT stamp cluster_read", async () => {
  const file = freshDbFile();
  const db0 = openDb(file);
  addCluster(db0, "majors", "Majors", null, NOW);
  db0.close();
  process.env["JANUS_DB"] = file;
  try {
    await handle("record", [
      "--date", DATE, "--state", "RISK_ON", "--score", "1.5",
      "--confidence", "0.5", "--summary", "x",
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
