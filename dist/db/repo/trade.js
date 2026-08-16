import { JanusError } from "../../output.js";
import { tradeSummary, unitsHeat } from "../../domain/trade-math.js";
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
        db.prepare(`INSERT INTO trade_unit (trade_id, seq, entry_on, entry_price, notional, risk, stop, status, tag)
     VALUES (?, 1, ?, ?, ?, ?, ?, 'open', ?)`).run(id, input.opened_on, input.price, input.notional, input.risk, input.stop, input.tag ?? null);
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
    db.prepare(`INSERT INTO trade_unit (trade_id, seq, entry_on, entry_price, notional, risk, stop, status, tag)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`).run(tradeId, seq, input.entry_on, input.price, input.notional, input.risk, input.stop, input.tag ?? null);
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
/**
 * Omitting seq exits every open unit and closes the trade.
 *
 * `funding` is a total for the exit, not a per-unit figure — the CLI asks for
 * "funding paid/received over the hold". Writing it unchanged onto every unit
 * multiplied it by the unit count, because trade-math sums funding across units.
 */
export function exitUnits(db, tradeId, price, exitOn, seq, funding) {
    requireTrade(db, tradeId);
    db.exec("BEGIN");
    try {
        // ponytail: an even split across the closing units. Funding really accrues
        // per notional per day, but nothing reads a unit's funding on its own —
        // only the total — so the split just has to sum back. Weight it by notional
        // if a per-unit figure ever gets surfaced.
        const closing = seq === undefined
            ? db
                .prepare("SELECT COUNT(*) AS n FROM trade_unit WHERE trade_id = ? AND status = 'open'")
                .get(tradeId).n
            : 1;
        const fundingValue = (funding ?? 0) / Math.max(1, closing);
        const result = seq === undefined
            ? db.prepare("UPDATE trade_unit SET status='closed', exit_price=?, exit_on=?, funding=? WHERE trade_id=? AND status='open'").run(price, exitOn, fundingValue, tradeId)
            : db.prepare("UPDATE trade_unit SET status='closed', exit_price=?, exit_on=?, funding=? WHERE trade_id=? AND seq=? AND status='open'").run(price, exitOn, fundingValue, tradeId, seq);
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
/**
 * Bank part of one unit. The closed slice becomes its own row rather than a
 * stored P&L figure on the survivor, so every total in trade-math stays
 * computed on read. Both rows keep the original entry price, which is what
 * leaves avg_entry untouched across the split.
 */
export function partialExitUnit(db, tradeId, seq, price, exitOn, fraction, funding) {
    requireTrade(db, tradeId);
    if (!(fraction > 0 && fraction < 1)) {
        throw new JanusError("VALIDATION", `fraction must be greater than 0 and less than 1, got ${fraction}`);
    }
    db.exec("BEGIN");
    try {
        const unit = db
            .prepare("SELECT * FROM trade_unit WHERE trade_id = ? AND seq = ? AND status = 'open'")
            .get(tradeId, seq);
        if (unit === undefined) {
            throw new JanusError("VALIDATION", `no open unit ${seq} on trade ${tradeId}`);
        }
        // Subtract rather than multiply twice, so the two halves sum to the original
        // exactly instead of drifting by a float ulp.
        const closedNotional = unit.notional * fraction;
        const closedRisk = unit.risk * fraction;
        const remainingNotional = unit.notional - closedNotional;
        const remainingRisk = unit.risk - closedRisk;
        const max = db
            .prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM trade_unit WHERE trade_id = ?")
            .get(tradeId);
        const closedSeq = max.seq + 1;
        db.prepare(`INSERT INTO trade_unit
         (trade_id, seq, entry_on, entry_price, notional, risk, stop, status,
          exit_on, exit_price, funding, tag, partial_exited)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'closed', ?, ?, ?, ?, 1)`).run(tradeId, closedSeq, unit.entry_on, unit.entry_price, closedNotional, closedRisk, unit.stop, exitOn, price, funding ?? 0, unit.tag);
        db.prepare("UPDATE trade_unit SET notional = ?, risk = ?, partial_exited = 1 WHERE trade_id = ? AND seq = ?").run(remainingNotional, remainingRisk, tradeId, seq);
        db.exec("COMMIT");
        return {
            closed_seq: closedSeq,
            closed_notional: closedNotional,
            remaining_notional: remainingNotional,
        };
    }
    catch (e) {
        db.exec("ROLLBACK");
        throw e;
    }
}
/**
 * The open trade for an asset with every unit, for the stop ladder. The
 * trade-level counterpart to positionOf, which reports only side and count.
 * Closed units come along: the ladder reads prior exits to decide which rung
 * it is on. Same zero-open-units collapse as positionOf and openPositions: an
 * open trade whose units have all closed is not a live position, and feeding it
 * to the ladder lets a time stop escalate to "exit" on an asset we are flat in.
 */
export function openTradeForAsset(db, assetId) {
    const row = db
        .prepare(`SELECT id, direction, initial_price, initial_risk, opened_on
       FROM trade WHERE asset_id = ? AND status = 'open'`)
        .get(assetId);
    if (row === undefined)
        return null;
    const units = unitsOf(db, row.id);
    if (!units.some((u) => u.status === "open"))
        return null;
    return {
        direction: row.direction,
        units,
        entry_price: row.initial_price,
        initial_risk: row.initial_risk,
        opened_on: row.opened_on,
    };
}
/**
 * Hand-correctable fields: the figures an operator typed in, and nothing else.
 *
 * Absent from both lists on purpose: identity (`id`, `trade_id`, `seq`,
 * `asset_id`), and any state a command transitions (`status`, `closed_on`,
 * `partial_exited`, `direction`). Readers treat those as invariants — the
 * units=0 collapse in positionOf, the one-open-trade-per-asset index, the
 * ladder's partial_exited add-window — so a hand-edit there manufactures states
 * the rest of the code is written to assume cannot happen. Fix those by
 * reversing the command that set them.
 */
const EDITABLE_TRADE = {
    opened_on: "date",
    initial_price: "posnum",
    initial_stop: "posnum",
    initial_risk: "num",
    thesis: "text",
    origin_session_date: "date",
};
const EDITABLE_UNIT = {
    entry_on: "date",
    entry_price: "posnum",
    notional: "posnum",
    risk: "num",
    stop: "posnum",
    exit_on: "date",
    exit_price: "posnum",
    funding: "num",
    tag: "text",
    notes: "text",
};
/** Why a refused field is refused, for fields someone will plausibly try. */
const OWNED_BY = {
    status: "set by trade exit",
    closed_on: "set by trade exit",
    partial_exited: "set by trade exit --fraction",
    direction: "fixed at open; close the trade and open a new one",
    asset_id: "fixed at open; close the trade and open a new one",
    seq: "identifies the unit",
    id: "identifies the row",
    trade_id: "identifies the row",
    created_at: "a record of when the row was written",
};
function coerce(key, kind, raw) {
    if (kind === "text")
        return String(raw);
    if (kind === "date") {
        const v = String(raw).trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) {
            throw new JanusError("VALIDATION", `${key} must be a YYYY-MM-DD date, got ${raw}`);
        }
        return v;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) {
        throw new JanusError("VALIDATION", `${key} must be a number, got ${raw}`);
    }
    if (kind === "posnum" && n <= 0) {
        throw new JanusError("VALIDATION", `${key} must be greater than zero, got ${n}`);
    }
    return n;
}
/**
 * Correct mistyped fields on a trade, or on one of its units when seq is given.
 * Returns before/after for every field touched: a silent edit to stored history
 * is the kind of thing an operator needs to see land.
 */
export function editTrade(db, tradeId, seq, fields) {
    requireTrade(db, tradeId);
    const keys = Object.keys(fields);
    if (keys.length === 0) {
        throw new JanusError("VALIDATION", "nothing to change; pass --set key=value");
    }
    const allowed = seq === undefined ? EDITABLE_TRADE : EDITABLE_UNIT;
    const target = seq === undefined ? "trade" : "unit";
    for (const key of keys) {
        if (allowed[key] !== undefined)
            continue;
        const owner = OWNED_BY[key];
        throw new JanusError("VALIDATION", owner === undefined
            ? `${key} is not an editable ${target} field; try: ${Object.keys(allowed).join(", ")}`
            : `${key} cannot be hand-edited (${owner})`);
    }
    const row = (seq === undefined
        ? db.prepare("SELECT * FROM trade WHERE id = ?").get(tradeId)
        : db.prepare("SELECT * FROM trade_unit WHERE trade_id = ? AND seq = ?").get(tradeId, seq));
    if (row === undefined)
        throw new JanusError("NOT_FOUND", `no unit ${seq} on trade ${tradeId}`);
    const changed = {};
    for (const key of keys) {
        changed[key] = { from: row[key] ?? null, to: coerce(key, allowed[key], fields[key]) };
    }
    // Column names come from the allowlist above, never from the caller's string.
    const assignments = keys.map((k) => `${k} = ?`).join(", ");
    const values = keys.map((k) => changed[k].to);
    if (seq === undefined) {
        db.prepare(`UPDATE trade SET ${assignments} WHERE id = ?`).run(...values, tradeId);
    }
    else {
        db.prepare(`UPDATE trade_unit SET ${assignments} WHERE trade_id = ? AND seq = ?`)
            .run(...values, tradeId, seq);
    }
    return seq === undefined
        ? { trade_id: tradeId, changed }
        : { trade_id: tradeId, seq, changed };
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
/**
 * Total heat across all open trades in the book. A stop at breakeven or better
 * contributes zero heat, freeing capacity for new positions.
 */
export function bookHeat(db) {
    return openBook(db).reduce((sum, p) => sum + p.heat, 0);
}
/**
 * Every open position with the figures the heat report needs. `bookHeat` sums
 * this rather than running its own query, so the report and the gate that
 * blocks entries can never be reading two different books.
 */
export function openBook(db) {
    const rows = db
        .prepare(`SELECT t.id, t.direction, a.symbol, c.key AS cluster_key
       FROM trade t
       JOIN asset a ON a.id = t.asset_id
       LEFT JOIN cluster c ON c.id = a.cluster_id
       WHERE t.status = 'open'
       ORDER BY a.symbol`)
        .all();
    return rows.map((t) => {
        const units = unitsOf(db, t.id);
        const open = units.filter((u) => u.status === "open");
        return {
            symbol: t.symbol,
            cluster_key: t.cluster_key,
            direction: t.direction,
            open_units: open.length,
            notional: open.reduce((a, u) => a + u.notional, 0),
            heat: unitsHeat(units, t.direction),
            // The longest-held open unit, which is the clock the time stop reads.
            first_entry_on: open.reduce((earliest, u) => u.entry_on === undefined ? earliest
                : earliest === null || u.entry_on < earliest ? u.entry_on
                    : earliest, null),
        };
    });
}
