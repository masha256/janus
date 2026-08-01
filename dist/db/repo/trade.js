import { JanusError } from "../../output.js";
import { tradeSummary } from "../../domain/trade-math.js";
function requireTrade(db, tradeId) {
    const row = db
        .prepare("SELECT t.*, a.symbol FROM trade t JOIN asset a ON a.id = t.asset_id WHERE t.id = ?")
        .get(tradeId);
    if (row === undefined)
        throw new JanusError("NOT_FOUND", `no trade ${tradeId}`);
    return row;
}
function unitsOf(db, tradeId) {
    return db
        .prepare("SELECT * FROM trade_unit WHERE trade_id = ? ORDER BY seq")
        .all(tradeId);
}
export function openTrade(db, input, now) {
    const held = db
        .prepare("SELECT id FROM trade WHERE asset_id = ? AND status = 'open'")
        .get(input.asset_id);
    if (held !== undefined) {
        throw new JanusError("POSITION_CONFLICT", `trade ${held.id} is already open on this asset; add a unit or exit it first`);
    }
    db.exec("BEGIN");
    try {
        db.prepare(`INSERT INTO trade (asset_id, direction, status, opened_on, initial_price, initial_stop,
                          initial_risk, thesis, origin_session_date, created_at)
       VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`).run(input.asset_id, input.direction, input.opened_on, input.price, input.stop, input.risk, input.thesis, input.origin_session_date, now);
        const id = db.prepare("SELECT last_insert_rowid() AS id").get().id;
        db.prepare(`INSERT INTO trade_unit (trade_id, seq, entry_on, entry_price, notional, risk, stop, status)
       VALUES (?, 1, ?, ?, ?, ?, ?, 'open')`).run(id, input.opened_on, input.price, input.notional, input.risk, input.stop);
        db.exec("COMMIT");
        return id;
    }
    catch (e) {
        db.exec("ROLLBACK");
        throw e;
    }
}
export function addUnit(db, tradeId, input) {
    const trade = requireTrade(db, tradeId);
    if (trade.status !== "open") {
        throw new JanusError("VALIDATION", `trade ${tradeId} is closed`);
    }
    const max = db
        .prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM trade_unit WHERE trade_id = ?")
        .get(tradeId);
    const seq = max.seq + 1;
    db.prepare(`INSERT INTO trade_unit (trade_id, seq, entry_on, entry_price, notional, risk, stop, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open')`).run(tradeId, seq, input.entry_on, input.price, input.notional, input.risk, input.stop);
    return seq;
}
/** Returns the number of units moved. Omitting seq moves every open unit. */
export function setStop(db, tradeId, stop, seq) {
    requireTrade(db, tradeId);
    const result = seq === undefined
        ? db.prepare("UPDATE trade_unit SET stop = ? WHERE trade_id = ? AND status = 'open'").run(stop, tradeId)
        : db.prepare("UPDATE trade_unit SET stop = ? WHERE trade_id = ? AND seq = ? AND status = 'open'").run(stop, tradeId, seq);
    const changed = Number(result.changes);
    if (changed === 0)
        throw new JanusError("VALIDATION", `no open unit to move on trade ${tradeId}`);
    return changed;
}
/** Omitting seq exits every open unit and closes the trade. */
export function exitUnits(db, tradeId, price, exitOn, seq) {
    requireTrade(db, tradeId);
    db.exec("BEGIN");
    try {
        const result = seq === undefined
            ? db.prepare("UPDATE trade_unit SET status='closed', exit_price=?, exit_on=? WHERE trade_id=? AND status='open'").run(price, exitOn, tradeId)
            : db.prepare("UPDATE trade_unit SET status='closed', exit_price=?, exit_on=? WHERE trade_id=? AND seq=? AND status='open'").run(price, exitOn, tradeId, seq);
        const closed = Number(result.changes);
        if (closed === 0) {
            throw new JanusError("VALIDATION", `no open unit to exit on trade ${tradeId}`);
        }
        const remaining = db
            .prepare("SELECT COUNT(*) AS n FROM trade_unit WHERE trade_id = ? AND status = 'open'")
            .get(tradeId);
        const status = remaining.n === 0 ? "closed" : "open";
        if (status === "closed") {
            db.prepare("UPDATE trade SET status='closed', closed_on=? WHERE id=?").run(exitOn, tradeId);
        }
        db.exec("COMMIT");
        return { closed, trade_status: status };
    }
    catch (e) {
        db.exec("ROLLBACK");
        throw e;
    }
}
export function getTrade(db, tradeId) {
    const trade = requireTrade(db, tradeId);
    const units = unitsOf(db, tradeId);
    return { trade, units, summary: tradeSummary(trade.direction, trade.initial_risk, units) };
}
export function listTrades(db, filters) {
    const where = [];
    const args = [];
    if (filters.status !== undefined) {
        where.push("t.status = ?");
        args.push(filters.status);
    }
    if (filters.symbols !== undefined) {
        where.push(`a.symbol IN (${filters.symbols.map(() => "?").join(",")})`);
        args.push(...filters.symbols);
    }
    const trades = db
        .prepare(`SELECT t.*, a.symbol FROM trade t JOIN asset a ON a.id = t.asset_id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY t.opened_on DESC, t.id DESC`)
        .all(...args);
    return trades.map((t) => {
        const units = unitsOf(db, t.id);
        return { ...t, summary: tradeSummary(t.direction, t.initial_risk, units) };
    });
}
