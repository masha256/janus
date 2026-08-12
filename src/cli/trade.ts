import { Command } from "commander";
import { requireAssetBySymbol, requireSymbols } from "../db/repo/asset.ts";
import { openTrade, addUnit, setStop, exitUnits, partialExitUnit, editTrade, getTrade, listTrades } from "../db/repo/trade.ts";
import { getSession } from "../db/repo/session.ts";
import { latestCoverage } from "../db/repo/coverage.ts";
import { todayNY, nowIso } from "../domain/session.ts";
import { csv, finite, metricPairs, num, oneOf, positive, readText, required, unknownVerb } from "./args.ts";
import { collect, type Emit, handler, withDb } from "./command.ts";
import { JanusError } from "../output.ts";
import { getScore } from "../db/repo/score.ts";
import { getGlobalParams, getClusterParams } from "../db/repo/cluster.ts";
import { resolveParams } from "../domain/params.ts";
import { sizeFromRiskAndStop, stopDistancePct, stopFromAtr } from "../domain/sizing.ts";
import { isStopWidening, proposeTrailingStop } from "../domain/ladder.ts";
import type { UnitRow } from "../domain/trade-math.ts";

const VERBS = "open, add-unit, set-stop, exit, edit, list, show";

// Risk may legitimately be 0 once a stop has been moved past entry (free carry).
const RISK_MAX = Number.MAX_SAFE_INTEGER;

// `--date` on trade is the real entry or exit date of a unit, not a session address.
type OpenOpts = {
  direction?: string; price?: string; stop?: string; risk?: string;
  notional?: string; size?: string; thesis?: string; date?: string; tag?: string;
};
type UnitOpts = { price?: string; stop?: string; risk?: string; notional?: string; size?: string; date?: string; tag?: string };
type StopOpts = { stop?: string; unit?: string };
type ExitOpts = { price?: string; unit?: string; date?: string; funding?: string; fraction?: string };
type EditOpts = { unit?: string; set?: string[] };

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
    .option("--stop <N|auto>", "initial stop; auto uses stop_atr_multiple from coverage")
    .option("--risk <N>", "risk in account terms; 0 is allowed (free carry)")
    .option("--notional <N>", "position size")
    .option("--size <N|auto>", "position size; auto uses sizing plan from latest score")
    .option("--thesis <TEXT>", "free text; - reads stdin")
    .option("--tag <TEXT>", "unit tag, e.g. runner or core")
    .option("--date <YYYY-MM-DD>", "the real entry date, not a session address")
    .action(async (symbol: string | undefined, opts: OpenOpts) => emit(await open(symbol, opts)));

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
    .option("--fraction <N>", "bank only this fraction of one unit, 0 < N < 1; requires --unit")
    .action(async (id: string | undefined, opts: ExitOpts) => emit(await exit(id, opts)));

  cmd.command("edit")
    .description("Correct a mistyped field on a trade, or on one unit with --unit")
    .argument("[trade_id]", "trade id")
    .option("--unit <SEQ>", "correct this unit instead of the trade itself")
    .option("--set <KEY=VALUE>", "field to correct; repeatable", collect)
    .action(async (id: string | undefined, opts: EditOpts) => emit(await edit(id, opts)));

  cmd.command("list")
    .description("List trades")
    .option("--open", "only open trades")
    .option("--closed", "only closed trades")
    .option("--asset <SYM[,SYM...]>", "restrict to these symbols")
    .action(async (opts: { open?: boolean; closed?: boolean; asset?: string }) => emit(await list(opts)));

  cmd.command("show")
    .description("One trade with its units, summary, and current coverage progress")
    .argument("[trade_id]", "trade id")
    .option("--date <YYYY-MM-DD>", "coverage reference date; defaults to today, New York")
    .action(async (id: string | undefined, opts: { date?: string }) => emit(await show(id, opts.date)));

  return cmd;
}

function open(symbol: string | undefined, opts: OpenOpts): Promise<unknown> {
  return withDb((db) => {
    const on = opts.date ?? todayNY();
    const asset = requireAssetBySymbol(db, required(symbol, "symbol").toUpperCase());
    const session = getSession(db, on);
    const direction = oneOf(opts.direction, "direction", ["long", "short"] as const);
    const params = resolveParams(getClusterParams(db, asset.cluster_id), getGlobalParams(db));
    const coverage = latestCoverage(db, asset.id, on)?.values;

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
      on,
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
    return { ...(tradeResult as object), auto: resolved.auto };
  });
}

function add(raw: string | undefined, opts: UnitOpts): Promise<unknown> {
  return withDb((db) => {
    const id = tradeId(raw);
    const trade = getTrade(db, id) as {
      trade: { asset_id: number; direction: "long" | "short"; symbol: string };
    };
    const asset = requireAssetBySymbol(db, trade.trade.symbol);
    const params = resolveParams(getClusterParams(db, asset.cluster_id), getGlobalParams(db));
    const on = opts.date ?? todayNY();
    const coverage = latestCoverage(db, asset.id, on)?.values;

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
      on,
      mode: "add",
    });

    const seq = addUnit(db, id, {
      entry_on: on,
      price: resolved.price,
      stop: resolved.stop,
      risk: resolved.risk,
      notional: resolved.notional,
      tag: opts.tag ?? null,
    });
    return { seq, ...(getTrade(db, id) as object), auto: resolved.auto };
  });
}

function stop(raw: string | undefined, opts: StopOpts): Promise<unknown> {
  return withDb((db) => {
    const id = tradeId(raw);
    const stopValue = opts.stop;
    const newStop = stopValue === "auto"
      ? resolveAutoStop(db, id, unitSeq(opts.unit))
      : positive(stopValue, "stop");
    const trade = getTrade(db, id) as {
      trade: { direction: "long" | "short" };
      units: UnitRow[];
    };
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
    return { units_moved: moved, ...(getTrade(db, id) as object), auto: stopValue === "auto" };
  });
}

function exit(raw: string | undefined, opts: ExitOpts): Promise<unknown> {
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
      return { partial: true, ...res, ...(getTrade(db, id) as object) };
    }

    const res = exitUnits(db, id, price, on, seq, funding);
    return { ...res, ...(getTrade(db, id) as object) };
  });
}

function edit(raw: string | undefined, opts: EditOpts): Promise<unknown> {
  return withDb((db) => {
    const id = tradeId(raw);
    // Unlike exit and set-stop, a bare `edit` means the trade row itself, not
    // "every unit": correcting one typo across all units is never the intent.
    const res = editTrade(db, id, unitSeq(opts.unit), metricPairs(opts.set, "set"));
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

type EntryMode = "open" | "add";

type EntryResolution = {
  price: number;
  stop: number;
  risk: number;
  notional: number;
  auto: { size?: boolean; stop?: boolean };
};

function resolveEntryInputs(opts: {
  direction: "long" | "short";
  price?: string;
  stop?: string;
  risk?: string;
  notional?: string;
  size?: string;
  assetSymbol: string;
  assetId: number;
  params: Record<string, number>;
  coverage: import("../domain/coverage.ts").CoverageValues | null | undefined;
  db: import("node:sqlite").DatabaseSync;
  /** Entry date: the session whose score carries the plan for this entry. */
  on: string;
  mode: EntryMode;
}): EntryResolution {
  const auto: EntryResolution["auto"] = {};
  // The score to size against is the one for the entry date, not today's. A
  // backdated entry that read today's score would silently fall through to the
  // no-plan path and size itself off the raw stop distance instead.
  const score = getScore(opts.db, opts.on, opts.assetId);
  const sizing = score?.plan?.sizing_plan;

  // Price must always be supplied by the operator.
  const price = positive(opts.price, "price");

  // Stop: explicit, auto from ATR, or pulled from the latest sizing plan.
  let stop: number;
  if (opts.stop === "auto") {
    auto.stop = true;
    const atr = opts.coverage?.atr14;
    if (atr === undefined || atr === null || atr <= 0) {
      throw new JanusError("VALIDATION", "no ATR available to compute auto stop");
    }
    stop = stopFromAtr(price, atr, opts.params["stop_atr_multiple"] ?? 2, opts.direction);
  } else if (opts.stop === undefined) {
    // Fall back to the entry date's sizing plan if available.
    if (sizing?.stop_price === undefined) {
      throw new JanusError("VALIDATION", "--stop is required unless a sizing plan exists");
    }
    stop = sizing.stop_price;
  } else {
    stop = positive(opts.stop, "stop");
  }

  // Notional: explicit, auto from sizing plan, or derived from risk and stop.
  let notional: number;
  if (opts.size === "auto") {
    auto.size = true;
    if (sizing !== undefined) {
      notional = sizing.suggested_notional;
    } else {
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
  } else if (opts.notional === undefined) {
    if (sizing?.suggested_notional === undefined) {
      throw new JanusError("VALIDATION", "--notional or --size auto is required");
    }
    notional = sizing.suggested_notional;
  } else {
    notional = positive(opts.notional, "notional");
  }

  // Risk: explicit, else derived from the size and stop actually being used.
  // Not read off the plan — an overridden --notional or --stop would leave the
  // plan's risk_dollars describing a position nobody opened, and initial_risk is
  // what every R milestone in the ladder is measured against.
  let risk: number;
  if (opts.risk !== undefined) {
    risk = num(opts.risk, "risk", 0, RISK_MAX);
  } else {
    const distPct = stopDistancePct(price, stop, opts.direction);
    risk = distPct > 0 ? notional * distPct : 0;
  }

  return { price, stop, risk, notional, auto };
}

function resolveAutoStop(
  db: import("node:sqlite").DatabaseSync,
  tradeId: number,
  seq?: number,
): number {
  const trade = getTrade(db, tradeId) as {
    trade: { asset_id: number; direction: "long" | "short"; symbol: string };
    units: UnitRow[];
  };
  const coverage = latestCoverage(db, trade.trade.asset_id)?.values;
  if (coverage === undefined || coverage.mark_price === null || coverage.atr14 === null) {
    throw new JanusError("VALIDATION", "no coverage available to trail stop");
  }
  const asset = requireAssetBySymbol(db, trade.trade.symbol);
  const params = resolveParams(getClusterParams(db, asset.cluster_id), getGlobalParams(db));
  const direction = trade.trade.direction;

  const affected = trade.units.filter(
    (u) => u.status === "open" && (seq === undefined || u.seq === seq),
  );
  if (affected.length === 0) {
    throw new JanusError("VALIDATION", `no open unit to trail on trade ${tradeId}`);
  }

  // One stop lands on every affected unit, so ratchet against the tightest of
  // them. Without this the raw ATR trail moves backwards on a pullback and the
  // widening guard below rejects the very stop this function just proposed.
  const floor = affected.reduce(
    (a, u) => (direction === "long" ? Math.max(a, u.stop) : Math.min(a, u.stop)),
    direction === "long" ? -Infinity : Infinity,
  );
  return proposeTrailingStop(
    direction,
    coverage.mark_price,
    coverage.atr14,
    floor,
    params["trailing_atr_multiple"] ?? 2,
  );
}

function show(raw: string | undefined, date?: string): Promise<unknown> {
  return withDb((db) => {
    const id = tradeId(raw);
    const base = getTrade(db, id) as {
      trade: { asset_id: number; direction: "long" | "short"; initial_risk: number; status: string };
      units: import("../domain/trade-math.ts").UnitRow[];
      summary: import("../domain/trade-math.ts").TradeSummary;
    };

    // As-of, not newest: `--date` asks what this trade looked like on that day,
    // so marking it against a later row would answer a different question.
    const today = date ?? todayNY();
    const latest = latestCoverage(db, base.trade.asset_id, today);
    const stale = latest === null || latest.session_date < today;
    const warnings: string[] = [];
    if (latest === null) {
      warnings.push("no coverage data found for this asset; run coverage first");
    } else if (stale) {
      warnings.push(`coverage is stale: latest ${latest.session_date}, today ${today}`);
    }

    const markPrice = latest?.values.mark_price ?? null;
    const sign = base.trade.direction === "long" ? 1 : -1;
    const enrichedUnits = base.units.map((u) => {
      if (u.status !== "open" || markPrice === null) return u;
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
