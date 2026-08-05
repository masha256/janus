import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./connect.js";
import { migrate } from "./migrate.js";
test("migrate creates every table and is idempotent", () => {
    const db = openDb(":memory:");
    const v1 = migrate(db);
    const v2 = migrate(db);
    assert.equal(v1, v2, "re-running migrate must not advance the version");
    const names = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all()
        .map((r) => r.name);
    for (const t of [
        "asset", "cluster", "cluster_param", "cluster", "cluster_read_metric",
        "cluster_read_result", "coverage", "global_param", "market", "macro_read",
        "macro_read_metric", "macro_read_result", "score", "score_metric", "score_result",
        "screen", "screen_metric", "screen_result", "session", "trade", "trade_unit",
    ]) {
        assert.ok(names.includes(t), `missing table ${t}`);
    }
    db.close();
});
test("only one open trade per asset is allowed", () => {
    const db = openDb(":memory:");
    migrate(db);
    db.exec(`
    INSERT INTO market VALUES (1,'BTC','perp','active',1,5,'2025-01-01','2026-07-31');
    INSERT INTO asset (id,market_id,symbol,class,active,added_at)
      VALUES (1,1,'BTC','crypto',1,'2026-07-31');
  `);
    const ins = db.prepare(`INSERT INTO trade (asset_id,direction,status,opened_on,initial_price,initial_stop,initial_risk,created_at)
     VALUES (1,'long','open','2026-07-31',100,90,10,'2026-07-31T00:00:00Z')`);
    ins.run();
    assert.throws(() => ins.run(), /UNIQUE/i);
    db.close();
});
test("foreign keys cascade from session to its phase rows", () => {
    const db = openDb(":memory:");
    migrate(db);
    db.exec(`
    INSERT INTO session (session_date,opened_at) VALUES ('2026-07-31','2026-07-31T00:00:00Z');
    INSERT INTO macro_read VALUES ('2026-07-31','flat','2026-07-31T00:00:00Z');
  `);
    db.exec("DELETE FROM session WHERE session_date='2026-07-31'");
    const rows = db.prepare("SELECT COUNT(*) AS n FROM macro_read").get();
    assert.equal(rows.n, 0, "macro_read should cascade");
    db.close();
});
