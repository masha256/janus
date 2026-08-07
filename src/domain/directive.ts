import type { LadderEvent } from "./ladder.ts";

/** `NONE` is the default: a score that has not concluded what to do about the position. */
export type Directive =
  | "NONE"
  | "INITIATE"
  | "ADD"
  | "HOLD"
  | "TRIM"
  | "EXIT"
  | "STAND_ASIDE";

export type PositionState = { side: "long" | "short" | null; units: number };

export function formatPosition(pos: PositionState): string {
  return pos.side === null ? "flat" : `${pos.side}:${pos.units}`;
}

/** An open position anywhere in the book, as the scoring formula sees it. */
export type OpenPosition = PositionState & {
  asset_id: number;
  symbol: string;
  side: "long" | "short";
};

/**
 * Actionable sub-plan produced by the directive ladder. It records *what* the
 * ladder recommends and *why*, without touching position sizing. The operator
 * still executes via `trade` commands.
 */
export type ScorePlan = {
  /** The final directive chosen by the ladder. */
  directive: Directive;

  /** Human-readable summary of why the ladder chose this directive. */
  reason: string;

  /** Which sizing tier the combined gates allow. */
  size_tier: "blocked" | "starter" | "full";

  /** Individual gate results for observability. */
  signal_gate: "pass" | "fail";
  persistence_gate: "pass" | "fail";
  trend_gate: "pass" | "starter" | "fail" | "late_trend";
  binary_gate: "pass" | "blocked";
  heat_gate: "pass" | "blocked";
  flipflop_gate: "pass" | "blocked" | "n/a";

  /** Was an extreme-contrarian regime trigger active? */
  regime_trigger?: "none" | "extreme_bull" | "extreme_bear";

  /** Did a persistence/anti-flip-flop rule modify the raw ladder output? */
  persistence_rule?: "fresh_signal" | "persisted" | "maintain";

  /** Direction of a new position, if any. Sizing is out of scope. */
  entry_plan?: {
    side: "long" | "short";
    /** Maximum units this trade may eventually carry (param ceiling). */
    max_units: number;
  };

  /** Recommended stop/exit management for open units. */
  stop_plan?: {
    action: "move_to_breakeven" | "trail" | "tighten" | "time_exit" | "decay_exit" | "hold";
    /** Which units the action targets. */
    affected_units: "all" | "oldest" | "newest" | "partial_target" | string;
    /** Optional computed stop price, e.g. from ATR trailing. */
    new_stop?: number;
    /** Which ladder rung produced this, when the stop ladder was the source. */
    event?: LadderEvent;
    /** Fraction of the affected unit to bank, for the partial rung. */
    trim_fraction?: number;
    rationale: string;
  };

  /** Sizing plan for new or adding positions. */
  sizing_plan?: {
    suggested_notional: number;
    risk_dollars: number;
    stop_distance_pct: number;
    stop_price: number;
    heat_after_trade: number;
    per_asset_cap_dollars: number;
  };

  /** Recommended unit reduction if the ladder calls for TRIM. */
  trim_plan?: {
    target_units: number;
    which: "highest_cost" | "oldest" | "newest" | string;
  };
};

export function formatPlan(plan: ScorePlan): string {
  const parts: string[] = [
    `${plan.directive} (${plan.reason})`,
    `size_tier=${plan.size_tier}`,
    `signal=${plan.signal_gate}`,
    `persist=${plan.persistence_gate}`,
    `trend=${plan.trend_gate}`,
    `binary=${plan.binary_gate}`,
    `heat=${plan.heat_gate}`,
    `flipflop=${plan.flipflop_gate}`,
  ];
  if (plan.regime_trigger && plan.regime_trigger !== "none") {
    parts.push(`regime_trigger=${plan.regime_trigger}`);
  }
  if (plan.persistence_rule) parts.push(`persistence=${plan.persistence_rule}`);
  if (plan.stop_plan) {
    parts.push(
      `stop=${plan.stop_plan.action}:${plan.stop_plan.affected_units}`,
    );
  }
  if (plan.trim_plan) {
    parts.push(`trim_to=${plan.trim_plan.target_units}:${plan.trim_plan.which}`);
  }
  if (plan.sizing_plan) {
    parts.push(
      `size=$${Math.round(plan.sizing_plan.suggested_notional)} risk=$${Math.round(plan.sizing_plan.risk_dollars)}`,
    );
  }
  return parts.join(" | ");
}

/** Convert a plan into flat result keys for storage in score_result. */
export function planResults(plan: ScorePlan): Record<string, number | string> {
  const r: Record<string, number | string> = {
    directive_reason: plan.reason,
    size_tier: plan.size_tier,
    signal_gate: plan.signal_gate,
    persistence_gate: plan.persistence_gate,
    trend_gate: plan.trend_gate,
    binary_gate: plan.binary_gate,
    heat_gate: plan.heat_gate,
    flipflop_gate: plan.flipflop_gate,
    persistence_rule: plan.persistence_rule ?? "n/a",
  };
  if (plan.regime_trigger && plan.regime_trigger !== "none") {
    r["regime_trigger"] = plan.regime_trigger;
  }
  if (plan.entry_plan) {
    r["entry_side"] = plan.entry_plan.side;
    r["entry_max_units"] = plan.entry_plan.max_units;
  }
  if (plan.stop_plan) {
    r["stop_action"] = plan.stop_plan.action;
    r["stop_affected_units"] = plan.stop_plan.affected_units;
    r["stop_rationale"] = plan.stop_plan.rationale;
    if (plan.stop_plan.new_stop !== undefined) r["stop_new_stop"] = plan.stop_plan.new_stop;
    if (plan.stop_plan.event !== undefined) r["stop_event"] = plan.stop_plan.event;
    if (plan.stop_plan.trim_fraction !== undefined) {
      r["stop_trim_fraction"] = plan.stop_plan.trim_fraction;
    }
  }
  if (plan.sizing_plan) {
    r["sizing_suggested_notional"] = plan.sizing_plan.suggested_notional;
    r["sizing_risk_dollars"] = plan.sizing_plan.risk_dollars;
    r["sizing_stop_distance_pct"] = plan.sizing_plan.stop_distance_pct;
    r["sizing_stop_price"] = plan.sizing_plan.stop_price;
    r["sizing_heat_after_trade"] = plan.sizing_plan.heat_after_trade;
    r["sizing_per_asset_cap_dollars"] = plan.sizing_plan.per_asset_cap_dollars;
  }
  if (plan.trim_plan) {
    r["trim_target_units"] = plan.trim_plan.target_units;
    r["trim_which"] = plan.trim_plan.which;
  }
  return r;
}

export function scorePlanFromResults(results: Record<string, unknown>): ScorePlan | undefined {
  const directive = results["plan_directive"] as Directive | undefined;
  if (directive === undefined) return undefined;
  const size_tier = results["size_tier"] as ScorePlan["size_tier"] | undefined;
  if (size_tier === undefined) return undefined;
  const plan: ScorePlan = {
    directive,
    reason: String(results["directive_reason"] ?? ""),
    size_tier,
    signal_gate: (results["signal_gate"] as ScorePlan["signal_gate"]) ?? "fail",
    persistence_gate: (results["persistence_gate"] as ScorePlan["persistence_gate"]) ?? "fail",
    trend_gate: (results["trend_gate"] as ScorePlan["trend_gate"]) ?? "fail",
    binary_gate: (results["binary_gate"] as ScorePlan["binary_gate"]) ?? "pass",
    heat_gate: (results["heat_gate"] as ScorePlan["heat_gate"]) ?? "pass",
    flipflop_gate: (results["flipflop_gate"] as ScorePlan["flipflop_gate"]) ?? "n/a",
    regime_trigger: (results["regime_trigger"] as ScorePlan["regime_trigger"]) ?? "none",
    persistence_rule: (results["persistence_rule"] as ScorePlan["persistence_rule"]) ?? undefined,
  };
  const entrySide = results["entry_side"] as "long" | "short" | undefined;
  if (entrySide !== undefined) {
    plan.entry_plan = {
      side: entrySide,
      max_units: Number(results["entry_max_units"] ?? 0),
    };
  }
  const stopAction = results["stop_action"] as NonNullable<ScorePlan["stop_plan"]>["action"] | undefined;
  if (stopAction !== undefined) {
    plan.stop_plan = {
      action: stopAction,
      affected_units: String(results["stop_affected_units"] ?? "all") as NonNullable<ScorePlan["stop_plan"]>["affected_units"],
      rationale: String(results["stop_rationale"] ?? ""),
      new_stop: results["stop_new_stop"] === undefined ? undefined : Number(results["stop_new_stop"]),
      event: results["stop_event"] as LadderEvent | undefined,
      trim_fraction: results["stop_trim_fraction"] === undefined
        ? undefined
        : Number(results["stop_trim_fraction"]),
    };
  }
  const trimTarget = results["trim_target_units"] as number | undefined;
  if (trimTarget !== undefined) {
    plan.trim_plan = {
      target_units: Number(trimTarget),
      which: String(results["trim_which"] ?? "oldest") as NonNullable<ScorePlan["trim_plan"]>["which"],
    };
  }
  const sizingNotional = results["sizing_suggested_notional"] as number | undefined;
  if (sizingNotional !== undefined) {
    plan.sizing_plan = {
      suggested_notional: Number(sizingNotional),
      risk_dollars: Number(results["sizing_risk_dollars"] ?? 0),
      stop_distance_pct: Number(results["sizing_stop_distance_pct"] ?? 0),
      stop_price: Number(results["sizing_stop_price"] ?? 0),
      heat_after_trade: Number(results["sizing_heat_after_trade"] ?? 0),
      per_asset_cap_dollars: Number(results["sizing_per_asset_cap_dollars"] ?? 0),
    };
  }
  return plan;
}
