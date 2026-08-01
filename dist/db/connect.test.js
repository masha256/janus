import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, dbPath, DEFAULT_DB } from "./connect.js";
test("the default database is a fixed path under the home directory", () => {
    // Not cwd-relative: `janus` run from two directories must reach one database.
    assert.match(DEFAULT_DB, /\.janus[/\\]janus\.db$/);
    assert.ok(!DEFAULT_DB.startsWith("."), "an absolute path, whatever the cwd");
});
test("dbPath prefers an explicit path, then JANUS_DB, then the default", () => {
    const previous = process.env["JANUS_DB"];
    try {
        delete process.env["JANUS_DB"];
        assert.equal(dbPath(), DEFAULT_DB);
        assert.equal(dbPath("/tmp/explicit.db"), "/tmp/explicit.db");
        process.env["JANUS_DB"] = "/tmp/from-env.db";
        assert.equal(dbPath(), "/tmp/from-env.db");
        assert.equal(dbPath("/tmp/explicit.db"), "/tmp/explicit.db", "an argument still wins");
    }
    finally {
        if (previous === undefined)
            delete process.env["JANUS_DB"];
        else
            process.env["JANUS_DB"] = previous;
    }
});
test("openDb creates the directory holding the database", () => {
    // SQLite creates the file but not its parent, so a first run against
    // ~/.janus/janus.db would fail on a machine that has never run janus.
    const root = mkdtempSync(join(tmpdir(), "janus-connect-test-"));
    const file = join(root, "nested", "deeper", "janus.db");
    try {
        const db = openDb(file);
        db.close();
        assert.ok(existsSync(file), "the database was created two directories down");
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
test("an in-memory database makes no directories", () => {
    const db = openDb(":memory:");
    db.close();
    assert.ok(!existsSync(":memory:"));
});
