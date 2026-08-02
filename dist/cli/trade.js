import { Command } from "commander";
import { requireAssetBySymbol, requireSymbols } from "../db/repo/asset.js";
import { openTrade, addUnit, setStop, exitUnits, getTrade, listTrades } from "../db/repo/trade.js";
import { getSession } from "../db/repo/session.js";
import { todayNY, nowIso } from "../domain/session.js";
import { csv, num, oneOf, positive, readText, required, unknownVerb } from "./args.js";
import { handler, withDb } from "./command.js";
import { JanusError } from "../output.js";
const VERBS = "open, add-unit, set-stop, exit, list, show";
// Risk may legitimately be 0 once a stop has been moved past entry (free carry).
const RISK_MAX = Number.MAX_SAFE_INTEGER;
function tradeId(raw) {
    const id = Number(required(raw, "trade_id"));
    if (!Number.isInteger(id) || id < 1) {
        throw new JanusError("VALIDATION", `trade_id must be a positive integer, got ${raw}`);
    }
    return id;
}
/** `--unit` addresses one unit of a trade; absent means every open unit. */
function unitSeq(raw) {
    if (raw === undefined)
        return undefined;
    const seq = Number(raw);
    if (!Number.isInteger(seq) || seq < 1) {
        throw new JanusError("VALIDATION", `--unit must be a positive integer, got ${raw}`);
    }
    return seq;
}
export function build(emit) {
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
        .action(async (symbol, opts) => emit(await open(symbol, opts)));
    cmd.command("add-unit")
        .description("Add a unit to an open trade")
        .argument("[trade_id]", "trade id")
        .option("--price <N>", "entry price")
        .option("--stop <N>", "stop for this unit")
        .option("--risk <N>", "risk in account terms")
        .option("--notional <N>", "size of this unit")
        .option("--date <YYYY-MM-DD>", "the real entry date")
        .option("--tag <TEXT>", "unit tag, e.g. runner or core")
        .action(async (id, opts) => emit(await add(id, opts)));
    cmd.command("set-stop")
        .description("Move the stop on every open unit, or just one")
        .argument("[trade_id]", "trade id")
        .option("--stop <N>", "new stop")
        .option("--unit <SEQ>", "restrict to one unit")
        .action(async (id, opts) => emit(await stop(id, opts)));
    cmd.command("exit")
        .description("Close every open unit, or just one")
        .argument("[trade_id]", "trade id")
        .option("--price <N>", "exit price")
        .option("--unit <SEQ>", "restrict to one unit")
        .option("--funding <N>", "funding paid/received over the hold; negative = cost")
        .option("--date <YYYY-MM-DD>", "the real exit date")
        .action(async (id, opts) => emit(await exit(id, opts)));
    cmd.command("list")
        .description("List trades")
        .option("--open", "only open trades")
        .option("--closed", "only closed trades")
        .option("--asset <SYM[,SYM...]>", "restrict to these symbols")
        .action(async (opts) => emit(await list(opts)));
    cmd.command("show")
        .description("One trade with its units and summary")
        .argument("[trade_id]", "trade id")
        .action(async (id) => emit(await withDb((db) => getTrade(db, tradeId(id)))));
    return cmd;
}
function open(symbol, opts) {
    return withDb((db) => {
        const on = opts.date ?? todayNY();
        const asset = requireAssetBySymbol(db, required(symbol, "symbol").toUpperCase());
        const session = getSession(db, on);
        const id = openTrade(db, {
            asset_id: asset.id,
            direction: oneOf(opts.direction, "direction", ["long", "short"]),
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
function add(raw, opts) {
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
        return { seq, ...getTrade(db, id) };
    });
}
function stop(raw, opts) {
    return withDb((db) => {
        const id = tradeId(raw);
        const moved = setStop(db, id, positive(opts.stop, "stop"), unitSeq(opts.unit));
        return { units_moved: moved, ...getTrade(db, id) };
    });
}
function exit(raw, opts) {
    return withDb((db) => {
        const id = tradeId(raw);
        const funding = opts.funding === undefined ? undefined : num(opts.funding, "funding", -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
        const res = exitUnits(db, id, positive(opts.price, "price"), opts.date ?? todayNY(), unitSeq(opts.unit), funding);
        return { ...res, ...getTrade(db, id) };
    });
}
function list(opts) {
    return withDb((db) => {
        const status = opts.open === true ? "open" : opts.closed === true ? "closed" : undefined;
        const trades = listTrades(db, { status, symbols: requireSymbols(db, csv(opts.asset)) });
        return { count: trades.length, trades };
    });
}
export const handle = handler(build);
