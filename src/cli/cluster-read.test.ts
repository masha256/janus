import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db/connect.ts";
import { migrate } from "../db/migrate.ts";
import { ensureSession, stampPhase } from "../db/repo/session.ts";
import { addCluster } from "../db/repo/cluster.ts";
import { recordMacro } from "../db/repo/phase.ts";
import { handle } from "./cluster.ts";

const NOW = "2026-07-31T12:00:00Z";
const DATE = "2026-07-31";

// cluster record opens its own db via JANUS_DB, so a real temp file is
// needed. macro must already be recorded for phase order to let it run.
function freshDbFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "janus-cluster-read-test-"));
  const file = join(dir, "janus.db");
  const db = openDb(file);
  migrate(db);
  ensureSession(db, DATE, NOW);
  recordMacro(db, DATE, { metrics: { regime: 0.5 }, results: {}, summary: "neutral" }, NOW);
  stampPhase(db, DATE, "macro", NOW);
  addCluster(db, "majors", "Majors", null, null, NOW);
  db.close();
  return file;
}

async function withHarness(run: () => Promise<void>): Promise<void> {
  const file = freshDbFile();
  process.env["JANUS_DB"] = file;
  try {
    await run();
  } finally {
    delete process.env["JANUS_DB"];
    rmSync(file, { force: true });
  }
}

test("cluster record stores whatever metrics the caller supplies", async () => {
  await withHarness(async () => {
    const result = (await handle("record", [
      "majors", "--date", DATE, "--metric", "breadth=0.7", "--metric", "regime=0.5",
    ])) as { recorded: string; read: number };
    assert.equal(result.recorded, "majors");

    const list = (await handle("reads", ["--date", DATE])) as
      { reads: { metrics: Record<string, number | string>; results: Record<string, number> }[] };
    assert.equal(list.reads[0]!.metrics["breadth"], 0.7);
    assert.equal(list.reads[0]!.metrics["regime"], 0.5);
    assert.deepEqual(list.reads[0]!.results, {});
  });
});

test("cluster with no verb names every verb, roster and phase alike", async () => {
  await withHarness(async () => {
    await assert.rejects(
      () => handle(undefined, []),
      (e: Error & { code?: string }) =>
        e.code === "VALIDATION" &&
        e.message === "cluster requires a verb; try: add, list, show, set-description, set-param, rm, record, reads",
    );
  });
});

// `list` is the roster listing, `reads` the session's reads: the merge must not
// have crossed them.
test("cluster list stays the roster, not the session's reads", async () => {
  await withHarness(async () => {
    await handle("record", [
      "majors", "--date", DATE, "--metric", "breadth=0.7", "--metric", "regime=0.5",
    ]);
    const roster = (await handle("list", [])) as { count: number; clusters: unknown[] };
    assert.equal(roster.count, 1);
    assert.ok(!("reads" in roster), "cluster list must not return session reads");

    const reads = (await handle("reads", ["--date", DATE])) as { count: number };
    assert.equal(reads.count, 1);
  });
});
