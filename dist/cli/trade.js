import { Command } from "commander";
import { requireAssetBySymbol, requireSymbols } from "../db/repo/asset.js";
import { openTrade, addUnit, setStop, exitUnits, getTrade, listTrades } from "../db/repo/trade.js";
import { getSession } from "../db/repo/session.js";
import { latestCoverage } from "../db/repo/coverage.js";
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
        .description("One trade with its units, summary, and current coverage progress")
        .argument("[trade_id]", "trade id")
        .option("--date <YYYY-MM-DD>", "coverage reference date; defaults to today, New York")
        .action(async (id, opts) => emit(await show(id, opts.date)));
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
function show(raw, date) {
    return withDb((db) => {
        const id = tradeId(raw);
        const base = getTrade(db, id);
        const latest = latestCoverage(db, base.trade.asset_id);
        const today = date ?? todayNY();
        const stale = latest === null || latest.session_date < today;
        const warnings = [];
        if (latest === null) {
            warnings.push("no coverage data found for this asset; run coverage first");
        }
        else if (stale) {
            warnings.push(`coverage is stale: latest ${latest.session_date}, today ${today}`);
        }
        const markPrice = latest?.values.mark_price ?? null;
        const sign = base.trade.direction === "long" ? 1 : -1;
        const enrichedUnits = base.units.map((u) => {
            if (u.status !== "open" || markPrice === null)
                return u;
            const size = u.notional / u.entry_price;
            const unrealizedPnl = size * (markPrice - u.entry_price) * sign;
            const rMultiple = base.trade.initial_risk === 0 ? null : unrealizedPnl / base.trade.initial_risk;
            const distanceToStop = u.stop === 0 ? null : (markPrice - u.stop) * sign;
            return {
                ...u,
                mark_price: markPrice,
                unrealized_pnl: unrealizedPnl,
                unrealized_r: rMultiple,
                distance_to_stop: distanceToStop,
            };
        });
        const openUnits = base.units.filter((u) => u.status === "open");
        const tradeUnrealized = markPrice === null || openUnits.length === 0
            ? null
            : openUnits.reduce((a, u) => {
                const size = u.notional / u.entry_price;
                return a + size * (markPrice - u.entry_price) * sign;
            }, 0);
        const tradeUnrealizedR = tradeUnrealized === null || base.trade.initial_risk === 0
            ? null
            : tradeUnrealized / base.trade.initial_risk;
        return {
            ...base,
            units: enrichedUnits,
            coverage: latest === null ? null : {
                session_date: latest.session_date,
                mark_price: latest.values.mark_price,
                px_vs_sma50: latest.values.px_vs_sma50,
                cross_50_200: latest.values.cross_50_200,
                fetched_at: latest.values.fetched_at,
            },
            progress: tradeUnrealized === null ? null : {
                unrealized_pnl: tradeUnrealized,
                unrealized_r: tradeUnrealizedR,
            },
            warnings: warnings.length > 0 ? warnings : undefined,
        };
    });
}
export const handle = handler(build);
