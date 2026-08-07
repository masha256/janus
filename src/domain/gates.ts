import { type Metrics, num } from "./metrics.ts";
import type { PositionState, ScorePlan } from "./directive.ts";
import type { CoverageValues } from "./coverage.ts";
import type { ScoreContext, ScoreResult } from "./score.ts";
import { unitsHeat } from "./trade-math.ts";

const boolParam = (params: Record<string, number>, key: string): boolean =>
  (params[key] ?? 0) !== 0;

export function signalGate(
  direction: number,
  conviction: number,
  position: PositionState,
  params: Record<string, number>,
): ScorePlan["signal_gate"] {
  const absDirection = Math.abs(direction);
  const side: "long" | "short" | null = direction > 0 ? "long" : direction < 0 ? "short" : null;
  const directionInitiate = params["signal_direction_initiate"] ?? 0.9;
  const convInitiate = params["signal_conviction_initiate"] ?? 6;
  const directionAdd = params["signal_direction_add"] ?? 1.0;
  const convAdd = params["signal_conviction_add"] ?? 7;
  const directionExit = params["signal_direction_exit"] ?? 1.0;
  const convHold = params["conv_hold"] ?? 4;

  const aligned = position.side !== null && side === position.side;
  const misaligned = position.side !== null && side !== null && !aligned;

  if (side === null) return "fail";
  if (position.side === null) {
    return absDirection >= directionInitiate && conviction >= convInitiate ? "pass" : "fail";
  }
  if (misaligned) {
    return absDirection >= directionExit && conviction >= convHold ? "pass" : "fail";
  }
  // Aligned: pass if either add thresholds are met (so ADD can be considered) or
  // at least hold-quality signal is present (so HOLD is not treated as a failure).
  return absDirection >= directionAdd && conviction >= convAdd ? "pass" : "fail";
}

export function persistenceGate(
  direction: number,
  conviction: number,
  side: "long" | "short" | null,
  recentScores: ScoreResult[],
  params: Record<string, number>,
): ScorePlan["persistence_gate"] {
  const required = Math.max(1, Math.round(params["signal_persist_days"] ?? 2));
  if (recentScores.length < required - 1) {
    // Need at least N-1 prior scores plus today; without them the signal has not persisted.
    return "fail";
  }

  const directionInitiate = params["signal_direction_initiate"] ?? 0.9;
  const convInitiate = params["signal_conviction_initiate"] ?? 6;

  // Walk backwards through recent scores (newest first). Count consecutive days
  // where the same-side signal would have passed the initiate threshold.
  let count = 1; // today counts once signalGate already passed
  for (const score of recentScores) {
    const sameSide = side === null
      ? false
      : (side === "long" && score.direction > 0) || (side === "short" && score.direction < 0);
    const absDirection = Math.abs(score.direction);
    if (sameSide && absDirection >= directionInitiate && score.conviction >= convInitiate) {
      count++;
    } else {
      break;
    }
  }
  return count >= required ? "pass" : "fail";
}

/**
 * Signal decay: conviction has sat below the floor for N consecutive run-days
 * on the side we are actually holding. One bad print is noise, which is why
 * this needs persistence — the ladder turns a true reading into a full exit.
 *
 * A direction flip is not decay. The EXIT directive branch already owns that.
 */
export function decayGate(
  conviction: number,
  side: "long" | "short" | null,
  recentScores: ScoreResult[],
  params: Record<string, number>,
): boolean {
  const floor = params["decay_conviction_floor"] ?? 4;
  const required = Math.max(1, Math.round(params["decay_persist_days"] ?? 2));
  if (conviction >= floor) return false;
  let count = 1; // today is the first decay day
  for (const s of recentScores) {
    const sameSide = side !== null &&
      ((side === "long" && s.direction > 0) || (side === "short" && s.direction < 0));
    if (sameSide && s.conviction < floor) count++;
    else break;
  }
  return count >= required;
}

export function trendGate(
  side: "long" | "short" | null,
  coverage: CoverageValues | null,
  crowding: number,
  params: Record<string, number>,
): ScorePlan["trend_gate"] {
  if (coverage === null || side === null) return "fail";

  const pxVs20 = coverage.px_vs_sma20;
  const pxVs50 = coverage.px_vs_sma50;
  const pxVs200 = coverage.px_vs_sma200;

  const t20Long = params["trend_sma20_threshold_long"] ?? 0;
  const t50Long = params["trend_sma50_threshold_long"] ?? 0;
  const t20Short = params["trend_sma20_threshold_short"] ?? 0;
  const t50Short = params["trend_sma50_threshold_short"] ?? 0;
  const lateDist = params["late_trend_ma_distance"] ?? 20;
  const lateCrowd = params["late_trend_crowding_extreme"] ?? 85;

  if (side === "long") {
    if (pxVs20 === null || pxVs20 <= t20Long) return "fail";
    if (pxVs50 === null || pxVs50 < t50Long) return "starter";
    const extended = pxVs200 !== null && pxVs200 >= lateDist && crowding >= lateCrowd;
    return extended ? "late_trend" : "pass";
  }

  if (side === "short") {
    if (pxVs20 === null || pxVs20 >= t20Short) return "fail";
    if (pxVs50 === null || pxVs50 > t50Short) return "starter";
    const extended = pxVs200 !== null && pxVs200 <= -lateDist && crowding >= lateCrowd;
    return extended ? "late_trend" : "pass";
  }

  return "fail";
}

export function binaryGate(
  sessionDate: string,
  binary: { date: string | null; reason: string | null } | null,
  params: Record<string, number>,
): ScorePlan["binary_gate"] {
  if (binary === null || binary.date === null) return "pass";
  const cooldown = Math.max(0, params["binary_cooldown_days"] ?? 14);
  if (cooldown === 0) return "pass";
  const days = daysBetween(binary.date, sessionDate);
  return days !== null && days >= 0 && days < cooldown ? "blocked" : "pass";
}

export function heatGate(
  params: Record<string, number>,
  currentHeat: number,
  proposedHeat: number,
): ScorePlan["heat_gate"] {
  const capital = params["account_capital"] ?? 0;
  const maxHeatPct = params["max_heat_pct"] ?? 100;
  if (capital <= 0) return "pass"; // no capital declared: warn but do not block
  const maxHeatDollars = capital * (maxHeatPct / 100);
  return currentHeat + proposedHeat > maxHeatDollars ? "blocked" : "pass";
}

export function flipflopGate(
  side: "long" | "short" | null,
  sessionDate: string,
  lastExit: { session_date: string; side: "long" | "short"; units: number } | null,
  persistence: ScorePlan["persistence_gate"],
  params: Record<string, number>,
): ScorePlan["flipflop_gate"] {
  if (side === null || lastExit === null) return "n/a";
  const cooldown = Math.max(0, params["flipflop_cooldown_days"] ?? 5);
  if (cooldown === 0 || lastExit.side === side) return "n/a";
  const days = daysBetween(lastExit.session_date, sessionDate);
  if (days === null || days < 0 || days >= cooldown) return "n/a";

  // persistenceGate already computed the run-day persistence for the proposed side.
  const persistOk = persistence === "pass";
  return persistOk ? "pass" : "blocked";
}

export function regimeTriggerState(
  regimeSmile: number,
  params: Record<string, number>,
): ScorePlan["regime_trigger"] {
  const longMax = params["regime_trigger_long_max"] ?? 1.5;
  const shortMin = params["regime_trigger_short_min"] ?? -1.5;
  if (regimeSmile >= longMax) return "extreme_bull";
  if (regimeSmile <= shortMin) return "extreme_bear";
  return "none";
}

/**
 * `metrics` is the score's own factor bag, not the screen's. `capitulation` and
 * `divergence` are declared as `score record --factor`, so reading them off the
 * screen row finds nothing and silently drops both short-circuits.
 */
export function actionableNewSignal(
  direction: number,
  catalyst: number,
  metrics: Metrics,
  previousScore: ScoreResult,
  params: Record<string, number>,
): boolean {
  const catalystMin = params["actionable_catalyst_min"] ?? 1.5;
  const directionDelta = params["actionable_direction_delta"] ?? 1.5;
  if (Boolean(metrics["capitulation"])) return true;
  if (Boolean(metrics["divergence"])) return true;
  if (Math.abs(catalyst) >= catalystMin) return true;
  if (Math.abs(direction - previousScore.direction) >= directionDelta) return true;
  return false;
}

/** Days between two ISO date strings (a - b), or null if either is invalid. */
function daysBetween(a: string, b: string): number | null {
  const ad = Date.parse(a + "T00:00:00Z");
  const bd = Date.parse(b + "T00:00:00Z");
  if (Number.isNaN(ad) || Number.isNaN(bd)) return null;
  return Math.round((ad - bd) / 86_400_000);
}

export type GateContext = {
  params: Record<string, number>;
  sessionDate: string;
  coverage: CoverageValues | null;
  binary: { date: string | null; reason: string | null } | null;
  lastExit: { session_date: string; side: "long" | "short"; units: number } | null;
  recentScores: ScoreResult[];
  /** Sum of heat across all open positions in the book. */
  currentHeat: number;
  /** Heat the proposed trade would add; 0 for flat/non-entry decisions. */
  proposedHeat: number;
};

/**
 * `metrics` is the score's factor bag. `crowding` is a required `score record`
 * factor and is never written to the screen row, so sourcing it from the screen
 * pins it at the 50 default and makes `trendGate`'s late-trend branch — and the
 * ladder's `tighten` rung behind it — permanently unreachable.
 */
export function runGates(
  direction: number,
  conviction: number,
  position: PositionState,
  metrics: Metrics,
  ctx: GateContext,
): {
  signal: ScorePlan["signal_gate"];
  persistence: ScorePlan["persistence_gate"];
  trend: ScorePlan["trend_gate"];
  binary: ScorePlan["binary_gate"];
  heat: ScorePlan["heat_gate"];
  flipflop: ScorePlan["flipflop_gate"];
} {
  const side: "long" | "short" | null = direction > 0 ? "long" : direction < 0 ? "short" : null;
  const crowding = num(metrics, "crowding", 50);

  const signal = signalGate(direction, conviction, position, ctx.params);
  const persistence = persistenceGate(direction, conviction, side, ctx.recentScores, ctx.params);
  const trend = trendGate(side, ctx.coverage, crowding, ctx.params);
  const binary = binaryGate(ctx.sessionDate, ctx.binary, ctx.params);
  const heat = heatGate(ctx.params, ctx.currentHeat, ctx.proposedHeat);
  const flipflop = flipflopGate(side, ctx.sessionDate, ctx.lastExit, persistence, ctx.params);

  return { signal, persistence, trend, binary, heat, flipflop };
}
