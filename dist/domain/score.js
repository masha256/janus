import { JanusError } from "../output.js";
import { num, requireNum } from "./metrics.js";
import { actionableNewSignal, regimeTriggerState, runGates } from "./gates.js";
import { sizeFromRiskAndStop, stopDistancePct, stopFromAtr } from "./sizing.js";
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const boolParam = (params, key) => (params[key] ?? 0) !== 0;
/**
 * In-file floors for params the resolution chain did not supply. The chain is
 * cluster_param → global_param → domain/params.ts DEFAULT_PARAMS, so these
 * only bind when neither the deployment nor the defaults were changed —
 * they are the last resort, not the source of tuning: real defaults live in
 * DEFAULT_PARAMS and are what tests pin.
 */
const FEAR_PREMIUM_FALLBACK = 1.25;
const DIVERGENCE_BOOST_FALLBACK = 0.5;
const WEIGHT_FALLBACK = 0;
/**
 * deriveScore turns the agent's scoring metrics into a direction and conviction.
 *
 * Inputs:
 *   catalyst     -2..+2  fresh project-specific news + social velocity (momentum)
 *   trend        -2..+2  trend/flow conviction
 *   secular      -2..+2  longer-horizon thesis
 *   crowding     1..100  aggregate positioning/crowding (contrarian)
 *   capitulation true/false
 *   divergence   true/false
 *   confidence   0..1    agent-supplied quality; missing = 0 (no information)
 *
 * Sentiment is derived from crowding with a divergence booster and a
 * deliberate long-side premium: panic is faded harder than greed is.
 * Direction is the weighted mean of catalyst, sentiment, trend, the session's
 * regime_smile, and secular, normalised by the total |weight| so retuning a
 * weight re-scales conviction rather than the raw score itself, then clamped
 * to [-2, 2].
 * Conviction fuses direction magnitude, factor agreement, and the agent's
 * confidence: 1 + 9 * (|D|/2)^0.8 * agree^0.3 * Q^0.2. Direction is how
 * bullish/bearish; conviction is strength × agreement across factors × data
 * quality, so mixed signals score low conviction even when net-positive.
 *
 * The directive ladder then turns strength, conviction, the current position,
 * the trend/MA hard gate, and an optional regime extreme-contrarian trigger
 * into INITIATE/ADD/HOLD/TRIM/EXIT/STAND_ASIDE, with a persistence rule that
 * makes HOLD the default and resists flip-flopping.
 */
export function deriveScore(metrics, context, params) {
    const catalyst = requireFactor(metrics, "catalyst");
    const trend = requireFactor(metrics, "trend");
    const secular = requireFactor(metrics, "secular");
    const crowding = requireCrowding(metrics);
    const capitulation = Boolean(metrics["capitulation"]);
    const divergence = Boolean(metrics["divergence"]);
    // Confidence is the agent's own 0..1 quality on this read. Absent means
    // "no information" (0), not "inherit the screen's": the screen's confidence
    // judged a different question.
    const confidence = clamp(num(metrics, "confidence", 0), 0, 1);
    const fearPremium = params["fear_premium"] ?? FEAR_PREMIUM_FALLBACK;
    const divergenceBoost = params["divergence_boost"] ?? DIVERGENCE_BOOST_FALLBACK;
    const { sentiment, summary } = sentimentFromCrowding(crowding, trend, capitulation, divergence, fearPremium, divergenceBoost);
    const screen = context.screen;
    if (screen === null) {
        throw new JanusError("PHASE_ORDER", "screen must be recorded before scoring");
    }
    const regime = requireNum(screen.results, "regime", -2, 2);
    const regimeSmile = requireNum(screen.results, "regime_smile", -2, 2);
    const wCat = params["w_catalyst"] ?? WEIGHT_FALLBACK;
    const wSent = params["w_sentiment"] ?? WEIGHT_FALLBACK;
    const wTrend = params["w_trend"] ?? WEIGHT_FALLBACK;
    const wRegime = params["w_regime"] ?? WEIGHT_FALLBACK;
    const wSecular = params["w_secular"] ?? WEIGHT_FALLBACK;
    // Weighted mean, normalised by total |weight| so a retune rescales the
    // score's sensitivity rather than its absolute magnitude, keeping every
    // downstream threshold (screen_threshold, strength_initiate...) comparable.
    const contributions = [
        { key: "catalyst", weight: wCat, value: catalyst },
        { key: "sentiment", weight: wSent, value: sentiment },
        { key: "trend", weight: wTrend, value: trend },
        { key: "regime", weight: wRegime, value: regimeSmile },
        { key: "secular", weight: wSecular, value: secular },
    ];
    let weightedSum = 0;
    let totalAbsWeight = 0;
    let energy = 0;
    for (const { weight, value } of contributions) {
        const c = weight * value;
        weightedSum += c;
        totalAbsWeight += Math.abs(weight);
        energy += Math.abs(c);
    }
    const directionRaw = totalAbsWeight === 0 ? 0 : weightedSum / totalAbsWeight;
    const direction = clamp(directionRaw, -2, 2);
    // Agreement: how much of the weighted energy points the same way as the
    // net. 1.0 = every factor pushes the same direction; 0.0 = they cancel.
    // Mixed signals must score low conviction even when net-positive, so it
    // discounts conviction multiplicatively. The shallow exponent keeps it
    // sensitive near the extremes without zeroing a mostly-aligned read.
    const agreement = energy === 0 ? 0 : Math.abs(weightedSum) / energy;
    const conviction = clamp(1 + 9 * ((Math.abs(direction) / 2) ** 0.8 * (agreement ** 0.3) * (confidence ** 0.2)), 1, 10);
    const matchedPosition = context.positions.find((p) => p.symbol === context.asset.symbol);
    const ownPosition = matchedPosition === undefined
        ? { side: null, units: 0 }
        : { side: matchedPosition.side, units: matchedPosition.units };
    const { plan, sizingPlan } = derivePlan(direction, conviction, ownPosition, context, catalyst, params);
    if (sizingPlan)
        plan.sizing_plan = sizingPlan;
    return {
        strength: direction,
        conviction: Math.round(conviction),
        directive: plan.directive,
        plan,
        results: {
            w_catalyst: wCat,
            w_sentiment: wSent,
            w_trend: wTrend,
            w_regime: wRegime,
            w_secular: wSecular,
            fear_premium: fearPremium,
            divergence_boost: divergenceBoost,
            sentiment,
            sentiment_summary: summary,
            regime,
            regime_smile: regimeSmile,
            agreement,
            confidence,
            weighted_sum: weightedSum,
            total_abs_weight: totalAbsWeight,
        },
    };
}
function requireFactor(metrics, key) {
    const value = metrics[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < -2 || value > 2) {
        throw new JanusError("VALIDATION", `factor ${key} must be a number between -2 and 2, got ${value}`);
    }
    return value;
}
function requireCrowding(metrics) {
    const value = metrics["crowding"];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 1 || value > 100) {
        throw new JanusError("VALIDATION", `crowding must be a number between 1 and 100, got ${value}`);
    }
    return value;
}
function sentimentFromCrowding(P, trend, capitulation, divergence, fearPremium, divergenceBoost) {
    let base;
    let summary;
    if (capitulation || P <= 12) {
        base = 2.0;
        summary = "<=12 / capitulation - true panic";
    }
    else if (P < 25) {
        base = 1.0;
        summary = "12-25 - fear";
    }
    else if (P < 40) {
        base = 0.75 * (40 - P) / 15.0;
        summary = "25-40 - getting fearful (linear)";
    }
    else if (P < 65) {
        const s = trend > 0 ? 1.0 : (trend < 0 ? -1.0 : 0.0);
        base = 0.4 * s;
        summary = "40-65 - calm middle (+0.4 x sign(Trend))";
    }
    else if (P < 85) {
        base = -1.0 * (P - 65) / 20.0;
        summary = "65-85 - getting crowded (linear)";
    }
    else if (P < 95) {
        base = -1.5;
        summary = "85-95 - greed, fade";
    }
    else {
        base = -2.0;
        summary = ">=95 - true euphoria, fade hard";
    }
    // Deliberate asymmetry: on a perp book panic bounces are sharper than
    // tops, so the buy side of the fade is scaled by fear_premium. The greed
    // side is untouched. The divergence booster widens an already-committed
    // fade rather than creating one, by divergence_boost.
    let sentiment = base > 0 ? clamp(base * fearPremium, -2.0, 2.0) : base;
    if (divergence) {
        if (sentiment === 0) {
            summary += " (divergence booster skipped: sentiment = 0, no fade direction)";
        }
        else {
            sentiment = clamp(sentiment + Math.sign(sentiment) * divergenceBoost, -2.0, 2.0);
            summary += " + divergence booster";
        }
    }
    return { sentiment, summary };
}
/**
 * The directive ladder.
 *
 * Design principles it implements:
 * - Most days = HOLD, but HOLD means "thesis intact."
 * - Six gates (signal, persistence, trend, binary, heat, flipflop) decide whether
 *   and how large a new position can be; the ladder turns those gates into the
 *   final directive and a size_tier.
 * - Regime is context plus an extreme-contrarian trigger.
 * - Direction != conviction: low conviction downgrades aggression to HOLD/TRIM.
 * - Persistence/flipflop gates resist flip-flopping unless there is an
 *   actionable new signal.
 */
function derivePlan(strength, conviction, position, context, catalyst, params) {
    const side = strength > 0 ? "long" : strength < 0 ? "short" : null;
    const absStrength = Math.abs(strength);
    const regimeSmile = requireNum(context.screen.results, "regime_smile", -2, 2);
    // Evaluate every gate so the plan can report why it was allowed or blocked.
    const { signal, persistence, trend, binary, heat, flipflop } = runGates(strength, conviction, position, context.screen.metrics, {
        params,
        sessionDate: context.session_date,
        coverage: context.asset.coverage,
        binary: context.binary ?? null,
        lastExit: context.last_exit ?? null,
        recentScores: context.recent_scores ?? [],
        currentHeat: context.current_heat ?? 0,
        proposedHeat: buildProposedHeat(position, side, context, params),
    });
    const blocked = signal === "fail" || persistence === "fail" || trend === "fail" || binary === "blocked" || heat === "blocked" || flipflop === "blocked";
    const starter = !blocked && (trend === "starter" || persistence === "insufficient_history");
    const sizeTier = blocked ? "blocked" : starter ? "starter" : "full";
    // Regime extreme-contrarian trigger.
    const regimeTrigger = regimeTriggerState(regimeSmile, params);
    const regimeBlocksSide = (s) => (s === "long" && regimeTrigger === "extreme_bull") ||
        (s === "short" && regimeTrigger === "extreme_bear");
    const regimeForcesExit = (s) => {
        const threshold = params["regime_force_exit_threshold"] ?? 1.8;
        return (s === "long" && regimeSmile >= threshold) || (s === "short" && regimeSmile <= -threshold);
    };
    const convHold = params["conv_hold"] ?? 4;
    const maxUnits = params["max_units"] ?? 3;
    const isWorking = position.side !== null &&
        ((position.side === "long" && strength > 0) || (position.side === "short" && strength < 0));
    let plan;
    let sizingPlan;
    if (position.side === null) {
        // Flat.
        if (side === null) {
            plan = {
                directive: "STAND_ASIDE",
                reason: "no directional edge",
                size_tier: "blocked",
                signal_gate: signal,
                persistence_gate: persistence,
                trend_gate: trend,
                binary_gate: binary,
                heat_gate: heat,
                flipflop_gate: flipflop,
            };
        }
        else if (regimeBlocksSide(side)) {
            plan = {
                directive: "STAND_ASIDE",
                reason: `extreme ${side === "long" ? "bull" : "bear"} regime blocks ${side} entry`,
                size_tier: "blocked",
                signal_gate: signal,
                persistence_gate: persistence,
                trend_gate: trend,
                binary_gate: binary,
                heat_gate: heat,
                flipflop_gate: flipflop,
                regime_trigger: regimeTrigger,
            };
        }
        else if (sizeTier === "blocked") {
            const gateReasons = [];
            if (signal === "fail")
                gateReasons.push("signal");
            if (persistence === "fail")
                gateReasons.push("persistence");
            if (trend === "fail")
                gateReasons.push("trend");
            if (binary === "blocked")
                gateReasons.push("binary");
            if (heat === "blocked")
                gateReasons.push("heat");
            if (flipflop === "blocked")
                gateReasons.push("flipflop");
            plan = {
                directive: "STAND_ASIDE",
                reason: gateReasons.length > 0
                    ? `${side} entry blocked by ${gateReasons.join(", ")} gate(s)`
                    : `${side} entry blocked`,
                size_tier: "blocked",
                signal_gate: signal,
                persistence_gate: persistence,
                trend_gate: trend,
                binary_gate: binary,
                heat_gate: heat,
                flipflop_gate: flipflop,
            };
        }
        else {
            sizingPlan = buildSizingPlan(side, context, params);
            plan = {
                directive: "INITIATE",
                reason: `strength ${strength.toFixed(2)} conviction ${conviction} + gates pass${sizeTier === "starter" ? " (starter tier)" : ""}`,
                size_tier: sizeTier,
                signal_gate: signal,
                persistence_gate: persistence,
                trend_gate: trend,
                binary_gate: binary,
                heat_gate: heat,
                flipflop_gate: flipflop,
                entry_plan: { side, max_units: maxUnits },
                stop_plan: { action: "hold", affected_units: "all", rationale: "initial stop set at entry" },
                sizing_plan: sizingPlan,
            };
        }
    }
    else {
        // Holding.
        const posSide = position.side;
        const posUnits = position.units;
        const aligned = side === posSide;
        const misaligned = side !== null && !aligned;
        const disagreement = misaligned ? absStrength : 0;
        const strengthExit = params["signal_strength_exit"] ?? 1.0;
        if (regimeForcesExit(posSide)) {
            plan = {
                directive: "EXIT",
                reason: `extreme regime against ${posSide} position forces full exit`,
                size_tier: "full",
                signal_gate: signal,
                persistence_gate: persistence,
                trend_gate: trend,
                binary_gate: binary,
                heat_gate: heat,
                flipflop_gate: flipflop,
                regime_trigger: regimeTrigger,
                stop_plan: { action: "hold", affected_units: "all", rationale: "exit entire position" },
            };
        }
        else if (misaligned && disagreement >= strengthExit && conviction >= convHold) {
            plan = {
                directive: "EXIT",
                reason: `score flipped against ${posSide} by ${disagreement.toFixed(2)} with conviction ${conviction}`,
                size_tier: "full",
                signal_gate: signal,
                persistence_gate: persistence,
                trend_gate: trend,
                binary_gate: binary,
                heat_gate: heat,
                flipflop_gate: flipflop,
                stop_plan: { action: "hold", affected_units: "all", rationale: "exit entire position" },
            };
        }
        else if (conviction < convHold) {
            // Low conviction even when still aligned: reduce, do not add.
            const targetUnits = Math.max(1, Math.min(posUnits - 1, posUnits));
            plan = {
                directive: posUnits > 1 ? "TRIM" : "HOLD",
                reason: `conviction ${conviction} below hold floor ${convHold}; thesis unclear`,
                size_tier: posUnits > 1 ? "full" : "blocked",
                signal_gate: signal,
                persistence_gate: persistence,
                trend_gate: trend,
                binary_gate: binary,
                heat_gate: heat,
                flipflop_gate: flipflop,
                stop_plan: { action: "tighten", affected_units: "newest", rationale: "lower conviction, protect downside" },
                trim_plan: posUnits > 1
                    ? { target_units: targetUnits, which: "newest" }
                    : undefined,
            };
        }
        else if (aligned && sizeTier !== "blocked" && posUnits < maxUnits && isWorking) {
            sizingPlan = buildSizingPlan(posSide, context, params);
            plan = {
                directive: "ADD",
                reason: `position working, strength ${strength.toFixed(2)} conviction ${conviction} allow add${sizeTier === "starter" ? " (starter tier)" : ""}`,
                size_tier: sizeTier,
                signal_gate: signal,
                persistence_gate: persistence,
                trend_gate: trend,
                binary_gate: binary,
                heat_gate: heat,
                flipflop_gate: flipflop,
                stop_plan: { action: "move_to_breakeven", affected_units: "oldest", rationale: "new unit adds risk; lock earlier unit" },
                sizing_plan: sizingPlan,
            };
        }
        else {
            plan = {
                directive: "HOLD",
                reason: aligned
                    ? "thesis intact"
                    : `mild disagreement ${strength.toFixed(2)} but conviction ${conviction} keeps thesis on review`,
                size_tier: sizeTier,
                signal_gate: signal,
                persistence_gate: persistence,
                trend_gate: trend,
                binary_gate: binary,
                heat_gate: heat,
                flipflop_gate: flipflop,
                stop_plan: { action: "hold", affected_units: "all", rationale: "review stop/exit plan, no change today" },
            };
        }
    }
    // Persistence rule: resist flip-flopping.
    const previousScore = context.previous_score ?? null;
    if (previousScore !== null) {
        const prev = previousScore.directive;
        const curr = plan.directive;
        if ((prev === "HOLD" || prev === "ADD") && (curr === "EXIT" || curr === "TRIM")) {
            if (!actionableNewSignal(strength, catalyst, context, previousScore, params)) {
                // Downgrade EXIT to TRIM and TRIM to HOLD unless already at 1 unit.
                if (curr === "EXIT" && position.side !== null && position.units > 1) {
                    plan = {
                        ...plan,
                        directive: "TRIM",
                        reason: `${plan.reason} (persistence: no actionable new signal, trim instead of exit)`,
                        persistence_rule: "maintain",
                        trim_plan: { target_units: Math.max(1, position.units - 1), which: "newest" },
                    };
                }
                else {
                    plan = {
                        ...plan,
                        directive: "HOLD",
                        reason: `${plan.reason} (persistence: no actionable new signal, maintain)`,
                        persistence_rule: "maintain",
                        trim_plan: undefined,
                        stop_plan: { action: "hold", affected_units: "all", rationale: "maintain position per persistence rule" },
                    };
                }
            }
            else {
                plan = { ...plan, persistence_rule: "fresh_signal" };
            }
        }
        else if (prev === "STAND_ASIDE" && curr === "INITIATE") {
            if (sizeTier === "blocked" || !actionableNewSignal(strength, catalyst, context, previousScore, params)) {
                plan = {
                    ...plan,
                    directive: "STAND_ASIDE",
                    reason: `${plan.reason} (persistence: no actionable new signal)`,
                    persistence_rule: "maintain",
                    entry_plan: undefined,
                };
            }
            else {
                plan = { ...plan, persistence_rule: "fresh_signal" };
            }
        }
    }
    return { plan, sizingPlan };
}
function buildProposedHeat(position, side, context, params) {
    if (position.side !== null)
        return 0; // existing position adds no new heat in this decision
    if (side === null)
        return 0;
    const sizing = buildSizingPlan(side, context, params);
    return sizing?.risk_dollars ?? 0;
}
function buildSizingPlan(side, context, params) {
    const capital = params["account_capital"] ?? 0;
    const coverage = context.asset.coverage;
    if (capital <= 0 || coverage === null)
        return undefined;
    const mark = coverage.mark_price;
    const atr = coverage.atr14;
    if (mark === null || atr === null || mark <= 0 || atr <= 0)
        return undefined;
    const entry = mark;
    const stopMultiple = params["stop_atr_multiple"] ?? 2;
    const stop = stopFromAtr(entry, atr, stopMultiple, side);
    const distPct = stopDistancePct(entry, stop, side);
    if (distPct <= 0)
        return undefined;
    const result = sizeFromRiskAndStop({
        capital,
        maxRiskPct: params["per_trade_max_risk_pct"] ?? 5,
        conviction: context.previous_score?.conviction ?? params["signal_conviction_initiate"] ?? 6,
        stopDistancePct: distPct,
        perAssetMaxNotionalPct: params["per_asset_max_notional_pct"] ?? 20,
    });
    const currentHeat = context.current_heat ?? 0;
    return {
        suggested_notional: result.cappedPositionSizeDollars,
        risk_dollars: result.riskDollars,
        stop_distance_pct: distPct,
        stop_price: stop,
        heat_after_trade: currentHeat + result.heatDollars,
        per_asset_cap_dollars: result.perAssetCapDollars,
    };
}
