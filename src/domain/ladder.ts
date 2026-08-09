import type { CoverageValues } from "./coverage.ts";
import type { UnitRow } from "./trade-math.ts";

export type LadderEvent =
  | "entry"
  | "breakeven"
  | "partial"
  | "runner"
  | "tighten"
  | "time_stop"
  | "decay_exit";

export type LadderPlan = {
  event: LadderEvent;
  action: "hold" | "move_to_breakeven" | "trail" | "tighten" | "time_exit" | "decay_exit";
  affected_units: "all" | "oldest" | "newest" | "partial_target" | string;
  new_stop?: number;
  trim_fraction?: number;
  rationale: string;
};

type LadderInputs = {
  direction: "long" | "short";
  units: UnitRow[];
  entryPrice: number;
  initialRisk: number;
  coverage: CoverageValues | null;
  openedOn: string;
  today: string;
  addWindowOpen: boolean;
  lateTrend: boolean;
  decaySignal: boolean;
  params: Record<string, number>;
};

export function deriveLadderPlan(inputs: LadderInputs): LadderPlan {
  const {
    direction,
    units,
    entryPrice,
    initialRisk,
    coverage,
    openedOn,
    today,
    addWindowOpen,
    lateTrend,
    decaySignal,
    params,
  } = inputs;

  const sign = direction === "long" ? 1 : -1;
  const mark = coverage?.mark_price ?? null;
  const atr = coverage?.atr14 ?? null;
  const breakevenR = params["breakeven_trigger_r"] ?? 1;
  const partialR = params["partial_trigger_r"] ?? 1.5;
  const partialFraction = params["partial_exit_fraction"] ?? 0.5;
  const trailingMultiple = params["trailing_atr_multiple"] ?? 2;
  const timeStopDays = params["max_time_stop_days"] ?? 42;

  const openUnits = units.filter((u) => u.status === "open");
  const closedUnits = units.filter((u) => u.status === "closed");

  // Unrealized R across the whole trade, if we have a mark price. Each unit is
  // marked against its own cost basis — a later add bought higher has not made
  // the delta from the trade's first entry price.
  const unrealizedR = (() => {
    if (mark === null || initialRisk === 0) return null;
    const pnl = openUnits.reduce(
      (a, u) => a + (u.notional / u.entry_price) * (mark - u.entry_price) * sign,
      0,
    );
    return pnl / Math.abs(initialRisk);
  })();

  const anyBreakevenOrBetter = openUnits.some((u) => (u.stop - u.entry_price) * sign >= 0);

  // Time stop: the thesis never worked. It only applies while the position is
  // still fully at risk — a unit at breakeven or a trade past its +1R milestone
  // is a winner being managed by the trail, and a clock must not exit it.
  // openedOn is earlier, today is later, so compute (today - openedOn).
  const daysOpen = daysBetween(today, openedOn);
  const neverWorked = !anyBreakevenOrBetter && (unrealizedR === null || unrealizedR < breakevenR);
  const timeStopHit = daysOpen !== null && daysOpen >= timeStopDays && neverWorked;
  if (timeStopHit) {
    return {
      event: "time_stop",
      action: "time_exit",
      affected_units: "all",
      rationale: `position open ${daysOpen} days without earning breakeven, time stop reached`,
    };
  }

  // Signal decay exit logic.
  // Pre-breakeven: any decay signal exits immediately.
  // Post-breakeven: require two consecutive run-days of confirmation.
  if (decaySignal) {
    if (!anyBreakevenOrBetter) {
      return {
        event: "decay_exit",
        action: "decay_exit",
        affected_units: "all",
        rationale: "pre-breakeven signal decay: full position still exposed",
      };
    }
    return {
      event: "decay_exit",
      action: "decay_exit",
      affected_units: "all",
      rationale: "post-breakeven signal decay confirmed over two run-days",
    };
  }

  // No open units left after prior exits.
  if (openUnits.length === 0) {
    return {
      event: "runner",
      action: "hold",
      affected_units: "all",
      rationale: "no open units remain",
    };
  }

  // +1R: move oldest unit to breakeven before classifying entry, because a
  // position that has already reached +1R is no longer in the initial entry
  // state even if it only has one unit.
  if (unrealizedR !== null && unrealizedR >= breakevenR) {
    const oldest = openUnits[0];
    if (oldest && (oldest.stop - oldest.entry_price) * sign < 0) {
      return {
        event: "breakeven",
        action: "move_to_breakeven",
        affected_units: "oldest",
        new_stop: oldest.entry_price,
        rationale: `unrealized R ${unrealizedR.toFixed(2)} reached +1R; lock oldest unit`,
      };
    }
  }

  // Entry phase: initial stop already set by the operator.
  // A single open unit with no prior exits is entry only if it is still at risk
  // and has not already hit a higher ladder milestone.
  const isEntry = closedUnits.length === 0 && openUnits.length === 1 &&
    (openUnits[0]!.stop - openUnits[0]!.entry_price) * sign < 0;
  if (isEntry) {
    return {
      event: "entry",
      action: "hold",
      affected_units: "all",
      rationale: "initial stop set at entry; full 1R at risk",
    };
  }

  // +1.5R: take partial profit and open add window.
  if (unrealizedR !== null && unrealizedR >= partialR && !addWindowOpen) {
    const newest = openUnits[openUnits.length - 1];
    if (newest && !newest.partial_exited) {
      return {
        event: "partial",
        action: "trail",
        affected_units: "newest",
        trim_fraction: partialFraction,
        rationale: `unrealized R ${unrealizedR.toFixed(2)} reached +1.5R; bank partial and open add window`,
      };
    }
  }

  // Runner / late-trend trailing stop.
  //
  // An ATR trail depends only on mark and ATR, never on where a unit was
  // entered, so one price is the correct trail for every open unit at once.
  // The only question is whether it would widen the tightest of them: if so we
  // advise nothing, because clamping to that tightest stop instead would drag
  // every looser unit up with it and strangle a runner the ladder is trying to
  // let breathe.
  if (addWindowOpen && atr !== null && mark !== null) {
    const newStop = proposeTrailingStop(direction, mark, atr, entryPrice, trailingMultiple);
    const tightest = openUnits.reduce(
      (a, u) => (direction === "long" ? Math.max(a, u.stop) : Math.min(a, u.stop)),
      direction === "long" ? -Infinity : Infinity,
    );
    if (isStopWidening(direction, tightest, newStop)) {
      return {
        event: "runner",
        action: "hold",
        affected_units: "all",
        rationale: "trailing stop would widen the tightest unit; hold",
      };
    }
    return {
      event: lateTrend ? "tighten" : "runner",
      action: lateTrend ? "tighten" : "trail",
      affected_units: "all",
      new_stop: newStop,
      rationale: lateTrend
        ? "late-trend caution: tighten trailing stop"
        : "runner phase: trail stop behind price",
    };
  }

  return {
    event: "runner",
    action: "hold",
    affected_units: "all",
    rationale: "ladder waiting for next milestone",
  };
}

/** Days between two ISO date strings (b -> a), or null if either is invalid. */
function daysBetween(a: string, b: string): number | null {
  const ad = Date.parse(a + "T00:00:00Z");
  const bd = Date.parse(b + "T00:00:00Z");
  if (Number.isNaN(ad) || Number.isNaN(bd)) return null;
  return Math.round((ad - bd) / 86_400_000);
}

/**
 * True if moving a unit stop from old to new would widen the risk.
 * For longs, new stop must be >= old stop to not widen.
 * For shorts, new stop must be <= old stop to not widen.
 */
export function isStopWidening(
  direction: "long" | "short",
  oldStop: number,
  newStop: number,
): boolean {
  return direction === "long" ? newStop < oldStop : newStop > oldStop;
}

/**
 * Propose an ATR-based trailing stop that is never wider than the current stop.
 */
export function proposeTrailingStop(
  direction: "long" | "short",
  mark: number,
  atr: number,
  currentStop: number,
  multiple: number,
): number {
  const sign = direction === "long" ? 1 : -1;
  const candidate = mark - sign * atr * multiple;
  return direction === "long"
    ? Math.max(candidate, currentStop)
    : Math.min(candidate, currentStop);
}
