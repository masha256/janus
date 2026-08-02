import { JanusError } from "../output.js";
import { num, requireNum } from "./metrics.js";
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
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
    // downstream threshold (screen_threshold, d_initiate...) comparable.
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
    return {
        strength: direction,
        conviction: Math.round(conviction),
        directive: deriveDirective(),
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
 * Stub. The ladder that turns strength, conviction, and the open position into
 * INITIATE/ADD/HOLD/TRIM/EXIT is still to be written; until then every score
 * concludes NONE rather than guessing.
 */
function deriveDirective() {
    return "NONE";
}
