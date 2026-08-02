import { Command } from "commander";
import { requireAssetBySymbol, requireSymbols } from "../db/repo/asset.ts";
import { openTrade, addUnit, setStop, exitUnits, getTrade, listTrades } from "../db/repo/trade.ts";
import { getSession } from "../db/repo/session.ts";
import { todayNY, nowIso } from "../domain/session.ts";
import { csv, num, oneOf, positive, readText, required, unknownVerb } from "./args.ts";
import { type Emit, handler, withDb } from "./command.ts";
import { JanusError } from "../output.ts";

const VERBS = "open, add-unit, set-stop, exit, list, show";

// Risk may legitimately be 0 once a stop has been moved past entry (free carry).
const RISK_MAX = Number.MAX_SAFE_INTEGER;

// `--date` on trade is the real entry or exit date of a unit, not a session address.
type OpenOpts = {
  direction?: string; price?: string; stop?: string; risk?: string;
  notional?: string; thesis?: string; date?: string; tag?: string;
};
type UnitOpts = { price?: string; stop?: string; risk?: string; notional?: string; date?: string; tag?: string };
type StopOpts = { stop?: string; unit?: string };
type ExitOpts = { price?: string; unit?: string; date?: string; funding?: string };

function tradeId(raw: string | undefined): number {
  const id = Number(required(raw, "trade_id"));
  if (!Number.isInteger(id) || id < 1) {
    throw new JanusError("VALIDATION", `trade_id must be a positive integer, got ${raw}`);
  }
  return id;
}

/** `--unit` addresses one unit of a trade; absent means every open unit. */
function unitSeq(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const seq = Number(raw);
  if (!Number.isInteger(seq) || seq < 1) {
    throw new JanusError("VALIDATION", `--unit must be a positive integer, got ${raw}`);
  }
  return seq;
}

export function build(emit: Emit): Command {
  const cmd = new Command("trade")
    .description("The positions an operator actually put on")
    .action(() => { throw unknownVerb(undefined, "trade", VERBS); });

  cmd.command("open")
    .description("Open a trade with its first unit")
    .argument("[symbol]", "market symbol")
    .option("--direction <long|short>", "required; a short logged as a long inverts everything")
    .option("--price <N>", "entry price")
    .option("--stop <N>", "initial stop")
    .option("--risk <N>", "risk in account terms; 0 is allowed (free carry)")
    .option("--notional <N>", "position size")
    .option("--thesis <TEXT>", "free text; - reads stdin")
    .option("--tag <TEXT>", "unit tag, e.g. runner or core")
    .option("--date <YYYY-MM-DD>", "the real entry date, not a session address")
    .action(async (symbol: string | undefined, opts: OpenOpts) => emit(await open(symbol, opts)));

  cmd.command("add-unit")
    .description("Add a unit to an open trade")
    .argument("[trade_id]", "trade id")
    .option("--price <N>", "entry price")
    .option("--stop <N>", "stop for this unit")
    .option("--risk <N>", "risk in account terms")
    .option("--notional <N>", "size of this unit")
    .option("--date <YYYY-MM-DD>", "the real entry date")
    .option("--tag <TEXT>", "unit tag, e.g. runner or core")
    .action(async (id: string | undefined, opts: UnitOpts) => emit(await add(id, opts)));

  cmd.command("set-stop")
    .description("Move the stop on every open unit, or just one")
    .argument("[trade_id]", "trade id")
    .option("--stop <N>", "new stop")
    .option("--unit <SEQ>", "restrict to one unit")
    .action(async (id: string | undefined, opts: StopOpts) => emit(await stop(id, opts)));

  cmd.command("exit")
    .description("Close every open unit, or just one")
    .argument("[trade_id]", "trade id")
    .option("--price <N>", "exit price")
    .option("--unit <SEQ>", "restrict to one unit")
    .option("--funding <N>", "funding paid/received over the hold; negative = cost")
    .option("--date <YYYY-MM-DD>", "the real exit date")
    .action(async (id: string | undefined, opts: ExitOpts) => emit(await exit(id, opts)));

  cmd.command("list")
    .description("List trades")
    .option("--open", "only open trades")
    .option("--closed", "only closed trades")
    .option("--asset <SYM[,SYM...]>", "restrict to these symbols")
    .action(async (opts: { open?: boolean; closed?: boolean; asset?: string }) => emit(await list(opts)));

  cmd.command("show")
    .description("One trade with its units and summary")
    .argument("[trade_id]", "trade id")
    .action(async (id: string | undefined) => emit(await withDb((db) => getTrade(db, tradeId(id)))));

  return cmd;
}

function open(symbol: string | undefined, opts: OpenOpts): Promise<unknown> {
  return withDb((db) => {
    const on = opts.date ?? todayNY();
    const asset = requireAssetBySymbol(db, required(symbol, "symbol").toUpperCase());
    const session = getSession(db, on);
    const id = openTrade(db, {
      asset_id: asset.id,
      direction: oneOf(opts.direction, "direction", ["long", "short"] as const),
      opened_on: on,
      price: positive(opts.price, "price"),
      stop: positive(opts.stop, "stop"),
      risk: num(opts.risk, "risk", 0, RISK_MAX),
      notional: positive(opts.notional, "notional"),
      thesis: readText(opts.thesis) ?? null,
      origin_session_date: session === undefined ? null : session.session_date,
      tag: opts.tag ?? null,
    }, nowIso());
    return getTrade(db, id);
  });
}

function add(raw: string | undefined, opts: UnitOpts): Promise<unknown> {
  return withDb((db) => {
    const id = tradeId(raw);
    const seq = addUnit(db, id, {
      entry_on: opts.date ?? todayNY(),
      price: positive(opts.price, "price"),
      stop: positive(opts.stop, "stop"),
      risk: num(opts.risk, "risk", 0, RISK_MAX),
      notional: positive(opts.notional, "notional"),
      tag: opts.tag ?? null,
    });
    return { seq, ...(getTrade(db, id) as object) };
  });
}

function stop(raw: string | undefined, opts: StopOpts): Promise<unknown> {
  return withDb((db) => {
    const id = tradeId(raw);
    const moved = setStop(db, id, positive(opts.stop, "stop"), unitSeq(opts.unit));
    return { units_moved: moved, ...(getTrade(db, id) as object) };
  });
}

function exit(raw: string | undefined, opts: ExitOpts): Promise<unknown> {
  return withDb((db) => {
    const id = tradeId(raw);
    const funding = opts.funding === undefined ? undefined : num(opts.funding, "funding", -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    const res = exitUnits(db, id, positive(opts.price, "price"), opts.date ?? todayNY(), unitSeq(opts.unit), funding);
    return { ...res, ...(getTrade(db, id) as object) };
  });
}

function list(opts: { open?: boolean; closed?: boolean; asset?: string }): Promise<unknown> {
  return withDb((db) => {
    const status = opts.open === true ? "open" : opts.closed === true ? "closed" : undefined;
    const trades = listTrades(db, { status, symbols: requireSymbols(db, csv(opts.asset)) });
    return { count: trades.length, trades };
  });
}

export const handle = handler(build);
