import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./connect.js";
import { migrate, MIGRATIONS } from "./migrate.js";
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
test("migration 1 drops the dead ladder columns", () => {
    const db = openDb(":memory:");
    const version = migrate(db);
    assert.equal(version, 2, "schema should be at version 2");
    const cols = (table) => db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table)
        .map((r) => r.name);
    const trade = cols("trade");
    assert.ok(!trade.includes("target_price"), "trade.target_price should be dropped");
    assert.ok(!trade.includes("add_window_open"), "trade.add_window_open should be dropped");
    const unit = cols("trade_unit");
    assert.ok(!unit.includes("breakeven_moved_at"), "breakeven_moved_at should be dropped");
    assert.ok(!unit.includes("time_stop_date"), "time_stop_date should be dropped");
    assert.ok(unit.includes("partial_exited"), "partial_exited must survive");
    db.close();
});
test("migration 1 preserves the rows in an existing v1 database", () => {
    const db = openDb(":memory:");
    // Stand up a genuine v1 database: the baseline schema and nothing after it.
    // Do NOT just set user_version = 1 on an empty database — migrate would then
    // skip the baseline and run the ALTERs against tables that do not exist.
    db.exec(MIGRATIONS[0]);
    db.exec("PRAGMA user_version = 1");
    db.exec(`
    INSERT INTO market VALUES (1,'BTC','perp','active',1,5,'2025-01-01','2026-07-31');
    INSERT INTO asset (id,market_id,symbol,class,active,added_at)
      VALUES (1,1,'BTC','crypto',1,'2026-07-31');
    INSERT INTO trade (id,asset_id,direction,status,opened_on,initial_price,initial_stop,initial_risk,created_at)
      VALUES (1,1,'long','open','2026-07-31',100,90,10,'2026-07-31T00:00:00Z');
    INSERT INTO trade_unit (trade_id,seq,entry_on,entry_price,notional,risk,stop,status,partial_exited)
      VALUES (1,1,'2026-07-31',100,1000,10,90,'open',1);
  `);
    assert.equal(migrate(db), 2, "a v1 database migrates to 2");
    const row = db
        .prepare("SELECT notional, entry_price, partial_exited FROM trade_unit WHERE trade_id=1 AND seq=1")
        .get();
    assert.equal(row.notional, 1000, "dropping columns must not disturb surviving values");
    assert.equal(row.entry_price, 100);
    assert.equal(row.partial_exited, 1, "partial_exited survives the drop");
    const trades = db.prepare("SELECT COUNT(*) AS n FROM trade").get();
    assert.equal(trades.n, 1, "no rows lost");
    db.close();
});
