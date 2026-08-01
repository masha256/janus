import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db/connect.ts";
import { migrate } from "../db/migrate.ts";
import { ensureSession, stampPhase } from "../db/repo/session.ts";
import { addCluster } from "../db/repo/cluster.ts";
import { handle } from "./cluster.ts";

const NOW = "2026-07-31T12:00:00Z";
const DATE = "2026-07-31";

// cluster record opens its own db via JANUS_DB, so a real temp file is
// needed. macro must already be stamped for phase order to let it run.
function freshDbFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "janus-cluster-read-test-"));
  const file = join(dir, "janus.db");
  const db = openDb(file);
  migrate(db);
  ensureSession(db, DATE, NOW);
  stampPhase(db, DATE, "macro", NOW);
  addCluster(db, "majors", "Majors", null, NOW);
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

// See macro.test.ts: `--metric bias=-1` is one token, so the bearish half of
// the scale survives option parsing in the plain space-separated form.
// Judgement is free text riding the same flag, stored in value_text.
test("--metric bias=-1 records a bearish cluster read alongside its judgement", async () => {
  await withHarness(async () => {
    const result = (await handle("record", [
      "majors", "--date", DATE, "--metric", "bias=-1",
      "--metric", "judgement=majors look heavy",
    ])) as { recorded: string; read: number };
    assert.equal(result.recorded, "majors");

    const list = (await handle("reads", ["--date", DATE])) as
      { reads: { metrics: Record<string, number | string> }[] };
    assert.equal(list.reads[0]!.metrics["bias"], -1, "the negative reached the database intact");
    assert.equal(list.reads[0]!.metrics["judgement"], "majors look heavy");
  });
});

test("cluster with no verb names every verb, roster and phase alike", async () => {
  await withHarness(async () => {
    await assert.rejects(
      () => handle(undefined, []),
      (e: Error & { code?: string }) =>
        e.code === "VALIDATION" &&
        e.message === "cluster requires a verb; try: add, list, show, set-param, rm, record, reads",
    );
  });
});

// `list` is the roster listing, `reads` the session's reads: the merge must not
// have crossed them.
test("cluster list stays the roster, not the session's reads", async () => {
  await withHarness(async () => {
    await handle("record", [
      "majors", "--date", DATE, "--metric", "bias=1", "--metric", "judgement=intact",
    ]);
    const roster = (await handle("list", [])) as { count: number; clusters: unknown[] };
    assert.equal(roster.count, 1);
    assert.ok(!("reads" in roster), "cluster list must not return session reads");

    const reads = (await handle("reads", ["--date", DATE])) as { count: number };
    assert.equal(reads.count, 1);
  });
});
