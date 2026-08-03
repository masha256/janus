import { num } from "./metrics.js";
const boolParam = (params, key) => (params[key] ?? 0) !== 0;
export function signalGate(strength, conviction, position, params) {
    const absStrength = Math.abs(strength);
    const side = strength > 0 ? "long" : strength < 0 ? "short" : null;
    const strengthInitiate = params["signal_strength_initiate"] ?? 1.0;
    const convInitiate = params["signal_conviction_initiate"] ?? 6;
    const strengthAdd = params["signal_strength_add"] ?? 1.0;
    const convAdd = params["signal_conviction_add"] ?? 7;
    const strengthExit = params["signal_strength_exit"] ?? 1.0;
    const convHold = params["conv_hold"] ?? 4;
    const aligned = position.side !== null && side === position.side;
    const misaligned = position.side !== null && side !== null && !aligned;
    if (side === null)
        return "fail";
    if (position.side === null) {
        return absStrength >= strengthInitiate && conviction >= convInitiate ? "pass" : "fail";
    }
    if (misaligned) {
        return absStrength >= strengthExit && conviction >= convHold ? "pass" : "fail";
    }
    // Aligned: pass if either add thresholds are met (so ADD can be considered) or
    // at least hold-quality signal is present (so HOLD is not treated as a failure).
    return absStrength >= strengthAdd && conviction >= convAdd ? "pass" : "fail";
}
export function persistenceGate(strength, conviction, side, recentScores, params) {
    const required = Math.max(1, Math.round(params["signal_persist_days"] ?? 1));
    if (recentScores.length < required - 1) {
        // Need at least N-1 prior scores plus today. For N=1 no prior scores needed.
        return required === 1 ? "pass" : "insufficient_history";
    }
    const strengthInitiate = params["signal_strength_initiate"] ?? 1.0;
    const convInitiate = params["signal_conviction_initiate"] ?? 6;
    // Walk backwards through recent scores (newest first). Count consecutive days
    // where the same-side signal would have passed the initiate threshold.
    let count = 1; // today counts once signalGate already passed
    for (const score of recentScores) {
        const sameSide = side === null
            ? false
            : (side === "long" && score.strength > 0) || (side === "short" && score.strength < 0);
        const absStrength = Math.abs(score.strength);
        if (sameSide && absStrength >= strengthInitiate && score.conviction >= convInitiate) {
            count++;
        }
        else {
            break;
        }
    }
    return count >= required ? "pass" : "fail";
}
export function trendGate(side, coverage, crowding, params) {
    if (coverage === null || side === null)
        return "fail";
    const pxVs20 = coverage.px_vs_sma20;
    const pxVs50 = coverage.px_vs_sma50;
    const pxVs200 = coverage.px_vs_sma200;
    const cross50_200 = coverage.cross_50_200;
    const crossPx50 = coverage.cross_px_50;
    const c20Long = params["trend_sma20_cushion_long"] ?? 0;
    const c20Short = params["trend_sma20_cushion_short"] ?? 0;
    const c50Long = params["trend_sma50_cushion_long"] ?? 1.0;
    const c50Short = params["trend_sma50_cushion_short"] ?? -1.0;
    const requireGolden = boolParam(params, "require_golden_for_long");
    const requireDeath = boolParam(params, "require_death_for_short");
    const lateDist = params["late_trend_ma_distance"] ?? 20;
    const lateCrowd = params["late_trend_crowding_extreme"] ?? 85;
    if (side === "long") {
        if (crossPx50 !== "above")
            return "fail";
        if (requireGolden && cross50_200 === "death")
            return "fail";
        if (pxVs50 === null || pxVs50 < c50Long)
            return "fail";
        if (pxVs20 === null || pxVs20 < c20Long)
            return "fail";
        const extended = pxVs200 !== null && pxVs200 >= lateDist && crowding >= lateCrowd;
        return extended ? "late_trend" : "pass";
    }
    if (side === "short") {
        if (crossPx50 !== "below")
            return "fail";
        if (requireDeath && cross50_200 === "golden")
            return "fail";
        if (pxVs50 === null || pxVs50 > c50Short)
            return "fail";
        if (pxVs20 === null || pxVs20 > c20Short)
            return "fail";
        const extended = pxVs200 !== null && pxVs200 <= -lateDist && crowding >= lateCrowd;
        return extended ? "late_trend" : "pass";
    }
    return "fail";
}
export function binaryGate(sessionDate, binary, params) {
    if (binary === null || binary.date === null)
        return "pass";
    const cooldown = Math.max(0, params["binary_cooldown_days"] ?? 14);
    if (cooldown === 0)
        return "pass";
    const days = daysBetween(binary.date, sessionDate);
    return days !== null && days >= 0 && days < cooldown ? "blocked" : "pass";
}
export function heatGate(params) {
    // Stubbed until sizing is built. The param account_capital is accepted so
    // clusters can declare capital, but no blocking logic runs yet.
    void params["account_capital"];
    return "pass";
}
export function flipflopGate(side, sessionDate, lastExit, persistence, params) {
    if (side === null || lastExit === null)
        return "n/a";
    const cooldown = Math.max(0, params["flipflop_cooldown_days"] ?? 5);
    if (cooldown === 0 || lastExit.side === side)
        return "n/a";
    const days = daysBetween(lastExit.session_date, sessionDate);
    if (days === null || days < 0 || days >= cooldown)
        return "n/a";
    // persistenceGate already computed the run-day persistence for the proposed side.
    const persistOk = persistence === "pass";
    return persistOk ? "pass" : "blocked";
}
export function regimeTriggerState(regimeSmile, params) {
    const longMax = params["regime_trigger_long_max"] ?? 1.5;
    const shortMin = params["regime_trigger_short_min"] ?? -1.5;
    if (regimeSmile >= longMax)
        return "extreme_bull";
    if (regimeSmile <= shortMin)
        return "extreme_bear";
    return "none";
}
export function actionableNewSignal(strength, catalyst, context, previousScore, params) {
    const catalystMin = params["actionable_catalyst_min"] ?? 1.5;
    const strengthDelta = params["actionable_strength_delta"] ?? 1.0;
    if (context.screen?.metrics["capitulation"] ?? false)
        return true;
    if (context.screen?.metrics["divergence"] ?? false)
        return true;
    if (Math.abs(catalyst) >= catalystMin)
        return true;
    if (Math.abs(strength - previousScore.strength) >= strengthDelta)
        return true;
    return false;
}
/** Days between two ISO date strings (a - b), or null if either is invalid. */
function daysBetween(a, b) {
    const ad = Date.parse(a + "T00:00:00Z");
    const bd = Date.parse(b + "T00:00:00Z");
    if (Number.isNaN(ad) || Number.isNaN(bd))
        return null;
    return Math.round((ad - bd) / 86_400_000);
}
export function runGates(strength, conviction, position, metrics, ctx) {
    const side = strength > 0 ? "long" : strength < 0 ? "short" : null;
    const crowding = num(metrics, "crowding", 50);
    const signal = signalGate(strength, conviction, position, ctx.params);
    const persistence = persistenceGate(strength, conviction, side, ctx.recentScores, ctx.params);
    const trend = trendGate(side, ctx.coverage, crowding, ctx.params);
    const binary = binaryGate(ctx.sessionDate, ctx.binary, ctx.params);
    const heat = heatGate(ctx.params);
    const flipflop = flipflopGate(side, ctx.sessionDate, ctx.lastExit, persistence, ctx.params);
    return { signal, persistence, trend, binary, heat, flipflop };
}
