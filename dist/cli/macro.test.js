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
import { handle } from "./macro.js";
const NOW = "2026-07-31T12:00:00Z";
const DATE = "2026-07-31";
// macro record opens its own db via JANUS_DB, so a real temp file (not
// :memory:) is needed to observe what it wrote.
function freshDbFile() {
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
            "--date", DATE, "--metric", "regime=1.5", "--summary", "x",
        ]);
        const db = openDb(file);
        const session = getSession(db, DATE);
        db.close();
        assert.notEqual(session.cluster_at, null);
        assert.equal(nextPhase(session), "coverage");
    }
    finally {
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
            "--date", DATE, "--metric", "regime=1.5", "--summary", "x",
        ]);
        const db = openDb(file);
        const session = getSession(db, DATE);
        db.close();
        assert.equal(session.cluster_at, null, "vacuous stamp must not fire when there is real work to do");
        assert.equal(nextPhase(session), "cluster");
    }
    finally {
        delete process.env["JANUS_DB"];
        rmSync(file, { force: true });
    }
});
// An argument parser reads a bare leading `-` as the next option, which is why
// the old `--score -2` was rejected as ambiguous. `--metric regime=-2` has no
// such problem: the value is one token that starts with `r`, so the whole
// bearish half of the scale is reachable in the plain space-separated form.
test("--metric regime=-2 records a bearish macro", async () => {
    const file = freshDbFile();
    process.env["JANUS_DB"] = file;
    try {
        const result = (await handle("record", [
            "--date", DATE, "--metric", "regime=-2", "--summary", "risk off",
        ]));
        assert.equal(result.metrics["regime"], -2);
        assert.equal(result.read.state, "NEUTRAL");
        assert.deepEqual(result.results, {});
    }
    finally {
        delete process.env["JANUS_DB"];
        rmSync(file, { force: true });
    }
});
test("a missing or out-of-range required metric is a VALIDATION error", async () => {
    const file = freshDbFile();
    process.env["JANUS_DB"] = file;
    const args = (...metric) => [
        "--date", DATE, "--summary", "x",
        ...metric.flatMap((m) => ["--metric", m]),
    ];
    try {
        for (const [why, metrics] of [
            ["no regime at all", []],
            ["regime out of range", ["regime=3"]],
            ["regime is text", ["regime=risk_on"]],
        ]) {
            await assert.rejects(() => handle("record", args(...metrics)), (e) => e.code === "VALIDATION", why);
        }
    }
    finally {
        delete process.env["JANUS_DB"];
        rmSync(file, { force: true });
    }
});
test("macro with no verb names the verbs instead of quoting undefined", async () => {
    await assert.rejects(() => handle(undefined, []), (e) => e.code === "VALIDATION" && e.message === "macro requires a verb; try: record, reads");
});
