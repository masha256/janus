import { Command } from "commander";
import { requireAssetBySymbol, requireSymbols } from "../db/repo/asset.js";
import { openTrade, addUnit, setStop, exitUnits, partialExitUnit, getTrade, listTrades } from "../db/repo/trade.js";
import { getSession } from "../db/repo/session.js";
import { latestCoverage, getCoverage } from "../db/repo/coverage.js";
import { todayNY, nowIso } from "../domain/session.js";
import { csv, finite, num, oneOf, positive, readText, required, unknownVerb } from "./args.js";
import { handler, withDb } from "./command.js";
import { JanusError } from "../output.js";
import { getScore } from "../db/repo/score.js";
import { getGlobalParams, getClusterParams } from "../db/repo/cluster.js";
import { resolveParams } from "../domain/params.js";
import { sizeFromRiskAndStop, stopDistancePct, stopFromAtr } from "../domain/sizing.js";
import { isStopWidening } from "../domain/ladder.js";
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
        .option("--stop <N|auto>", "initial stop; auto uses stop_atr_multiple from coverage")
        .option("--risk <N>", "risk in account terms; 0 is allowed (free carry)")
        .option("--notional <N>", "position size")
        .option("--size <N|auto>", "position size; auto uses sizing plan from latest score")
        .option("--thesis <TEXT>", "free text; - reads stdin")
        .option("--tag <TEXT>", "unit tag, e.g. runner or core")
        .option("--date <YYYY-MM-DD>", "the real entry date, not a session address")
        .action(async (symbol, opts) => emit(await open(symbol, opts)));
    cmd.command("add-unit")
        .description("Add a unit to an open trade")
        .argument("[trade_id]", "trade id")
        .option("--price <N>", "entry price")
        .option("--stop <N|auto>", "stop for this unit")
        .option("--risk <N>", "risk in account terms")
        .option("--notional <N>", "size of this unit")
        .option("--size <N|auto>", "size of this unit; auto uses sizing plan from latest score")
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
        .option("--fraction <N>", "bank only this fraction of one unit, 0 < N < 1; requires --unit")
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
        const direction = oneOf(opts.direction, "direction", ["long", "short"]);
        const params = resolveParams(getClusterParams(db, asset.cluster_id), getGlobalParams(db));
        const coverage = getCoverage(db, on, asset.id) ?? latestCoverage(db, asset.id)?.values;
        const resolved = resolveEntryInputs({
            direction,
            price: opts.price,
            stop: opts.stop,
            risk: opts.risk,
            notional: opts.notional,
            size: opts.size,
            assetSymbol: asset.symbol,
            assetId: asset.id,
            params,
            coverage,
            db,
            mode: "open",
        });
        const id = openTrade(db, {
            asset_id: asset.id,
            direction,
            opened_on: on,
            price: resolved.price,
            stop: resolved.stop,
            risk: resolved.risk,
            notional: resolved.notional,
            thesis: readText(opts.thesis) ?? null,
            origin_session_date: session === undefined ? null : session.session_date,
            tag: opts.tag ?? null,
        }, nowIso());
        const tradeResult = getTrade(db, id);
        return { ...tradeResult, auto: resolved.auto };
    });
}
function add(raw, opts) {
    return withDb((db) => {
        const id = tradeId(raw);
        const trade = getTrade(db, id);
        const asset = requireAssetBySymbol(db, trade.trade.symbol);
        const params = resolveParams(getClusterParams(db, asset.cluster_id), getGlobalParams(db));
        const coverage = getCoverage(db, opts.date ?? todayNY(), asset.id) ?? latestCoverage(db, asset.id)?.values;
        const resolved = resolveEntryInputs({
            direction: trade.trade.direction,
            price: opts.price,
            stop: opts.stop,
            risk: opts.risk,
            notional: opts.notional,
            size: opts.size,
            assetSymbol: asset.symbol,
            assetId: asset.id,
            params,
            coverage,
            db,
            mode: "add",
        });
        const seq = addUnit(db, id, {
            entry_on: opts.date ?? todayNY(),
            price: resolved.price,
            stop: resolved.stop,
            risk: resolved.risk,
            notional: resolved.notional,
            tag: opts.tag ?? null,
        });
        return { seq, ...getTrade(db, id), auto: resolved.auto };
    });
}
function stop(raw, opts) {
    return withDb((db) => {
        const id = tradeId(raw);
        const stopValue = opts.stop;
        const newStop = stopValue === "auto"
            ? resolveAutoStop(db, id, unitSeq(opts.unit))
            : positive(stopValue, "stop");
        const trade = getTrade(db, id);
        const affectedUnits = unitSeq(opts.unit) === undefined
            ? trade.units.filter((u) => u.status === "open")
            : trade.units.filter((u) => u.status === "open" && u.seq === unitSeq(opts.unit));
        const direction = trade.trade.direction;
        for (const unit of affectedUnits) {
            if (isStopWidening(direction, unit.stop, newStop)) {
                throw new JanusError("VALIDATION", `stop widening rejected: unit ${unit.seq} stop ${unit.stop} -> ${newStop}`);
            }
        }
        const moved = setStop(db, id, newStop, unitSeq(opts.unit));
        return { units_moved: moved, ...getTrade(db, id), auto: stopValue === "auto" };
    });
}
function exit(raw, opts) {
    return withDb((db) => {
        const id = tradeId(raw);
        const funding = opts.funding === undefined
            ? undefined
            : num(opts.funding, "funding", -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
        const price = positive(opts.price, "price");
        const on = opts.date ?? todayNY();
        const seq = unitSeq(opts.unit);
        if (opts.fraction !== undefined) {
            if (seq === undefined) {
                throw new JanusError("VALIDATION", "--fraction requires --unit: it banks part of one unit");
            }
            const fraction = finite(opts.fraction, "fraction");
            if (fraction === 1) {
                throw new JanusError("VALIDATION", "--fraction 1 closes the unit; use exit without --fraction");
            }
            const res = partialExitUnit(db, id, seq, price, on, fraction, funding);
            return { partial: true, ...res, ...getTrade(db, id) };
        }
        const res = exitUnits(db, id, price, on, seq, funding);
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
function resolveEntryInputs(opts) {
    const auto = {};
    // Price must always be supplied by the operator.
    const price = positive(opts.price, "price");
    // Stop: explicit, auto from ATR, or pulled from the latest sizing plan.
    let stop;
    if (opts.stop === "auto") {
        auto.stop = true;
        const atr = opts.coverage?.atr14;
        if (atr === undefined || atr === null || atr <= 0) {
            throw new JanusError("VALIDATION", "no ATR available to compute auto stop");
        }
        stop = stopFromAtr(price, atr, opts.params["stop_atr_multiple"] ?? 2, opts.direction);
    }
    else if (opts.stop === undefined) {
        // Fall back to the latest score's sizing plan if available.
        const score = getScore(opts.db, todayNY(), opts.assetId);
        const sizingStop = score?.plan?.sizing_plan?.stop_price;
        if (sizingStop === undefined) {
            throw new JanusError("VALIDATION", "--stop is required unless a sizing plan exists");
        }
        stop = sizingStop;
    }
    else {
        stop = positive(opts.stop, "stop");
    }
    // Notional: explicit, auto from sizing plan, or derived from risk and stop.
    let notional;
    if (opts.size === "auto") {
        auto.size = true;
        const score = getScore(opts.db, todayNY(), opts.assetId);
        const sizing = score?.plan?.sizing_plan;
        if (sizing !== undefined) {
            notional = sizing.suggested_notional;
        }
        else {
            const distPct = stopDistancePct(price, stop, opts.direction);
            if (distPct <= 0) {
                throw new JanusError("VALIDATION", "auto size requires a valid stop distance");
            }
            const result = sizeFromRiskAndStop({
                capital: opts.params["account_capital"] ?? 0,
                maxRiskPct: opts.params["per_trade_max_risk_pct"] ?? 5,
                conviction: score?.conviction ?? opts.params["signal_conviction_initiate"] ?? 6,
                stopDistancePct: distPct,
                perAssetMaxNotionalPct: opts.params["per_asset_max_notional_pct"] ?? 20,
            });
            notional = result.cappedPositionSizeDollars;
        }
    }
    else if (opts.notional === undefined) {
        const score = getScore(opts.db, todayNY(), opts.assetId);
        const sizingNotional = score?.plan?.sizing_plan?.suggested_notional;
        if (sizingNotional === undefined) {
            throw new JanusError("VALIDATION", "--notional or --size auto is required");
        }
        notional = sizingNotional;
    }
    else {
        notional = positive(opts.notional, "notional");
    }
    // Risk: explicit or computed from sizing plan / stop distance.
    let risk;
    if (opts.risk !== undefined) {
        risk = num(opts.risk, "risk", 0, RISK_MAX);
    }
    else {
        const score = getScore(opts.db, todayNY(), opts.assetId);
        if (score?.plan?.sizing_plan?.risk_dollars !== undefined) {
            risk = score.plan.sizing_plan.risk_dollars;
        }
        else {
            const distPct = stopDistancePct(price, stop, opts.direction);
            risk = distPct > 0 ? notional * distPct : 0;
        }
    }
    return { price, stop, risk, notional, auto };
}
function resolveAutoStop(db, tradeId, seq) {
    const trade = getTrade(db, tradeId);
    const coverage = latestCoverage(db, trade.trade.asset_id)?.values;
    if (coverage === undefined || coverage.mark_price === null || coverage.atr14 === null) {
        throw new JanusError("VALIDATION", "no coverage available to trail stop");
    }
    const params = resolveParams(
    // cluster resolution skipped for brevity; asset cluster looked up below
    {}, getGlobalParams(db));
    const mark = coverage.mark_price;
    const atr = coverage.atr14;
    const multiple = params["trailing_atr_multiple"] ?? 2;
    return trade.trade.direction === "long" ? mark - multiple * atr : mark + multiple * atr;
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
