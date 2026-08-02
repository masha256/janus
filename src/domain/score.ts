import { JanusError } from "../output.ts";
import { type Metrics, num, requireNum } from "./metrics.ts";
import type { Read } from "./read.ts";
import type { Directive, OpenPosition, PositionState, ScorePlan } from "./directive.ts";
import type { CoverageValues } from "./coverage.ts";

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const boolParam = (params: Record<string, number>, key: string): boolean =>
  (params[key] ?? 0) !== 0;

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

/** A phase read as the formula sees it: what it observed, what it concluded. */
export type Screen = Read & { flagged: boolean };

/**
 * Everything the session knows at scoring time. The reads come top down; the
 * screen is null for an asset that reached the queue on an open trade rather
 * than a flag; `positions` is every open position in the book, not just this
 * asset's, so a formula can weigh the decision against what is already on.
 *
 * `previous_score` is the last recorded score for this asset, used by the
 * persistence rule to resist flip-flopping. Absent means no prior score.
 */
export type ScoreContext = {
  macro: Read;
  cluster: Read | null;
  screen: Screen | null;
  positions: OpenPosition[];
  asset: {
    symbol: string;
    class: string;
    cluster_id: number | null;
    coverage: CoverageValues | null;
  };
  previous_score?: ScoreResult | null;
};

export type ScoreResult = {
  /** The standardised decision inputs, named for what they mean. */
  strength: number;
  conviction: number;
  /** What to do about the position. */
  directive: Directive;
  /** Actionable sub-plan: why, trend gate, persistence, stop/trim hints. */
  plan: ScorePlan;
  /** Everything else the formula concluded, serialized into score_result. */
  results: Metrics;
};

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
export function deriveScore(
  metrics: Metrics,
  context: ScoreContext,
  params: Record<string, number>,
): ScoreResult {
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
  const { sentiment, summary } = sentimentFromCrowding(
    crowding,
    trend,
    capitulation,
    divergence,
    fearPremium,
    divergenceBoost,
  );

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
  const contributions: { key: string; weight: number; value: number }[] = [
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

  const conviction = clamp(
    1 + 9 * ((Math.abs(direction) / 2) ** 0.8 * (agreement ** 0.3) * (confidence ** 0.2)),
    1,
    10,
  );

  const matchedPosition = context.positions.find((p) => p.symbol === context.asset.symbol);
  const ownPosition: PositionState = matchedPosition === undefined
    ? { side: null, units: 0 }
    : { side: matchedPosition.side, units: matchedPosition.units };

  const plan = derivePlan(
    direction,
    conviction,
    ownPosition,
    context.asset.coverage,
    regimeSmile,
    catalyst,
    divergence,
    capitulation,
    context.previous_score ?? null,
    params,
  );

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

function requireFactor(metrics: Metrics, key: string): number {
  const value = metrics[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < -2 || value > 2) {
    throw new JanusError(
      "VALIDATION",
      `factor ${key} must be a number between -2 and 2, got ${value}`,
    );
  }
  return value;
}

function requireCrowding(metrics: Metrics): number {
  const value = metrics["crowding"];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1 || value > 100) {
    throw new JanusError(
      "VALIDATION",
      `crowding must be a number between 1 and 100, got ${value}`,
    );
  }
  return value;
}

function sentimentFromCrowding(
  P: number,
  trend: number,
  capitulation: boolean,
  divergence: boolean,
  fearPremium: number,
  divergenceBoost: number,
): { sentiment: number; summary: string } {
  let base: number;
  let summary: string;
  if (capitulation || P <= 12) {
    base = 2.0;
    summary = "<=12 / capitulation - true panic";
  } else if (P < 25) {
    base = 1.0;
    summary = "12-25 - fear";
  } else if (P < 40) {
    base = 0.75 * (40 - P) / 15.0;
    summary = "25-40 - getting fearful (linear)";
  } else if (P < 65) {
    const s = trend > 0 ? 1.0 : (trend < 0 ? -1.0 : 0.0);
    base = 0.4 * s;
    summary = "40-65 - calm middle (+0.4 x sign(Trend))";
  } else if (P < 85) {
    base = -1.0 * (P - 65) / 20.0;
    summary = "65-85 - getting crowded (linear)";
  } else if (P < 95) {
    base = -1.5;
    summary = "85-95 - greed, fade";
  } else {
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
    } else {
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
 * - Trend/MA structure is a hard gate for entry and scaling.
 * - Regime is context plus an extreme-contrarian trigger.
 * - Direction != conviction: low conviction downgrades aggression to HOLD/TRIM.
 * - Persistence rule resists flip-flopping unless there is an actionable new signal.
 */
function derivePlan(
  strength: number,
  conviction: number,
  position: PositionState,
  coverage: CoverageValues | null,
  regimeSmile: number,
  catalyst: number,
  divergence: boolean,
  capitulation: boolean,
  previousScore: ScoreResult | null,
  params: Record<string, number>,
): ScorePlan {
  const dInitiate = params["d_initiate"] ?? 1.0;
  const convInitiate = params["conv_initiate"] ?? 6;
  const dAdd = params["d_add"] ?? 1.0;
  const convAdd = params["conv_add"] ?? 7;
  const convHold = params["conv_hold"] ?? 4;
  const dExit = params["d_exit"] ?? 1.0;
  const maxUnits = params["max_units"] ?? 3;

  const side: "long" | "short" | null = strength > 0 ? "long" : strength < 0 ? "short" : null;
  const absStrength = Math.abs(strength);
  const isWorking = position.side !== null &&
    ((position.side === "long" && strength > 0) || (position.side === "short" && strength < 0));

  // Regime extreme-contrarian trigger.
  const regimeTrigger = regimeTriggerState(regimeSmile, params);
  const regimeBlocksSide = (s: "long" | "short"): boolean =>
    (s === "long" && regimeTrigger === "extreme_bull") ||
    (s === "short" && regimeTrigger === "extreme_bear");
  const regimeForcesExit = (s: "long" | "short"): boolean => {
    const threshold = params["regime_force_exit_threshold"] ?? 1.8;
    return (s === "long" && regimeSmile >= threshold) || (s === "short" && regimeSmile <= -threshold);
  };

  // Trend gate: hard condition for entry/add in a direction.
  const trendOk = side === null ? false : trendGateOK(side, coverage, params);

  let plan: ScorePlan;

  if (position.side === null) {
    // Flat.
    if (side === null) {
      plan = {
        directive: "STAND_ASIDE",
        reason: "no directional edge",
        trend_gate: "fail",
      };
    } else if (regimeBlocksSide(side)) {
      plan = {
        directive: "STAND_ASIDE",
        reason: `extreme ${side === "long" ? "bull" : "bear"} regime blocks ${side} entry`,
        trend_gate: trendOk ? "pass" : "fail",
        regime_trigger: regimeTrigger,
      };
    } else if (absStrength < dInitiate || conviction < convInitiate) {
      plan = {
        directive: "STAND_ASIDE",
        reason: `strength ${strength.toFixed(2)}/conviction ${conviction} below initiate thresholds`,
        trend_gate: trendOk ? "pass" : "fail",
      };
    } else if (!trendOk) {
      plan = {
        directive: "STAND_ASIDE",
        reason: `trend gate fails for ${side} entry`,
        trend_gate: "fail",
      };
    } else {
      plan = {
        directive: "INITIATE",
        reason: `strength ${strength.toFixed(2)} conviction ${conviction} + trend gate pass`,
        trend_gate: "pass",
        entry_plan: { side, max_units: maxUnits },
        stop_plan: { action: "hold", affected_units: "all", rationale: "initial stop set at entry" },
      };
    }
  } else {
    // Holding.
    const posSide = position.side;
    const posUnits = position.units;
    const aligned = side === posSide;
    const misaligned = side !== null && !aligned;
    const disagreement = misaligned ? absStrength : 0;

    if (regimeForcesExit(posSide)) {
      plan = {
        directive: "EXIT",
        reason: `extreme regime against ${posSide} position forces full exit`,
        trend_gate: trendOk ? "pass" : "fail",
        regime_trigger: regimeTrigger,
        stop_plan: { action: "hold", affected_units: "all", rationale: "exit entire position" },
      };
    } else if (misaligned && disagreement >= dExit && conviction >= convHold) {
      plan = {
        directive: "EXIT",
        reason: `score flipped against ${posSide} by ${disagreement.toFixed(2)} with conviction ${conviction}`,
        trend_gate: trendOk ? "pass" : "fail",
        stop_plan: { action: "hold", affected_units: "all", rationale: "exit entire position" },
      };
    } else if (conviction < convHold) {
      // Low conviction even when still aligned: reduce, do not add.
      const targetUnits = Math.max(1, Math.min(posUnits - 1, posUnits));
      plan = {
        directive: posUnits > 1 ? "TRIM" : "HOLD",
        reason: `conviction ${conviction} below hold floor ${convHold}; thesis unclear`,
        trend_gate: trendOk ? "pass" : "fail",
        persistence_rule: undefined,
        stop_plan: { action: "tighten", affected_units: "newest", rationale: "lower conviction, protect downside" },
        trim_plan: posUnits > 1
          ? { target_units: targetUnits, which: "newest" }
          : undefined,
      };
    } else if (aligned && absStrength >= dAdd && conviction >= convAdd && trendOk && posUnits < maxUnits && isWorking) {
      plan = {
        directive: "ADD",
        reason: `position working, strength ${strength.toFixed(2)} conviction ${conviction} allow add`,
        trend_gate: "pass",
        persistence_rule: undefined,
        stop_plan: { action: "move_to_breakeven", affected_units: "oldest", rationale: "new unit adds risk; lock earlier unit" },
      };
    } else {
      plan = {
        directive: "HOLD",
        reason: aligned
          ? "thesis intact"
          : `mild disagreement ${strength.toFixed(2)} but conviction ${conviction} keeps thesis on review`,
        trend_gate: trendOk ? "pass" : "fail",
        stop_plan: { action: "hold", affected_units: "all", rationale: "review stop/exit plan, no change today" },
      };
    }
  }

  // Persistence rule: resist flip-flopping.
  if (previousScore !== null) {
    const prev = previousScore.directive;
    const curr = plan.directive;
    if ((prev === "HOLD" || prev === "ADD") && (curr === "EXIT" || curr === "TRIM")) {
      if (!actionableNewSignal(strength, catalyst, divergence, capitulation, previousScore, params)) {
        // Downgrade EXIT to TRIM and TRIM to HOLD unless already at 1 unit.
        if (curr === "EXIT" && position.side !== null && position.units > 1) {
          plan = {
            ...plan,
            directive: "TRIM",
            reason: `${plan.reason} (persistence: no actionable new signal, trim instead of exit)`,
            persistence_rule: "maintain",
            trim_plan: { target_units: Math.max(1, position.units - 1), which: "newest" },
          };
        } else {
          plan = {
            ...plan,
            directive: "HOLD",
            reason: `${plan.reason} (persistence: no actionable new signal, maintain)`,
            persistence_rule: "maintain",
            trim_plan: undefined,
            stop_plan: { action: "hold", affected_units: "all", rationale: "maintain position per persistence rule" },
          };
        }
      } else {
        plan = { ...plan, persistence_rule: "fresh_signal" };
      }
    } else if (prev === "STAND_ASIDE" && curr === "INITIATE") {
      if (!trendOk || !actionableNewSignal(strength, catalyst, divergence, capitulation, previousScore, params)) {
        plan = {
          ...plan,
          directive: "STAND_ASIDE",
          reason: `${plan.reason} (persistence: no actionable new signal)`,
          persistence_rule: "maintain",
          entry_plan: undefined,
        };
      } else {
        plan = { ...plan, persistence_rule: "fresh_signal" };
      }
    }
  }

  return plan;
}

function trendGateOK(
  side: "long" | "short",
  coverage: CoverageValues | null,
  params: Record<string, number>,
): boolean {
  if (coverage === null) return false;
  const pxVs50 = coverage.px_vs_sma50;
  const cross50_200 = coverage.cross_50_200;
  const crossPx50 = coverage.cross_px_50;

  const longCushion = params["trend_gate_long"] ?? 1.0;
  const shortCushion = params["trend_gate_short"] ?? -1.0;
  const requireGolden = boolParam(params, "require_golden_for_long");
  const requireDeath = boolParam(params, "require_death_for_short");

  if (side === "long") {
    if (crossPx50 !== "above") return false;
    if (requireGolden && cross50_200 === "death") return false;
    if (pxVs50 === null || pxVs50 < longCushion) return false;
    return true;
  }

  if (side === "short") {
    if (crossPx50 !== "below") return false;
    if (requireDeath && cross50_200 === "golden") return false;
    if (pxVs50 === null || pxVs50 > shortCushion) return false;
    return true;
  }

  return false;
}

function regimeTriggerState(
  regimeSmile: number,
  params: Record<string, number>,
): ScorePlan["regime_trigger"] {
  const longMax = params["regime_trigger_long_max"] ?? 1.5;
  const shortMin = params["regime_trigger_short_min"] ?? -1.5;
  if (regimeSmile >= longMax) return "extreme_bull";
  if (regimeSmile <= shortMin) return "extreme_bear";
  return "none";
}

function actionableNewSignal(
  strength: number,
  catalyst: number,
  divergence: boolean,
  capitulation: boolean,
  previousScore: ScoreResult,
  params: Record<string, number>,
): boolean {
  const catalystMin = params["actionable_catalyst_min"] ?? 1.5;
  const strengthDelta = params["actionable_strength_delta"] ?? 1.0;
  if (capitulation || divergence) return true;
  if (Math.abs(catalyst) >= catalystMin) return true;
  if (Math.abs(strength - previousScore.strength) >= strengthDelta) return true;
  return false;
}
