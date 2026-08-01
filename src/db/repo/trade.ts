import type { DatabaseSync } from "node:sqlite";
import { JanusError } from "../../output.ts";
import { tradeSummary } from "../../domain/trade-math.ts";
import type { UnitRow } from "../../domain/trade-math.ts";

export type OpenTradeInput = {
  asset_id: number;
  direction: "long" | "short";
  opened_on: string;
  price: number;
  stop: number;
  risk: number;
  notional: number;
  thesis: string | null;
  origin_session_date: string | null;
};

export type UnitInput = {
  entry_on: string;
  price: number;
  stop: number;
  risk: number;
  notional: number;
};

type TradeRecord = {
  id: number;
  asset_id: number;
  direction: "long" | "short";
  status: "open" | "closed";
  initial_risk: number;
  symbol: string;
};

function requireTrade(db: DatabaseSync, tradeId: number): TradeRecord {
  const row = db
    .prepare("SELECT t.*, a.symbol FROM trade t JOIN asset a ON a.id = t.asset_id WHERE t.id = ?")
    .get(tradeId) as TradeRecord | undefined;
  if (row === undefined) throw new JanusError("NOT_FOUND", `no trade ${tradeId}`);
  return row;
}

function unitsOf(db: DatabaseSync, tradeId: number): UnitRow[] {
  return db
    .prepare("SELECT * FROM trade_unit WHERE trade_id = ? ORDER BY seq")
    .all(tradeId) as UnitRow[];
}

export function openTrade(db: DatabaseSync, input: OpenTradeInput, now: string): number {
  const held = db
    .prepare("SELECT id FROM trade WHERE asset_id = ? AND status = 'open'")
    .get(input.asset_id) as { id: number } | undefined;
  if (held !== undefined) {
    throw new JanusError(
      "POSITION_CONFLICT",
      `trade ${held.id} is already open on this asset; add a unit or exit it first`,
    );
  }

  db.exec("BEGIN");
  try {
    db.prepare(
      `INSERT INTO trade (asset_id, direction, status, opened_on, initial_price, initial_stop,
                          initial_risk, thesis, origin_session_date, created_at)
       VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(input.asset_id, input.direction, input.opened_on, input.price, input.stop,
          input.risk, input.thesis, input.origin_session_date, now);
    const id = (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
    db.prepare(
      `INSERT INTO trade_unit (trade_id, seq, entry_on, entry_price, notional, risk, stop, status)
       VALUES (?, 1, ?, ?, ?, ?, ?, 'open')`,
    ).run(id, input.opened_on, input.price, input.notional, input.risk, input.stop);
    db.exec("COMMIT");
    return id;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function addUnit(db: DatabaseSync, tradeId: number, input: UnitInput): number {
  const trade = requireTrade(db, tradeId);
  if (trade.status !== "open") {
    throw new JanusError("VALIDATION", `trade ${tradeId} is closed`);
  }
  const max = db
    .prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM trade_unit WHERE trade_id = ?")
    .get(tradeId) as { seq: number };
  const seq = max.seq + 1;
  db.prepare(
    `INSERT INTO trade_unit (trade_id, seq, entry_on, entry_price, notional, risk, stop, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open')`,
  ).run(tradeId, seq, input.entry_on, input.price, input.notional, input.risk, input.stop);
  return seq;
}

/** Returns the number of units moved. Omitting seq moves every open unit. */
export function setStop(db: DatabaseSync, tradeId: number, stop: number, seq?: number): number {
  requireTrade(db, tradeId);
  const result = seq === undefined
    ? db.prepare("UPDATE trade_unit SET stop = ? WHERE trade_id = ? AND status = 'open'").run(stop, tradeId)
    : db.prepare("UPDATE trade_unit SET stop = ? WHERE trade_id = ? AND seq = ? AND status = 'open'").run(stop, tradeId, seq);
  const changed = Number(result.changes);
  if (changed === 0) throw new JanusError("VALIDATION", `no open unit to move on trade ${tradeId}`);
  return changed;
}

/** Omitting seq exits every open unit and closes the trade. */
export function exitUnits(
  db: DatabaseSync,
  tradeId: number,
  price: number,
  exitOn: string,
  seq?: number,
): { closed: number; trade_status: string } {
  requireTrade(db, tradeId);
  db.exec("BEGIN");
  try {
    const result = seq === undefined
      ? db.prepare(
          "UPDATE trade_unit SET status='closed', exit_price=?, exit_on=? WHERE trade_id=? AND status='open'",
        ).run(price, exitOn, tradeId)
      : db.prepare(
          "UPDATE trade_unit SET status='closed', exit_price=?, exit_on=? WHERE trade_id=? AND seq=? AND status='open'",
        ).run(price, exitOn, tradeId, seq);

    const closed = Number(result.changes);
    if (closed === 0) {
      throw new JanusError("VALIDATION", `no open unit to exit on trade ${tradeId}`);
    }

    const remaining = db
      .prepare("SELECT COUNT(*) AS n FROM trade_unit WHERE trade_id = ? AND status = 'open'")
      .get(tradeId) as { n: number };
    const status = remaining.n === 0 ? "closed" : "open";
    if (status === "closed") {
      db.prepare("UPDATE trade SET status='closed', closed_on=? WHERE id=?").run(exitOn, tradeId);
    }
    db.exec("COMMIT");
    return { closed, trade_status: status };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function getTrade(db: DatabaseSync, tradeId: number): unknown {
  const trade = requireTrade(db, tradeId);
  const units = unitsOf(db, tradeId);
  return { trade, units, summary: tradeSummary(trade.direction, trade.initial_risk, units) };
}

export function listTrades(
  db: DatabaseSync,
  filters: { status?: string | undefined; symbols?: string[] | undefined },
): unknown[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (filters.status !== undefined) {
    where.push("t.status = ?");
    args.push(filters.status);
  }
  if (filters.symbols !== undefined) {
    where.push(`a.symbol IN (${filters.symbols.map(() => "?").join(",")})`);
    args.push(...filters.symbols);
  }
  const trades = db
    .prepare(
      `SELECT t.*, a.symbol FROM trade t JOIN asset a ON a.id = t.asset_id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY t.opened_on DESC, t.id DESC`,
    )
    .all(...args) as TradeRecord[];

  return trades.map((t) => {
    const units = unitsOf(db, t.id);
    return { ...t, summary: tradeSummary(t.direction, t.initial_risk, units) };
  });
}
