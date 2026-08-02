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

  /** Did the trend/MA hard gate pass for the chosen direction? */
  trend_gate: "pass" | "fail";

  /** Was an extreme-contrarian regime trigger active? */
  regime_trigger?: "none" | "extreme_bull" | "extreme_bear";

  /** Did a persistence/anti-flip-flop rule modify the raw ladder output? */
  persistence_rule?: "fresh_signal" | "maintain";

  /** Direction of a new position, if any. Sizing is out of scope. */
  entry_plan?: {
    side: "long" | "short";
    /** Maximum units this trade may eventually carry (param ceiling). */
    max_units: number;
  };

  /** Recommended stop/exit management for open units. */
  stop_plan?: {
    action: "move_to_breakeven" | "trail" | "tighten" | "hold";
    /** Which units the action targets. */
    affected_units: "all" | "oldest" | "newest" | string;
    rationale: string;
  };

  /** Recommended unit reduction if the ladder calls for TRIM. */
  trim_plan?: {
    target_units: number;
    which: "highest_cost" | "oldest" | "newest" | string;
  };
};

export function formatPlan(plan: ScorePlan): string {
  const parts: string[] = [`${plan.directive} (${plan.reason})`, `trend_gate=${plan.trend_gate}`];
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
  return parts.join(" | ");
}

/** Convert a plan into flat result keys for storage in score_result. */
export function planResults(plan: ScorePlan): Record<string, number | string> {
  const r: Record<string, number | string> = {
    directive_reason: plan.reason,
    trend_gate: plan.trend_gate,
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
  const trend_gate = results["trend_gate"] as "pass" | "fail" | undefined;
  if (trend_gate === undefined) return undefined;
  const plan: ScorePlan = {
    directive,
    reason: String(results["directive_reason"] ?? ""),
    trend_gate,
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
    };
  }
  const trimTarget = results["trim_target_units"] as number | undefined;
  if (trimTarget !== undefined) {
    plan.trim_plan = {
      target_units: Number(trimTarget),
      which: String(results["trim_which"] ?? "oldest") as NonNullable<ScorePlan["trim_plan"]>["which"],
    };
  }
  return plan;
}
