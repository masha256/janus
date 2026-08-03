export function deriveLadderPlan(inputs) {
    const { direction, units, entryPrice, initialRisk, coverage, openedOn, today, addWindowOpen, lateTrend, decaySignal, params, } = inputs;
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
    // Unrealized R across the whole trade, if we have a mark price.
    const unrealizedR = (() => {
        if (mark === null || initialRisk === 0)
            return null;
        const size = openUnits.reduce((a, u) => a + u.notional / u.entry_price, 0);
        const pnl = size * (mark - entryPrice) * sign;
        return pnl / Math.abs(initialRisk);
    })();
    // Time stop: position open too long without reaching target.
    // openedOn is earlier, today is later, so compute (today - openedOn).
    const daysOpen = daysBetween(today, openedOn);
    const timeStopHit = daysOpen !== null && daysOpen >= timeStopDays;
    if (timeStopHit) {
        return {
            event: "time_stop",
            action: "time_exit",
            affected_units: "all",
            rationale: `position open ${daysOpen} days, time stop reached`,
        };
    }
    // Signal decay exit logic.
    // Pre-breakeven: any decay signal exits immediately.
    // Post-breakeven: require two consecutive run-days of confirmation.
    const anyBreakevenOrBetter = openUnits.some((u) => (u.stop - u.entry_price) * sign >= 0);
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
        (openUnits[0].stop - openUnits[0].entry_price) * sign < 0;
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
    if (addWindowOpen && atr !== null && mark !== null) {
        const rawStop = mark - trailingMultiple * atr * sign;
        const newStop = direction === "long" ? Math.max(rawStop, entryPrice) : Math.min(rawStop, entryPrice);
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
function daysBetween(a, b) {
    const ad = Date.parse(a + "T00:00:00Z");
    const bd = Date.parse(b + "T00:00:00Z");
    if (Number.isNaN(ad) || Number.isNaN(bd))
        return null;
    return Math.round((ad - bd) / 86_400_000);
}
/**
 * True if moving a unit stop from old to new would widen the risk.
 * For longs, new stop must be >= old stop to not widen.
 * For shorts, new stop must be <= old stop to not widen.
 */
export function isStopWidening(direction, oldStop, newStop) {
    return direction === "long" ? newStop < oldStop : newStop > oldStop;
}
/**
 * Propose an ATR-based trailing stop that is never wider than the current stop.
 */
export function proposeTrailingStop(direction, mark, atr, currentStop, multiple) {
    const sign = direction === "long" ? 1 : -1;
    const candidate = mark - sign * atr * multiple;
    return direction === "long"
        ? Math.max(candidate, currentStop)
        : Math.min(candidate, currentStop);
}
