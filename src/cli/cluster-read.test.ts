import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db/connect.ts";
import { migrate } from "../db/migrate.ts";
import { ensureSession, stampPhase } from "../db/repo/session.ts";
import { addCluster } from "../db/repo/cluster.ts";
import { handle } from "./cluster-read.ts";

const NOW = "2026-07-31T12:00:00Z";
const DATE = "2026-07-31";

// cluster-read record opens its own db via JANUS_DB, so a real temp file is
// needed. regime must already be stamped for phase order to let it run.
function freshDbFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "janus-cluster-read-test-"));
  const file = join(dir, "janus.db");
  const db = openDb(file);
  migrate(db);
  ensureSession(db, DATE, NOW);
  stampPhase(db, DATE, "regime", NOW);
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

// See regime.test.ts: parseArgs cannot take `--bias -1`, so the bearish half of
// the scale is only reachable through the `=` form documented in the README.
test("--bias=-1 records a bearish cluster read", async () => {
  await withHarness(async () => {
    const result = (await handle("record", [
      "majors", "--date", DATE, "--bias=-1", "--judgement", "majors look heavy",
    ])) as { recorded: string; read: number };
    assert.equal(result.recorded, "majors");

    const list = (await handle("list", ["--date", DATE])) as { reads: { bias: number }[] };
    assert.equal(list.reads[0]!.bias, -1, "the negative reached the database intact");
  });
});

test("cluster-read with no verb names the verbs instead of quoting undefined", async () => {
  await withHarness(async () => {
    await assert.rejects(
      () => handle(undefined, []),
      (e: Error & { code?: string }) =>
        e.code === "VALIDATION" && e.message === "cluster-read requires a verb; try: record, list",
    );
  });
});
