import { test } from "node:test";
import assert from "node:assert/strict";
import { formatPosition, planResults, scorePlanFromResults } from "./directive.js";
const flat = { side: null, units: 0 };
const long = (units) => ({ side: "long", units });
const short = (units) => ({ side: "short", units });
test("formatPosition renders side and unit count", () => {
    assert.equal(formatPosition(flat), "flat");
    assert.equal(formatPosition(long(2)), "long:2");
    assert.equal(formatPosition(short(1)), "short:1");
});
test("stop_plan event and trim_fraction round-trip through results", () => {
    const plan = {
        directive: "HOLD", reason: "banking", size_tier: "full",
        signal_gate: "pass", persistence_gate: "pass",
        trend_gate: "pass", binary_gate: "pass",
        heat_gate: "pass", flipflop_gate: "n/a",
        stop_plan: {
            action: "trail", affected_units: "newest",
            event: "partial", trim_fraction: 0.5,
            rationale: "unrealized R 1.62 reached +1.5R; bank partial and open add window",
        },
    };
    const results = { ...planResults(plan), plan_directive: plan.directive };
    assert.equal(results["stop_event"], "partial");
    assert.equal(results["stop_trim_fraction"], 0.5);
    const back = scorePlanFromResults(results);
    assert.equal(back?.stop_plan?.event, "partial");
    assert.equal(back?.stop_plan?.trim_fraction, 0.5);
});
test("a stop_plan without event or trim_fraction omits both keys", () => {
    const plan = {
        directive: "HOLD", reason: "hold", size_tier: "full",
        signal_gate: "pass", persistence_gate: "pass",
        trend_gate: "pass", binary_gate: "pass",
        heat_gate: "pass", flipflop_gate: "n/a",
        stop_plan: { action: "hold", affected_units: "all", rationale: "no change" },
    };
    const results = { ...planResults(plan), plan_directive: plan.directive };
    assert.ok(!("stop_event" in results), "stop_event must be absent, not undefined");
    assert.ok(!("stop_trim_fraction" in results), "stop_trim_fraction must be absent, not undefined");
    assert.equal(scorePlanFromResults(results)?.stop_plan?.trim_fraction, undefined);
});
