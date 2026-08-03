export function formatPosition(pos) {
    return pos.side === null ? "flat" : `${pos.side}:${pos.units}`;
}
export function formatPlan(plan) {
    const parts = [
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
    if (plan.persistence_rule)
        parts.push(`persistence=${plan.persistence_rule}`);
    if (plan.stop_plan) {
        parts.push(`stop=${plan.stop_plan.action}:${plan.stop_plan.affected_units}`);
    }
    if (plan.trim_plan) {
        parts.push(`trim_to=${plan.trim_plan.target_units}:${plan.trim_plan.which}`);
    }
    if (plan.sizing_plan) {
        parts.push(`size=$${Math.round(plan.sizing_plan.suggested_notional)} risk=$${Math.round(plan.sizing_plan.risk_dollars)}`);
    }
    return parts.join(" | ");
}
/** Convert a plan into flat result keys for storage in score_result. */
export function planResults(plan) {
    const r = {
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
        if (plan.stop_plan.new_stop !== undefined)
            r["stop_new_stop"] = plan.stop_plan.new_stop;
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
export function scorePlanFromResults(results) {
    const directive = results["plan_directive"];
    if (directive === undefined)
        return undefined;
    const size_tier = results["size_tier"];
    if (size_tier === undefined)
        return undefined;
    const plan = {
        directive,
        reason: String(results["directive_reason"] ?? ""),
        size_tier,
        signal_gate: results["signal_gate"] ?? "fail",
        persistence_gate: results["persistence_gate"] ?? "insufficient_history",
        trend_gate: results["trend_gate"] ?? "fail",
        binary_gate: results["binary_gate"] ?? "pass",
        heat_gate: results["heat_gate"] ?? "pass",
        flipflop_gate: results["flipflop_gate"] ?? "n/a",
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
            new_stop: results["stop_new_stop"] === undefined ? undefined : Number(results["stop_new_stop"]),
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
