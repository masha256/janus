import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db/connect.js";
import { migrate } from "../db/migrate.js";
import { ensureSession, getSession } from "../db/repo/session.js";
import { addCluster } from "../db/repo/cluster.js";
import { nextPhase } from "../domain/session.js";
import { handle } from "./regime.js";
const NOW = "2026-07-31T12:00:00Z";
const DATE = "2026-07-31";
// regime record opens its own db via JANUS_DB, so a real temp file (not
// :memory:) is needed to observe what it wrote.
function freshDbFile() {
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
        const session = getSession(db, DATE);
        db.close();
        assert.notEqual(session.cluster_read_at, null);
        assert.equal(nextPhase(session), "coverage");
    }
    finally {
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
        const session = getSession(db, DATE);
        db.close();
        assert.equal(session.cluster_read_at, null, "vacuous stamp must not fire when there is real work to do");
        assert.equal(nextPhase(session), "cluster_read");
    }
    finally {
        delete process.env["JANUS_DB"];
        rmSync(file, { force: true });
    }
});
// node:util.parseArgs reads a leading `-` as the next option, so `--score -2`
// fails as ambiguous. The `--flag=-2` form is the documented way to pass a
// negative (see README) and it is the only way the bearish half of the scale
// is reachable — hence this test.
test("--score=-2 records a bearish regime", async () => {
    const file = freshDbFile();
    process.env["JANUS_DB"] = file;
    try {
        const result = (await handle("record", [
            "--date", DATE, "--state", "RISK_OFF", "--score=-2",
            "--confidence=0.5", "--summary", "risk off",
        ]));
        assert.equal(result.metrics["score"], -2);
        assert.equal(result.read.state, "RISK_OFF");
    }
    finally {
        delete process.env["JANUS_DB"];
        rmSync(file, { force: true });
    }
});
test("the space-separated `--score -2` form fails with VALIDATION, not silently", async () => {
    const file = freshDbFile();
    process.env["JANUS_DB"] = file;
    try {
        await assert.rejects(() => handle("record", [
            "--date", DATE, "--state", "RISK_OFF", "--score", "-2",
            "--confidence", "0.5", "--summary", "risk off",
        ]), 
        // parseArgs raises ERR_PARSE_ARGS_INVALID_OPTION_VALUE, which envelope()
        // maps to VALIDATION; the message itself names the `=` fix.
        (e) => /ERR_PARSE_ARGS_/.test(e.code ?? ""));
    }
    finally {
        delete process.env["JANUS_DB"];
        rmSync(file, { force: true });
    }
});
test("regime with no verb names the verbs instead of quoting undefined", async () => {
    await assert.rejects(() => handle(undefined, []), (e) => e.code === "VALIDATION" && e.message === "regime requires a verb; try: record, show");
});
