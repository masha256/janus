import { parseArgs } from "node:util";
import { openDb } from "../db/connect.ts";
import { requireAssetBySymbol } from "../db/repo/asset.ts";
import { openTrade, addUnit, setStop, exitUnits, getTrade, listTrades } from "../db/repo/trade.ts";
import { getSession } from "../db/repo/session.ts";
import { todayNY, nowIso } from "../domain/session.ts";
import { csv, num, positive, readText, required } from "./args.ts";
import { JanusError } from "../output.ts";

// Risk may legitimately be 0 once a stop has been moved past entry (free carry).
const RISK_MAX = Number.MAX_SAFE_INTEGER;

function tradeId(raw: string | undefined): number {
  const id = Number(required(raw, "trade_id"));
  if (!Number.isInteger(id) || id < 1) {
    throw new JanusError("VALIDATION", `trade_id must be a positive integer, got ${raw}`);
  }
  return id;
}

export async function handle(verb: string | undefined, argv: string[]): Promise<unknown> {
  const db = openDb();
  try {
    const [first, ...rest] = argv;
    const { values } = parseArgs({
      args: verb === "list" ? argv : rest,
      options: {
        direction: { type: "string" }, price: { type: "string" }, stop: { type: "string" },
        risk: { type: "string" }, notional: { type: "string" }, thesis: { type: "string" },
        unit: { type: "string" }, date: { type: "string" },
        open: { type: "boolean" }, closed: { type: "boolean" }, asset: { type: "string" },
      },
    });
    // `--date` here is the real entry or exit date of a unit, not a session address.
    const on = values.date ?? todayNY();
    const seq = values.unit === undefined ? undefined : Number(values.unit);
    if (seq !== undefined && (!Number.isInteger(seq) || seq < 1)) {
      throw new JanusError("VALIDATION", `--unit must be a positive integer, got ${values.unit}`);
    }

    if (verb === "open") {
      const asset = requireAssetBySymbol(db, required(first, "symbol").toUpperCase());
      const session = getSession(db, on);
      const id = openTrade(db, {
        asset_id: asset.id,
        direction: values.direction === "short" ? "short" : "long",
        opened_on: on,
        price: positive(values.price, "price"),
        stop: positive(values.stop, "stop"),
        risk: num(values.risk, "risk", 0, RISK_MAX),
        notional: positive(values.notional, "notional"),
        thesis: readText(values.thesis) ?? null,
        origin_session_date: session === undefined ? null : session.session_date,
      }, nowIso());
      return getTrade(db, id);
    }

    if (verb === "add-unit") {
      const id = tradeId(first);
      const newSeq = addUnit(db, id, {
        entry_on: on,
        price: positive(values.price, "price"),
        stop: positive(values.stop, "stop"),
        risk: num(values.risk, "risk", 0, RISK_MAX),
        notional: positive(values.notional, "notional"),
      });
      return { seq: newSeq, ...(getTrade(db, id) as object) };
    }

    if (verb === "set-stop") {
      const id = tradeId(first);
      const moved = setStop(db, id, positive(values.stop, "stop"), seq);
      return { units_moved: moved, ...(getTrade(db, id) as object) };
    }

    if (verb === "exit") {
      const id = tradeId(first);
      const res = exitUnits(db, id, positive(values.price, "price"), on, seq);
      return { ...res, ...(getTrade(db, id) as object) };
    }

    if (verb === "show") return getTrade(db, tradeId(first));

    if (verb === "list") {
      const status = values.open === true ? "open" : values.closed === true ? "closed" : undefined;
      const trades = listTrades(db, { status, symbols: csv(values.asset)?.map((s) => s.toUpperCase()) });
      return { count: trades.length, trades };
    }

    throw new JanusError(
      "VALIDATION",
      `unknown verb "${verb}" for trade; try: open, add-unit, set-stop, exit, list, show`,
    );
  } finally {
    db.close();
  }
}
