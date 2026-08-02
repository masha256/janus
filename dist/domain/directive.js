export function formatPosition(pos) {
    return pos.side === null ? "flat" : `${pos.side}:${pos.units}`;
}
export function formatPlan(plan) {
    const parts = [`${plan.directive} (${plan.reason})`, `trend_gate=${plan.trend_gate}`];
    if (plan.regime_trigger && plan.regime_trigger !== "none") {
        parts.push(`regime_trigger=${plan.regime_trigger}`);
    }
    if (plan.persistence_rule)
        parts.push(`persistence=${plan.persistence_rule}`);
    if (plan.stop_plan) {
        parts.push(`stop=${plan.stop_plan.action}:${plan.stop_plan.affected_units}`);
    }
    if (plan.trim_plan) {
        parts.push(`trim_to=${plan.trim_plan.target_units}:${plan.trim_plan.which}`);
    }
    return parts.join(" | ");
}
/** Convert a plan into flat result keys for storage in score_result. */
export function planResults(plan) {
    const r = {
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
export function scorePlanFromResults(results) {
    const directive = results["plan_directive"];
    if (directive === undefined)
        return undefined;
    const trend_gate = results["trend_gate"];
    if (trend_gate === undefined)
        return undefined;
    const plan = {
        directive,
        reason: String(results["directive_reason"] ?? ""),
        trend_gate,
        regime_trigger: results["regime_trigger"] ?? "none",
        persistence_rule: results["persistence_rule"] ?? undefined,
    };
    const entrySide = results["entry_side"];
    if (entrySide !== undefined) {
        plan.entry_plan = {
            side: entrySide,
            max_units: Number(results["entry_max_units"] ?? 0),
        };
    }
    const stopAction = results["stop_action"];
    if (stopAction !== undefined) {
        plan.stop_plan = {
            action: stopAction,
            affected_units: String(results["stop_affected_units"] ?? "all"),
            rationale: String(results["stop_rationale"] ?? ""),
        };
    }
    const trimTarget = results["trim_target_units"];
    if (trimTarget !== undefined) {
        plan.trim_plan = {
            target_units: Number(trimTarget),
            which: String(results["trim_which"] ?? "oldest"),
        };
    }
    return plan;
}
